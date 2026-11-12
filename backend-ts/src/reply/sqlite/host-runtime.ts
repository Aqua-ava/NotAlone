import {SqliteReplyCandidateService} from './candidates/service.ts';
import {SqliteReplyTurns} from './candidates/turns.ts';
import {SqliteReplyCandidateHttp} from './candidates/http.ts';
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {join} from 'node:path';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import type {SqliteSkillLibrary} from '../../skills/sqlite/library.ts';
import type {HostReplyModelConfiguration} from '../../host/host-reply-config.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../platform/models/model-permits.ts';
import {StorageFailure,type StorageReader} from '../../storage/sqlite/contracts.ts';
import {SqliteDiscussionService} from './service.ts';
import {SqliteDiscussionRuntime} from './runtime.ts';
import {SqliteDiscussionTurns} from './turns.ts';
import {SqliteDiscussionHttp} from './http.ts';
import {createBusinessEmbeddingFactory,createLocalEmbeddingLifecycle} from '../../platform/models/local-embedding-lifecycle.ts';

/** 宿主唯一装配点共享模型提供者与许可；讨论只拥有自己的官方运行副本。 */
export async function createSqliteDiscussionHost(options:{
 ctx:Context;storage:SqliteStorage;ownerId:string;userData:string;holders:ActiveHolders;
 reader?:StorageReader;
 /** 项目目录；提供时回复记忆检索使用其 `.models/memory-embedding` 下的本机语义模型（ADR-182），缺省为纯词法。 */
 projectDirectory?:string;
 authorizeRequest:(request:IncomingMessage)=>boolean;library?:SqliteSkillLibrary;
 model?:{configuration:HostReplyModelConfiguration;provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter};
}){
 const service=new SqliteDiscussionService(options.storage,options.ownerId,Date.now,options.reader);
 const runtime=new SqliteDiscussionRuntime(options);
 try{await options.storage.execute('discussion.recover',{ownerId:options.ownerId});await runtime.initialize();}catch(error){await runtime.close().catch(()=>{});throw error;}
 let stopping=false,closing:Promise<void>|undefined;
 const turns=options.model?new SqliteDiscussionTurns({storage:options.storage,discussions:service,runtime,
  model:options.model.configuration,provider:options.model.provider,arbiter:options.model.arbiter,library:options.library,
  authorize:async()=>{if(stopping)throw new StorageFailure('discussion_runtime_closed');},
 }):undefined;
 // 语义模型惰性打开：首次需要时才加载；模型未准备时由回复链路降级为词法。
 const embedding=options.projectDirectory?createLocalEmbeddingLifecycle(createBusinessEmbeddingFactory(options.projectDirectory,join(options.projectDirectory,'.models/memory-embedding'))):undefined;
 const candidates=new SqliteReplyCandidateService(options.storage,options.ownerId,options.reader);
 const candidateTurns=options.model?new SqliteReplyTurns({storage:options.storage,service:candidates,discussions:service,runtime,model:options.model.configuration,provider:options.model.provider,arbiter:options.model.arbiter,library:options.library,...(embedding?{embed:embedding.embed}:{}),authorize:async()=>{if(stopping)throw new StorageFailure('reply_runtime_closed');}}):undefined;
 const candidateHttp=new SqliteReplyCandidateHttp({storage:options.storage,service:candidates,turns:candidateTurns,authorize:options.authorizeRequest});
 const handler=new SqliteDiscussionHttp(service,options.authorizeRequest,turns),requests=new Set<Promise<boolean>>();
 const http={handle(request:IncomingMessage,response:ServerResponse):Promise<boolean>{
  if(stopping){response.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({error:'discussion_runtime_closed'}));return Promise.resolve(true);}
  const pending=(async()=>await candidateHttp.handle(request,response)||await handler.handle(request,response))();requests.add(pending);const release=()=>requests.delete(pending);pending.then(release,release);return pending;
 }};
 return {service,runtime,turns,candidates,candidateTurns,http,
  close():Promise<void>{
   stopping=true;
   return closing??=(async()=>{await options.reader?.close();await Promise.all([turns?.close(),candidateTurns?.close()]);await embedding?.close();await runtime.close();await Promise.allSettled([...requests]);})().catch(error=>{closing=undefined;throw error;});
  },
 };
}
