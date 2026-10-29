import {SqliteReplyCandidateService} from './candidates/service.ts';
import {SqliteReplyTurns} from './candidates/turns.ts';
import {SqliteReplyCandidateHttp} from './candidates/http.ts';
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import type {SqliteSkillLibrary} from '../../skills/sqlite/library.ts';
import type {HostReplyModelConfiguration} from '../../host/host-reply-config.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../platform/models/model-permits.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {SqliteDiscussionService} from './service.ts';
import {SqliteDiscussionRuntime} from './runtime.ts';
import {SqliteDiscussionTurns} from './turns.ts';
import {SqliteDiscussionHttp} from './http.ts';

/** 宿主唯一装配点共享模型提供者与许可；讨论只拥有自己的官方运行副本。 */
export async function createSqliteDiscussionHost(options:{
 ctx:Context;storage:SqliteStorage;ownerId:string;userData:string;holders:ActiveHolders;
 authorizeRequest:(request:IncomingMessage)=>boolean;library?:SqliteSkillLibrary;
 model?:{configuration:HostReplyModelConfiguration;provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter};
}){
 const service=new SqliteDiscussionService(options.storage,options.ownerId);
 const runtime=new SqliteDiscussionRuntime(options);
 try{await options.storage.execute('discussion.recover',{ownerId:options.ownerId});await runtime.initialize();}catch(error){await runtime.close().catch(()=>{});throw error;}
 let stopping=false,closing:Promise<void>|undefined;
 const turns=options.model?new SqliteDiscussionTurns({storage:options.storage,discussions:service,runtime,
  model:options.model.configuration,provider:options.model.provider,arbiter:options.model.arbiter,library:options.library,
  authorize:async()=>{if(stopping)throw new StorageFailure('discussion_runtime_closed');},
 }):undefined;
 const candidates=new SqliteReplyCandidateService(options.storage,options.ownerId);
 const candidateTurns=options.model?new SqliteReplyTurns({storage:options.storage,service:candidates,discussions:service,runtime,model:options.model.configuration,provider:options.model.provider,arbiter:options.model.arbiter,library:options.library,authorize:async()=>{if(stopping)throw new StorageFailure('reply_runtime_closed');}}):undefined;
 const candidateHttp=new SqliteReplyCandidateHttp({storage:options.storage,service:candidates,turns:candidateTurns,authorize:options.authorizeRequest});
 const handler=new SqliteDiscussionHttp(service,options.authorizeRequest,runtime,turns,candidateTurns?(contactId,discussionId)=>candidateTurns.configurationFor(contactId,discussionId):undefined),requests=new Set<Promise<boolean>>();
 const http={handle(request:IncomingMessage,response:ServerResponse):Promise<boolean>{
  if(stopping){response.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({error:'discussion_runtime_closed'}));return Promise.resolve(true);}
  const pending=(async()=>await candidateHttp.handle(request,response)||await handler.handle(request,response))();requests.add(pending);const release=()=>requests.delete(pending);pending.then(release,release);return pending;
 }};
 return {service,runtime,turns,candidates,candidateTurns,http,
  close():Promise<void>{
   stopping=true;
   return closing??=(async()=>{await Promise.all([turns?.close(),candidateTurns?.close()]);await runtime.close();await Promise.allSettled([...requests]);})().catch(error=>{closing=undefined;throw error;});
  },
 };
}
