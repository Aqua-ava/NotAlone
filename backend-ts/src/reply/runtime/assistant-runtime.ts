/** 业务讨论的官方 DSH 运行副本；数据库裁定提交，文件只承担受控恢复。 */
import {Inject,type Context,type Fiber} from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import type {AssistantRuntimePlan,AssistantRuntimePlanReader} from './assistant-runtime-projection.ts';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Sessions,{SessionId,type SessionEvent} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-persistence';
import {SessionPersistenceCorruptionError,SessionPersistenceNotFoundError} from '@deepseek-ai/dsh-session-persistence';
import Tools from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Projections from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
import {isAbsolute,join,basename} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fingerprint} from '../generation/reply-assistant-erasure.ts';
import {digest as eventDigest} from '../../memory/overview/evidence/sources.ts';
import type {Client} from 'pg';
import {ReplyError} from '../generation/reply-contract.ts';
import {ReplyRejected,type VerifiedReplyScope} from '../generation/reply-scope.ts';
import {assistantRuntimeDeletionPending} from './assistant-runtime-erasure.ts';

type Transaction=<T>(work:(client:Client)=>Promise<T>)=>Promise<T>;
type Scope=Pick<VerifiedReplyScope,'owner_id'|'contact_id'>;
type StoredQualification=Omit<AssistantRuntimePlan['qualification'],'version'>&{version:1|2;payload_sha256?:string};
type RuntimeRow={origin:'generated'|'business_bootstrap'|'business_rebuild';qualification:StoredQualification|null;committed_event_sha256:string|null;session_id:string;runtime_session_id:string;configuration_sha256:string;state:'ready'|'dirty'|'blocked';committed_request_id:string|null;committed_event_count:number};
// 正文凭据只证明已构建的伴随文件；每阶段的新鲜资格不能靠重造全文来重算它。
function inspectedQualification(value:StoredQualification|null){if(!value)return null;const {payload_sha256,...qualification}=value;return qualification;}
function retainReferenceProof(qualification:AssistantRuntimePlan['qualification'],previous:StoredQualification|null):StoredQualification{return {...qualification,...(previous?.payload_sha256?{payload_sha256:previous.payload_sha256}:{})};}
export interface AssistantRuntimeMaterialization {
 changed:boolean;
 runtime?:{session_id:string;runtime_session_id:string;origin:RuntimeRow['origin'];state:RuntimeRow['state'];event_count:number;committed_request_id:string|null;qualification_sha256:string|null};
}
function materialization(row:RuntimeRow,changed=false):AssistantRuntimeMaterialization{return {changed,runtime:{session_id:row.session_id,runtime_session_id:row.runtime_session_id,origin:row.origin,state:row.state,event_count:row.committed_event_count,committed_request_id:row.committed_request_id,qualification_sha256:row.qualification?fingerprint(row.qualification):null}};}
export interface AssistantRuntimeHistory {sessionId:SessionId;events:readonly SessionEvent[];qualification_sha256:string;businessReference?:unknown}
export interface AssistantRuntimeLease {
 ctx:Context;sessionId:SessionId;resume:boolean;businessReference?:unknown;
 /** 调用方先释放官方句柄并确认业务提交，再标记可恢复。 */
 commit(expectedEventCount:number,readPlan:AssistantRuntimePlanReader):Promise<void>;
 /** SDK无法确认写句柄关闭时保留占用；重启前不能假定安全删除。 */
 retainWriterFailure():void;
 release():Promise<void>;
}
const validId=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const unavailable=():never=>{throw new ReplyError('reply_context_unavailable',409);};
class RuntimeStorageDiverged extends Error {}
const repairable=(error:unknown)=>error instanceof SessionPersistenceCorruptionError||error instanceof SessionPersistenceNotFoundError||error instanceof RuntimeStorageDiverged||(error as NodeJS.ErrnoException)?.code==='ENOENT';
export function assistantRuntimeConfiguration(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

export class AssistantRuntime {
 private readonly operations=new Set<{scope:Scope;session:string|null;requestKey?:string;controller:AbortController;done:Promise<void>}>();
 private readonly active=new Map<string,{resume:boolean;requestKey:string}>();
 private readonly options:{ctx:Context;transaction:Transaction;home:string;persistent?:boolean};
 constructor(options:{ctx:Context;transaction:Transaction;home:string;persistent?:boolean}){
  this.options=options;
  if(!isAbsolute(options.home))throw new ReplyError('reply_runtime_unavailable',503);
 }
 get persistent():boolean{return this.options.persistent!==false;}
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
 private async runtimeDirectory(directory:string,runtimeId:string):Promise<string>{
  if(!validId(runtimeId))return unavailable();const root=join(directory,runtimeId),status=await lstat(root);
  if(!status.isDirectory()||status.isSymbolicLink()||(status.mode&0o077)!==0||status.uid!==process.getuid?.()||await realpath(root)!==root)return unavailable();return root;
 }
 /** 先核验整个应用副本；未知归属、链接和权限错误不能当成可覆盖的损坏。 */
 private async privateTree(root:string):Promise<void>{
  for(const entry of await readdir(root,{recursive:true})){
   const path=join(root,entry),status=await lstat(path);
   // 官方POSIX锁以默认0644创建，只含锁定inode；正文和目录仍要求私有权限。
   const allowedMode=basename(path)==='session.lock'&&status.isFile()?0o022:0o077;
   if(status.isSymbolicLink()||!status.isFile()&&!status.isDirectory()||(status.mode&allowedMode)!==0||status.uid!==process.getuid?.()||await realpath(path)!==path)return unavailable();
  }
 }
 /** 官方write-open先取得跨进程锁再解码；锁冲突和未知close失败不进入重建。 */
 private async inspect(scope:Scope,row:RuntimeRow,signal:AbortSignal,retainWriterFailure:()=>void,checkReference:boolean):Promise<{usable:boolean;retire:boolean}>{
  let world:Awaited<ReturnType<AssistantRuntime['world']>>|undefined,writerFailed=false;
  try{
   const directory=await this.directory(scope,row.session_id,false);if(!directory)return {usable:false,retire:false};
   const root=await this.runtimeDirectory(directory,row.runtime_session_id);await this.privateTree(root);world=await this.world(root);
   const handle=await world.persistence.open(SessionId(row.runtime_session_id),'write',{signal});
   try{
    const events=(await handle.read(0,undefined,{signal})).events;
    if(row.state!=='ready'||events.length!==row.committed_event_count||!row.committed_event_sha256||eventDigest(events)!==row.committed_event_sha256)return {usable:false,retire:true};
    if(checkReference&&row.committed_request_id===null)await this.readReference(directory,row);
    return {usable:true,retire:true};
   }finally{try{await handle.close();}catch(error){writerFailed=true;retainWriterFailure();throw error;}}
  }catch(error){
   // 官方open会聚合解码失败与锁释放失败；没有返回handle也不能假定释放成功。
   if(error instanceof AggregateError)retainWriterFailure();
   if(signal.aborted||writerFailed||!repairable(error))throw error;
   if(error instanceof SessionPersistenceNotFoundError&&world){
    // 缺档不等于无人写入；用官方create/flush在同一路径取得真实锁，再允许替换。
    const session=world.ctx.sessions.create(SessionId(row.runtime_session_id)),handle=await world.persistence.create(session.header,{signal});
    try{await handle.flush();}finally{try{await handle.close();}catch(closeError){retainWriterFailure();throw closeError;}}
    return {usable:false,retire:true};
   }
   // 目录已缺失时不删除未知旧路径；新实例使用不同路径，删除链仍覆盖整个讨论。
   return {usable:false,retire:error instanceof SessionPersistenceCorruptionError||error instanceof RuntimeStorageDiverged};
  }finally{try{await world?.close();}catch(error){retainWriterFailure();throw error;}}
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
 /** 整轮准备、读档、模型、提交和释放共用一个取消与完成边界。 */
 async run<T>(scope:Scope,requestKey:string,signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController();let finish!:()=>void;
  const operation={scope,session:null as string|null,requestKey,controller,done:new Promise<void>(resolve=>{finish=resolve;})};
  this.operations.add(operation);
  try{
   await this.options.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
    const row=(await client.query('SELECT session_id FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,requestKey])).rows[0];
    operation.session=row?.session_id??null;
    await this.requireAllowed(client,scope,operation.session);
   });
   const combined=AbortSignal.any([signal,controller.signal]);combined.throwIfAborted();return await work(combined);
  }finally{this.operations.delete(operation);finish();}
 }
 /** 尚无运行档案的既有讨论只能明确继续；新段的精确候选携入不冒充旧讨论恢复。 */
 async requireGenerationReady(client:Client,scope:Scope,session:string,excludeRequestKey?:string):Promise<void>{
  if(!this.persistent)return;await this.requireAllowed(client,scope,session);
  const legacy=(await client.query(`SELECT 1 FROM assistant_session session WHERE session.owner_id=$1 AND session.contact_id=$2 AND session.id=$3 AND session.legacy_runtime_pending
   AND NOT EXISTS(SELECT 1 FROM assistant_runtime_session runtime WHERE runtime.owner_id=$1 AND runtime.contact_id=$2 AND runtime.session_id=$3)
   AND EXISTS(SELECT 1 FROM assistant_session_input input LEFT JOIN assistant_session_turn turn ON turn.owner_id=input.owner_id AND turn.contact_id=input.contact_id AND turn.session_id=input.session_id AND turn.id=input.turn_id
    WHERE input.owner_id=$1 AND input.contact_id=$2 AND input.session_id=$3 AND input.state='active'
     AND ($4::uuid IS NULL OR turn.idempotency_key IS DISTINCT FROM $4::uuid))`,[scope.owner_id,scope.contact_id,session,excludeRequestKey??null])).rowCount;
  if(legacy)throw new ReplyRejected('resume_required');
 }
 /** 显式继续和有资格变化的生成共用零模型建档器；06可复用，不自动吞存储故障。 */
 async materialize(scope:Scope,session:string,configuration:string,readPlan:AssistantRuntimePlanReader,signal:AbortSignal,options:{generation?:boolean;requestKey?:string}={}):Promise<AssistantRuntimeMaterialization>{
  if(this.options.persistent===false)return {changed:false};
  const controller=new AbortController();let finish!:()=>void;
  const operation={scope,session,controller,done:new Promise<void>(resolve=>{finish=resolve;})};this.operations.add(operation);
  const combined=AbortSignal.any([signal,controller.signal]),key=this.key(scope,session);
  if(this.active.has(key)||[...this.operations].some(other=>other!==operation&&other.scope.owner_id===scope.owner_id&&other.scope.contact_id===scope.contact_id&&(other.session===null||other.session===session)&&(!options.generation||other.requestKey!==options.requestKey))){this.operations.delete(operation);finish();throw new ReplyError('reply_in_progress',409);}
  this.active.set(key,{resume:false,requestKey:'business_materialize'});
  let world:Awaited<ReturnType<AssistantRuntime['world']>>|undefined,writerFailed=false;
  try{
   const {row,plan}=await this.options.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);await this.requireAllowed(client,scope,session);
    const row=(await client.query('SELECT * FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,session])).rows[0] as RuntimeRow|undefined,plan=await readPlan(client);
    if(plan.session_id!==session||plan.scope.owner_id!==scope.owner_id||plan.scope.contact_id!==scope.contact_id)return unavailable();
    if(row?.state==='blocked')return unavailable();
    // 同一owner锁内完成相邻资格读取；两者之间没有SDK、磁盘操作或业务写入。
    if(row?.state==='ready')await this.requireCommittedRow(client,scope,row);
    if(options.generation&&!row)await this.requireGenerationReady(client,scope,session,options.requestKey);
    return {row,plan};
   });
   if(options.generation&&!row)return {changed:false};
   if(row?.qualification&&(row.qualification.binding_id!==plan.binding_id||row.qualification.scope?.owner_id!==scope.owner_id||row.qualification.scope?.contact_id!==scope.contact_id))return unavailable();
   const storage=row?await this.inspect(scope,row,combined,()=>{writerFailed=true;},row.configuration_sha256===configuration&&isDeepStrictEqual(inspectedQualification(row.qualification),plan.qualification)):{usable:false,retire:false};
   if(storage.usable&&row?.state==='ready'&&row.configuration_sha256===configuration&&isDeepStrictEqual(inspectedQualification(row.qualification),plan.qualification))return materialization(row);
   // 只新增合法背景或新完成业务轮时保留真实SDK历史；材料变化或范围收窄必须换底层实例。
   const contains=(previous:Record<string,string>,current:Record<string,string>)=>Object.entries(previous).every(([key,value])=>current[key]===value);
   if(storage.usable&&row?.state==='ready'&&row.origin==='generated'&&row.qualification&&row.configuration_sha256===configuration
    &&row.qualification.version===plan.qualification.version&&row.qualification.contract===plan.qualification.contract&&isDeepStrictEqual(row.qualification.policy,plan.qualification.policy)&&contains(row.qualification.records,plan.qualification.records)&&contains(row.qualification.inventory,plan.qualification.inventory)){
    const qualification=retainReferenceProof(plan.qualification,row.qualification);
    await this.options.transaction(async client=>{await this.requireAllowed(client,scope,session);if(!isDeepStrictEqual((await readPlan(client)).qualification,plan.qualification))return unavailable();await client.query("UPDATE assistant_runtime_session SET qualification=$5 WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND runtime_session_id=$4 AND state='ready'",[scope.owner_id,scope.contact_id,session,row.runtime_session_id,JSON.stringify(qualification)]);});
    return materialization({...row,qualification},!isDeepStrictEqual(row.qualification.inventory,plan.qualification.inventory));
   }
   const built=await this.options.transaction(async client=>{await this.requireAllowed(client,scope,session);return readPlan(client,true);});
   if(!isDeepStrictEqual(built.qualification,plan.qualification)||built.payload===undefined)return unavailable();
   const qualification={...plan.qualification,payload_sha256:fingerprint(built.payload)};
   combined.throwIfAborted();
   const directory=(await this.directory(scope,session,true))!,runtimeId=randomUUID();
   const origin=row?'business_rebuild':'business_bootstrap';
   await this.options.transaction(async client=>{
    await this.requireAllowed(client,scope,session);
    if(!isDeepStrictEqual((await readPlan(client)).qualification,plan.qualification))return unavailable();
    const claim=row
     ?await client.query(`UPDATE assistant_runtime_session SET runtime_session_id=$4,configuration_sha256=$5,state='dirty',origin=$6,committed_request_id=NULL,committed_event_count=0 WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND runtime_session_id=$7 AND state=$8`,[scope.owner_id,scope.contact_id,session,runtimeId,configuration,origin,row.runtime_session_id,row.state])
     :await client.query(`INSERT INTO assistant_runtime_session(owner_id,contact_id,session_id,runtime_session_id,configuration_sha256,state,origin) VALUES($1,$2,$3,$4,$5,'dirty',$6) ON CONFLICT(owner_id,contact_id,session_id) DO NOTHING`,[scope.owner_id,scope.contact_id,session,runtimeId,configuration,origin]);
    if(claim.rowCount!==1)throw new ReplyError('reply_in_progress',409);
   });
   if(row&&storage.retire){if(!validId(row.runtime_session_id))return unavailable();await rm(join(directory,row.runtime_session_id),{recursive:true,force:true});}
   const root=join(directory,runtimeId);await mkdir(root,{mode:0o700});world=await this.world(root);
   const sdkSession=world.ctx.sessions.create(SessionId(runtimeId)),writer=await world.persistence.create(sdkSession.header,{signal:combined});
   let count:number,eventSha:string;
   try{
    // 参考正文是业务投影伴随文件，不伪造SDK用户消息或执行轮；首次生成才携入一次。
    await writeFile(join(root,'business-reference.json'),JSON.stringify(built.payload),{mode:0o600,flag:'wx'});
    await world.ctx.sessions.flush(sdkSession);await writer.flush();const events=(await writer.read()).events;count=events.length;eventSha=eventDigest(events);
   }finally{try{await writer.close();}catch(error){writerFailed=true;throw error;}}
   combined.throwIfAborted();
   await this.options.transaction(async client=>{
    await this.requireAllowed(client,scope,session);
    if(!isDeepStrictEqual((await readPlan(client)).qualification,plan.qualification))return unavailable();
    const result=await client.query(`UPDATE assistant_runtime_session SET state='ready',qualification=$5,committed_event_count=$6,committed_event_sha256=$7 WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND runtime_session_id=$4 AND state='dirty'`,[scope.owner_id,scope.contact_id,session,runtimeId,JSON.stringify(qualification),count,eventSha]);if(result.rowCount!==1)return unavailable();
   });
   return materialization({session_id:session,runtime_session_id:runtimeId,origin,state:'ready',committed_request_id:null,committed_event_count:count,committed_event_sha256:eventSha,configuration_sha256:configuration,qualification},!!row||Object.keys(plan.qualification.records).length>0);
  }finally{try{await world?.close();}catch(error){writerFailed=true;throw error;}finally{if(!writerFailed)this.active.delete(key);this.operations.delete(operation);finish();}}
 }
 private async readReference(directory:string,row:RuntimeRow):Promise<unknown>{
  const path=join(directory,row.runtime_session_id,'business-reference.json'),status=await lstat(path);
  if(!status.isFile()||status.isSymbolicLink()||(status.mode&0o077)!==0||status.uid!==process.getuid?.()||await realpath(path)!==path)return unavailable();
  const payload=JSON.parse(await readFile(path,'utf8'));if(!row.qualification||fingerprint(payload)!==row.qualification.payload_sha256)return unavailable();return payload;
 }
 /** 当前出站或提交事务重新核验完整旧历史资格，成功结果不跨阶段缓存。 */
 async validate(client:Client,scope:VerifiedReplyScope,requestKey:string,configuration:string,readPlan:AssistantRuntimePlanReader):Promise<void>{
  const row=await this.lookup(client,scope,requestKey,configuration);if(!row||!row.qualification)return;
  const plan=await readPlan(client);if(!isDeepStrictEqual(inspectedQualification(row.qualification),plan.qualification))throw new ReplyError('reply_context_invalidated',409);
 }
 private async requireAllowed(client:Client,scope:Scope,session:string|null):Promise<void>{
  // 来源的owner memory/carry闭包可跨联系人；完成前先保守封禁本人生成，不删除无关档案。
  if(await assistantRuntimeDeletionPending(client,scope,session))throw new ReplyError('reply_deletion_pending',409);
 }
 private async lookup(client:Client,scope:VerifiedReplyScope,requestKey:string,configuration:string):Promise<RuntimeRow|null>{
  const anchor=(await client.query(`SELECT turn.session_id FROM assistant_session_turn turn JOIN assistant_session session ON session.id=turn.session_id AND session.owner_id=turn.owner_id AND session.contact_id=turn.contact_id WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.idempotency_key=$3 AND turn.conversation_binding_id=$4 AND turn.input_payload IS NOT NULL AND turn.state<>'redacted'`,[scope.owner_id,scope.contact_id,requestKey,scope.conversation_binding_id])).rows[0];
  if(!anchor)return null;
  await this.requireAllowed(client,scope,anchor.session_id);
  if(this.options.persistent===false)return null;
  const row=(await client.query('SELECT * FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,anchor.session_id])).rows[0] as RuntimeRow|undefined;
  if(row&&row.configuration_sha256!==configuration)return unavailable();
  if(row?.state==='blocked')return unavailable();
  return row??{session_id:anchor.session_id,runtime_session_id:randomUUID(),configuration_sha256:configuration,origin:'generated',qualification:null,committed_event_sha256:null,state:'dirty',committed_request_id:null,committed_event_count:0};
 }
 /** 只决定是否可使用 SDK 历史；来源及不可变版本仍由原事务守卫逐次复验。 */
 async hasHistory(client:Client,scope:VerifiedReplyScope,requestKey:string,configuration:string):Promise<boolean>{
  const row=await this.lookup(client,scope,requestKey,configuration);if(!row||!row.qualification||!row.committed_request_id&&row.origin==='generated')return false;
  const active=this.active.get(this.key(scope,row.session_id));
  return row.state==='ready'||row.state==='dirty'&&active?.resume===true&&active.requestKey===requestKey;
 }
 async history(scope:VerifiedReplyScope,requestKey:string,configuration:string,signal?:AbortSignal):Promise<AssistantRuntimeHistory|null>{
  let committedRow:RuntimeRow|null=null;
  const row=await this.options.transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
   const current=await this.lookup(client,scope,requestKey,configuration);
   if(current&&!this.active.has(this.key(scope,current.session_id))&&current.state==='ready'&&(current.committed_request_id||current.origin!=='generated')&&current.qualification){
    committedRow=current;await this.requireCommittedRow(client,scope,current);
   }
   return current;
  }).catch(error=>{if(!committedRow)throw error;return this.historyFailure(scope,committedRow,error,signal);});
  if(!row)return null;
  if(this.active.has(this.key(scope,row.session_id)))throw new ReplyError('reply_in_progress',409);
  if(row.state!=='ready'||!row.committed_request_id&&row.origin==='generated')return null;
  if(!row.qualification)return unavailable();
  try{
   const directory=await this.directory(scope,row.session_id,false);if(!directory)return unavailable();
   const world=await this.world(await this.runtimeDirectory(directory,row.runtime_session_id));
   try{
    const handle=await world.persistence.open(SessionId(row.runtime_session_id),'read',{signal});
    try{const history=await handle.read(0,undefined,{signal});if(history.events.length!==row.committed_event_count||!row.committed_event_sha256||eventDigest(history.events)!==row.committed_event_sha256)throw new RuntimeStorageDiverged();return {sessionId:SessionId(row.runtime_session_id),events:history.events,qualification_sha256:fingerprint(row.qualification),...(row.committed_request_id===null?{businessReference:await this.readReference(directory,row)}:{})};}finally{await handle.close();}
   }finally{await world.close();}
  }catch(error){
   return this.historyFailure(scope,row,error,signal);
  }
 }
 private async historyFailure(scope:Scope,row:RuntimeRow,error:unknown,signal?:AbortSignal):Promise<never>{
  if(signal?.aborted)throw error;
  await this.options.transaction(client=>this.quarantine(client,scope,row.session_id,repairable(error)));
  if(error instanceof ReplyError)throw error;
  throw new ReplyError('reply_runtime_unavailable',503);
 }
 private async requireCommittedInTransaction(client:Client,scope:Scope,session:string,requestId:string|null):Promise<void>{
  const valid=(await client.query("SELECT 1 FROM reply_request request JOIN assistant_session_turn turn ON turn.owner_id=request.owner_id AND turn.contact_id=request.contact_id AND turn.idempotency_key=request.idempotency_key WHERE request.id=$1 AND request.owner_id=$2 AND request.contact_id=$3 AND request.state='completed' AND turn.session_id=$4 AND turn.input_payload IS NOT NULL AND turn.state<>'redacted'",[requestId,scope.owner_id,scope.contact_id,session])).rowCount===1;
  if(!valid)return unavailable();
 }
 private async requireCommitted(scope:Scope,row:RuntimeRow):Promise<void>{
  await this.options.transaction(client=>this.requireCommittedRow(client,scope,row));
 }
 private async requireCommittedRow(client:Client,scope:Scope,row:RuntimeRow):Promise<void>{
  await this.requireAllowed(client,scope,row.session_id);if(row.origin!=='generated'&&row.qualification!==null&&row.committed_request_id===null)return;await this.requireCommittedInTransaction(client,scope,row.session_id,row.committed_request_id);
 }
 async acquire(scope:VerifiedReplyScope,requestKey:string,requestId:string,configuration:string,expected?:AssistantRuntimeHistory|null):Promise<AssistantRuntimeLease|null>{
  let row=await this.options.transaction(client=>this.lookup(client,scope,requestKey,configuration));if(!row)return null;
  if(expected===null&&row.state==='ready')return unavailable();
  if(expected&&(row.runtime_session_id!==expected.sessionId||row.committed_event_count!==expected.events.length||fingerprint(row.qualification)!==expected.qualification_sha256))return unavailable();
  const key=this.key(scope,row.session_id);if(this.active.has(key))throw new ReplyError('reply_in_progress',409);
  this.active.set(key,{resume:row.state==='ready'&&(row.committed_request_id!==null||row.origin!=='generated'&&row.qualification!==null),requestKey});
  let world:Awaited<ReturnType<AssistantRuntime['world']>>|undefined;
  try{
   const resume=row.state==='ready'&&(row.committed_request_id!==null||row.origin!=='generated'&&row.qualification!==null);
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
   await mkdir(join(directory,row.runtime_session_id),{mode:0o700,recursive:true});const root=await this.runtimeDirectory(directory,row.runtime_session_id);
   world=await this.world(root);let released=false,writerFailed=false;
   if(expected){const handle=await world.persistence.open(SessionId(row.runtime_session_id),'read');try{const events=(await handle.read()).events;if(events.length!==expected.events.length||eventDigest(events)!==eventDigest(expected.events))return unavailable();}finally{await handle.close();}}
   let businessReference:unknown;if(resume&&row.committed_request_id===null){const handle=await world.persistence.open(SessionId(row.runtime_session_id),'read');try{businessReference=await this.readReference(directory,row);}finally{await handle.close();}}
   return {retainWriterFailure:()=>{writerFailed=true;},ctx:world.ctx,sessionId:SessionId(row.runtime_session_id),resume,businessReference,
    commit:async(expectedEventCount,readPlan)=>{
     if(!Number.isSafeInteger(expectedEventCount)||expectedEventCount<1)return unavailable();
     const handle=await world!.persistence.open(SessionId(row!.runtime_session_id),'write');let eventCount:number,eventSha:string;
     try{await handle.flush();const events=(await handle.read(0)).events;eventCount=events.length;eventSha=eventDigest(events);if(eventCount<expectedEventCount)return unavailable();}finally{try{await handle.close();}catch(error){writerFailed=true;throw error;}}
     await this.options.transaction(async client=>{
     await this.requireAllowed(client,scope,row!.session_id);await this.requireCommittedInTransaction(client,scope,row!.session_id,requestId);
     const plan=await readPlan(client);
     const changed=await client.query("UPDATE assistant_runtime_session SET state='ready',origin='generated',committed_request_id=$4,committed_event_count=$6,qualification=$7,committed_event_sha256=$8 WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND runtime_session_id=$5 AND state='dirty'",[scope.owner_id,scope.contact_id,row!.session_id,requestId,row!.runtime_session_id,eventCount,JSON.stringify(retainReferenceProof(plan.qualification,row!.qualification)),eventSha]);if(changed.rowCount!==1)return unavailable();
    });},
    release:async()=>{if(released)return;released=true;try{await world!.close();}catch(error){writerFailed=true;throw error;}finally{if(!writerFailed)this.active.delete(key);}},
   };
  }catch(error){try{await world?.close();}finally{this.active.delete(key);}throw error;}
 }
 /** 在任何可失败清理之前，按持久操作范围取消并排空；临时轮不依赖会话映射。 */
 async drain(operationId:string):Promise<void>{
  const {operation,targets}=await this.options.transaction(async client=>({
   operation:(await client.query('SELECT * FROM cross_domain_deletion_operation WHERE id=$1',[operationId])).rows[0],
   targets:(await client.query('SELECT * FROM assistant_runtime_deletion_target WHERE operation_id=$1',[operationId])).rows,
  }));
  if(!operation?.owner_id)return;
  const writers=[...this.operations].filter(active=>active.scope.owner_id===operation.owner_id&&(
   ['source','account'].includes(operation.scope_kind)
   ||operation.scope_kind==='contact'&&operation.contact_id===active.scope.contact_id
   ||operation.scope_kind==='discussion'&&operation.contact_id===active.scope.contact_id&&operation.target_id===active.session
   ||targets.some(target=>target.contact_id===active.scope.contact_id&&target.session_id===active.session)));
  for(const writer of writers)writer.controller.abort('scope_deleted');
  await Promise.all(writers.map(writer=>writer.done));
 }
 /** 目标不随业务级联丢失；清盘完成后才允许删除操作验证成功。 */
 async cleanup(operationId:string):Promise<void>{
  await this.drain(operationId);
  const targets=await this.options.transaction(async client=>(await client.query('SELECT * FROM assistant_runtime_deletion_target WHERE operation_id=$1',[operationId])).rows);
  for(const target of targets){
   await this.options.transaction(client=>this.erase(client,target,target.session_id));
   await this.options.transaction(async client=>{await client.query('UPDATE assistant_runtime_deletion_target SET cleaned=true WHERE operation_id=$1 AND owner_id=$2 AND contact_id=$3 AND session_id=$4',[operationId,target.owner_id,target.contact_id,target.session_id]);});
  }
 }
 /** 隔离不合格运行副本；保留业务历史和文件，禁止继续恢复，供明确修复或删除。 */
 async quarantine(client:Client,scope:Scope,session:string,canRebuild=false):Promise<void>{
  const key=this.key(scope,session);if(this.active.has(key))throw new ReplyError('reply_in_progress',409);
  await client.query("UPDATE assistant_runtime_session SET state=$4 WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND state<>'blocked'",[scope.owner_id,scope.contact_id,session,canRebuild?'dirty':'blocked']);
 }
 /** 删除入口只触及已核验归属的应用目录；失败保留数据库映射供重试。 */
 async erase(client:Client,scope:Scope,session:string):Promise<void>{
  const key=this.key(scope,session);if(this.active.has(key))throw new ReplyError('reply_in_progress',409);
  const directory=await this.directory(scope,session,false);if(directory)await rm(directory,{recursive:true,force:false});
  if(await this.directory(scope,session,false)!==null)return unavailable();
  await client.query('DELETE FROM assistant_runtime_session WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3',[scope.owner_id,scope.contact_id,session]);
 }
}
