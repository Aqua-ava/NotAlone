/** 业务讨论的官方 DSH 运行副本；数据库裁定提交，文件只承担受控恢复。 */
import {Inject,type Context,type Fiber} from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Sessions,{SessionId,type SessionEvent} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Projections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import type {Client} from 'pg';
import {ReplyError} from '../generation/reply-contract.ts';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';

type Transaction=<T>(work:(client:Client)=>Promise<T>)=>Promise<T>;
type Scope=Pick<VerifiedReplyScope,'owner_id'|'contact_id'>;
type RuntimeRow={session_id:string;runtime_session_id:string;configuration_sha256:string;state:'ready'|'dirty'|'blocked';committed_request_id:string|null;committed_event_count:number};
export interface AssistantRuntimeHistory {sessionId:SessionId;events:readonly SessionEvent[]}
export interface AssistantRuntimeLease {
 ctx:Context;sessionId:SessionId;resume:boolean;
 /** 调用方先释放官方句柄并确认业务提交，再标记可恢复。 */
 commit(expectedEventCount:number):Promise<void>;
 release():Promise<void>;
}
const validId=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const unavailable=():never=>{throw new ReplyError('reply_context_unavailable',409);};
export function assistantRuntimeConfiguration(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

export class AssistantRuntime {
 private readonly active=new Map<string,{resume:boolean;requestKey:string}>();
 private readonly options:{ctx:Context;transaction:Transaction;home:string};
 constructor(options:{ctx:Context;transaction:Transaction;home:string}){
  this.options=options;
  if(!isAbsolute(options.home))throw new ReplyError('reply_runtime_unavailable',503);
 }
 private key(scope:Scope,session:string){
  if(![scope.owner_id,scope.contact_id,session].every(validId))return unavailable();
  return `${scope.owner_id}/${scope.contact_id}/${session}`;
 }
 private async directory(scope:Scope,session:string,create:boolean):Promise<string|null>{
  const key=this.key(scope,session),root=join(await realpath(this.options.home),'assistant-runtime');
  const parts=[root,join(root,scope.owner_id),join(root,scope.owner_id,scope.contact_id),join(root,key)];
  for(const directory of parts){
   if(create)await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
   let status;try{status=await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
   if(!status.isDirectory()||status.isSymbolicLink()||(status.mode&0o077)!==0||status.uid!==process.getuid?.())return unavailable();
   if(await realpath(directory)!==directory)return unavailable();
  }
  const directory=parts.at(-1)!,identity=JSON.stringify({version:1,owner_id:scope.owner_id,contact_id:scope.contact_id,session_id:session}),marker=join(directory,'ownership.json');
  if(create)await writeFile(marker,identity,{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const status=await lstat(marker);if(!status.isFile()||status.isSymbolicLink()||(status.mode&0o077)!==0||await readFile(marker,'utf8')!==identity)return unavailable();
  return directory;
 }
 private async world(root:string){
  let ctx=this.options.ctx;
  for(const name of ['sessions','agents','sessionProjections','sessionPersistence','agentLoop','systemPrompt','tools'])ctx=ctx.isolate(name);
  const plugins:Fiber[]=[];
  let inheritScope:(()=>void)|undefined;
  try{
   let boundary:Context|undefined;
   const boundaryFiber=ctx.plugin({name:'notalone-assistant-runtime-domain',apply(current:Context){boundary=current;}});
   plugins.push(boundaryFiber);await boundaryFiber.await();ctx=boundary!;
   for(const [plugin,config] of [[Sessions,undefined],[Agents,undefined],[Projections,undefined],[SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false}],[Tools,{mode:'native'}],[JsonlPersistence,{root,compression:'none'}],[AgentLoop,{agents:[]}]] as const){
    const fiber=ctx.plugin(plugin as typeof Sessions,config as never);plugins.push(fiber);await fiber.await();
   }
   const loopFiber=plugins.at(-1)!;
   // 复用官方 loader 的 internal/plugin + Inject.resolve 接缝，补齐隔离 Loop 子作用域的依赖。
   // 只影响这个 Loop 新建的直接子作用域；不修改 SDK、已创建 Fiber 或其他业务域。
   inheritScope=ctx.on('internal/plugin',fiber=>{
    if(fiber.uid===null||fiber.parent.fiber!==loopFiber.ctx.fiber)return;
    Inject.resolve(['sessions','agents','sessionProjections','sessionPersistence','agentLoop','systemPrompt','tools'],fiber.inject);
   });
   let consumer:Context|undefined;
   const consumerFiber=ctx.plugin({name:'notalone-assistant-runtime-consumer',inject:['agents','sessions','sessionPersistence','sessionProjections','llm','tools','systemPrompt'],apply(current:Context){consumer=current;}});
   plugins.push(consumerFiber);await consumerFiber.await();if(!consumer)throw new ReplyError('reply_runtime_unavailable',503);
   return {ctx:consumer,persistence:consumer.sessionPersistence,close:async()=>{inheritScope?.();for(const fiber of [...plugins].reverse())await fiber.dispose();}};
  }catch(error){inheritScope?.();for(const fiber of plugins.reverse())await fiber.dispose();throw error;}
 }
 private async lookup(client:Client,scope:VerifiedReplyScope,requestKey:string,configuration:string):Promise<RuntimeRow|null>{
  const anchor=(await client.query(`SELECT turn.session_id FROM assistant_session_turn turn JOIN assistant_session session ON session.id=turn.session_id AND session.owner_id=turn.owner_id AND session.contact_id=turn.contact_id WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.idempotency_key=$3 AND turn.conversation_binding_id=$4 AND turn.input_payload IS NOT NULL AND turn.state<>'redacted'`,[scope.owner_id,scope.contact_id,requestKey,scope.conversation_binding_id])).rows[0];
  if(!anchor)return null;
  const row=(await client.query('SELECT * FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,anchor.session_id])).rows[0] as RuntimeRow|undefined;
  if(row&&row.configuration_sha256!==configuration)return unavailable();
  if(row?.state==='blocked')return unavailable();
  return row??{session_id:anchor.session_id,runtime_session_id:randomUUID(),configuration_sha256:configuration,state:'dirty',committed_request_id:null,committed_event_count:0};
 }
 /** 只决定是否可使用 SDK 历史；来源及不可变版本仍由原事务守卫逐次复验。 */
 async hasHistory(client:Client,scope:VerifiedReplyScope,requestKey:string,configuration:string):Promise<boolean>{
  const row=await this.lookup(client,scope,requestKey,configuration);if(!row||!row.committed_request_id)return false;
  const active=this.active.get(this.key(scope,row.session_id));
  return row.state==='ready'||row.state==='dirty'&&active?.resume===true&&active.requestKey===requestKey;
 }
 async history(scope:VerifiedReplyScope,requestKey:string,configuration:string):Promise<AssistantRuntimeHistory|null>{
  const row=await this.options.transaction(client=>this.lookup(client,scope,requestKey,configuration));
  if(!row)return null;
  if(this.active.has(this.key(scope,row.session_id)))throw new ReplyError('reply_in_progress',409);
  if(row.state!=='ready'||!row.committed_request_id)return null;
  try{
   await this.requireCommitted(scope,row);
   const directory=await this.directory(scope,row.session_id,false);if(!directory)return unavailable();
   const world=await this.world(join(directory,row.runtime_session_id));
   try{
    const handle=await world.persistence.open(SessionId(row.runtime_session_id),'read');
    try{const history=await handle.read(0);if(history.events.length!==row.committed_event_count)return unavailable();return {sessionId:SessionId(row.runtime_session_id),events:history.events};}finally{await handle.close();}
   }finally{await world.close();}
  }catch(error){
   await this.options.transaction(client=>this.quarantine(client,scope,row.session_id));
   if(error instanceof ReplyError)throw error;
   throw new ReplyError('reply_runtime_unavailable',503);
  }
 }
 private async requireCommitted(scope:Scope,row:RuntimeRow){
  const valid=await this.options.transaction(async client=>(await client.query("SELECT 1 FROM reply_request request JOIN assistant_session_turn turn ON turn.owner_id=request.owner_id AND turn.contact_id=request.contact_id AND turn.idempotency_key=request.idempotency_key WHERE request.id=$1 AND request.owner_id=$2 AND request.contact_id=$3 AND request.state='completed' AND turn.session_id=$4 AND turn.input_payload IS NOT NULL AND turn.state<>'redacted'",[row.committed_request_id,scope.owner_id,scope.contact_id,row.session_id])).rowCount===1);
  if(!valid)return unavailable();
 }
 async acquire(scope:VerifiedReplyScope,requestKey:string,requestId:string,configuration:string):Promise<AssistantRuntimeLease|null>{
  let row=await this.options.transaction(client=>this.lookup(client,scope,requestKey,configuration));if(!row)return null;
  const key=this.key(scope,row.session_id);if(this.active.has(key))throw new ReplyError('reply_in_progress',409);
  this.active.set(key,{resume:row.state==='ready'&&row.committed_request_id!==null,requestKey});
  let world:Awaited<ReturnType<AssistantRuntime['world']>>|undefined;
  try{
   const resume=row.state==='ready'&&row.committed_request_id!==null;
   if(resume)await this.requireCommitted(scope,row);
   const directory=(await this.directory(scope,row.session_id,true))!;
   if(!resume){
    // 未提交轮不能续用；重新生成只按有效业务记录重建，旧文件不作为产品历史。
    const old=(await this.options.transaction(async client=>(await client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,row!.session_id])).rows[0]));
    if(old){if(!validId(old.runtime_session_id))return unavailable();await rm(join(directory,old.runtime_session_id),{recursive:true,force:true});row={...row,runtime_session_id:randomUUID()};}
   }
   await this.options.transaction(async client=>{
    await client.query(`INSERT INTO assistant_runtime_session(owner_id,contact_id,session_id,runtime_session_id,configuration_sha256,state) VALUES($1,$2,$3,$4,$5,'dirty') ON CONFLICT(owner_id,contact_id,session_id) DO UPDATE SET runtime_session_id=EXCLUDED.runtime_session_id,configuration_sha256=EXCLUDED.configuration_sha256,state='dirty'`,[scope.owner_id,scope.contact_id,row!.session_id,row!.runtime_session_id,configuration]);
   });
   const root=join(directory,row.runtime_session_id);await mkdir(root,{mode:0o700,recursive:true});
   const status=await lstat(root);if(!status.isDirectory()||status.isSymbolicLink())return unavailable();
   world=await this.world(root);let released=false;
   return {ctx:world.ctx,sessionId:SessionId(row.runtime_session_id),resume,
    commit:async(expectedEventCount)=>{
     if(!Number.isSafeInteger(expectedEventCount)||expectedEventCount<1)return unavailable();
     const handle=await world!.persistence.open(SessionId(row!.runtime_session_id),'write');let eventCount:number;
     try{await handle.flush();eventCount=(await handle.read(0)).events.length;if(eventCount<expectedEventCount)return unavailable();}finally{await handle.close();}
     await this.options.transaction(async client=>{
     const saved=(await client.query("SELECT 1 FROM reply_request request JOIN assistant_session_turn turn ON turn.owner_id=request.owner_id AND turn.contact_id=request.contact_id AND turn.idempotency_key=request.idempotency_key WHERE request.id=$1 AND request.owner_id=$2 AND request.contact_id=$3 AND request.state='completed' AND turn.session_id=$4 AND turn.input_payload IS NOT NULL AND turn.state<>'redacted'",[requestId,scope.owner_id,scope.contact_id,row!.session_id])).rowCount===1;if(!saved)return unavailable();
     const changed=await client.query("UPDATE assistant_runtime_session SET state='ready',committed_request_id=$4,committed_event_count=$6 WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND runtime_session_id=$5 AND state='dirty'",[scope.owner_id,scope.contact_id,row!.session_id,requestId,row!.runtime_session_id,eventCount]);if(changed.rowCount!==1)return unavailable();
    });},
    release:async()=>{if(released)return;released=true;try{await world!.close();}finally{this.active.delete(key);}},
   };
  }catch(error){try{await world?.close();}finally{this.active.delete(key);}throw error;}
 }
 /** 隔离不合格运行副本；保留业务历史和文件，禁止继续恢复，供明确修复或删除。 */
 async quarantine(client:Client,scope:Scope,session:string):Promise<void>{
  const key=this.key(scope,session);if(this.active.has(key))throw new ReplyError('reply_in_progress',409);
  await client.query("UPDATE assistant_runtime_session SET state='blocked' WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3",[scope.owner_id,scope.contact_id,session]);
 }
 /** 删除入口只触及已核验归属的应用目录；失败保留数据库映射供重试。 */
 async erase(client:Client,scope:Scope,session:string):Promise<void>{
  const key=this.key(scope,session);if(this.active.has(key))throw new ReplyError('reply_in_progress',409);
  const directory=await this.directory(scope,session,false);if(directory)await rm(directory,{recursive:true,force:false});
  await client.query('DELETE FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,session]);
 }
}
