/** 公开助手生成生命周期；模型、预算和最终候选仍由既有回复服务承担。 */
import type {ReplyHttpService} from '../generation/reply-http.ts';
import {parseReplyRequest,replyUuid,ReplyError,record} from '../generation/reply-contract.ts';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import {AssistantDiscussionService} from './assistant-discussion-service.ts';
import {AssistantGenerationStore,AssistantGenerationError,generationReceipt,type AssistantGenerationStoreOptions,type GenerationRow} from './assistant-generation-store.ts';
import type {AuthenticatedContinuation} from '../generation/reply-assistant-guards.ts';
import type {ReplyRequestInput} from '../generation/reply-contract.ts';
import {parseAssistantContinuation,reserveAssistantContinuation,AssistantContinuationClarification} from './assistant-generation-continuation.ts';
import {AssistantGenerationJobs} from './assistant-generation-jobs.ts';
import {checkGenerationFormat} from './assistant-generation-format.ts';
import {interruptAssistantGeneration} from './assistant-generation-interruption.ts';
import {parseAssistantGeneration,reserveAssistantAdoption} from './assistant-generation-adoption.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
import type {ExplorationHttpService} from '../exploration/exploration-http.ts';
import {handleAssistantExplorationGeneration} from './assistant-generation-explored.ts';
import {ExplorationError} from '../exploration/exploration-contract.ts';
export {AssistantGenerationError} from './assistant-generation-store.ts';
export interface AssistantGenerationLifecycleOptions extends AssistantGenerationStoreOptions {
 environment?:NodeJS.ProcessEnv;replyService:ReplyHttpService;
 runInScope?:<T>(scope:VerifiedReplyScope,work:()=>Promise<T>)=>Promise<T>;
 onEvent?:(event:{owner_id:string;contact_id:string;session_id:string;type:string})=>void|Promise<void>;
}
export interface AssistantGenerationResponse {status:number;payload:unknown}
export interface AssistantGenerationHandleInput {method:string;path:string;body:unknown;scope:VerifiedReplyScope;signal:AbortSignal;respondAsync?:boolean}
function exact(value:unknown,required:string[],optional:string[]=[]):value is GenerationRow{return record(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));}
const invalid=():never=>{throw new AssistantGenerationError('assistant_session_request_invalid',undefined,400);};
function replyFailure(error:ReplyError,action:string):AssistantGenerationResponse{
 const names:Record<string,string>={reply_request_invalid:action==='continue'?'assistant_continuation_request_invalid':'assistant_session_request_invalid',reply_in_progress:'assistant_session_in_progress',reply_input_conflict:'assistant_session_input_conflict',reply_persistence_unavailable:'assistant_session_save_failed',reply_rejected:'assistant_session_rejected',reply_remote_unavailable:'reply_unavailable'};
 const reason='reason'in error&&typeof error.reason==='string'?error.reason:undefined;
 return {status:error.status,payload:{error:names[error.code]??error.code,...(reason?{reason}:{}),...('input_budget'in error?{input_budget:error.input_budget}:{}),...(error instanceof AssistantGenerationError&&error.no_generation?{no_generation:error.no_generation}:{})}};
}
function preparationFingerprint(body:unknown):unknown{
 const {input,adoption}=parseAssistantGeneration(body),c=input.content;
 const fields=c.type==='rewrite_draft'?['type','draft_text','user_instruction','include_relationship_context','input_kind','pasted_direction','workspace_action','context_text','excluded_message_ids']:['type',c.type==='reply_to_message'?'direction':'purpose',c.type==='reply_to_message'?'direction_source':'purpose_source',...(c.type==='reply_to_message'?['target_message_id']:[]),'understanding_correction','user_instruction','clarification_answer'];
 // 对齐原dataclass/asdict默认字段；普通声明保留原字符串，采用命令额外保留完整submission。
 return {...input,content:Object.fromEntries(fields.map(key=>[key,c[key]??null])),expected_input_version_id:input.expected_input_version_id??null,...(adoption?{adopt_new_message_id:adoption.message,submission:adoption.submission}:{})};
}
export class AssistantGenerationLifecycle {
 private readonly options:AssistantGenerationLifecycleOptions;
 private readonly store:AssistantGenerationStore;
 private readonly discussion:AssistantDiscussionService;
 private stopping=false;
 private readonly pending=new Set<Promise<unknown>>();
 private readonly generating=new Set<string>();
 private readonly jobs=new AssistantGenerationJobs();
 private readonly stoppingController=new AbortController();
 constructor(options:AssistantGenerationLifecycleOptions){this.options=options;this.store=new AssistantGenerationStore(options);this.discussion=new AssistantDiscussionService(options);}
 private async requireFormat(scope:VerifiedReplyScope,session:string,key:string,signal:AbortSignal){const checked=await this.store.transaction(scope,client=>checkGenerationFormat(this.store,client,scope,session,key),signal);if(checked&&checked.format_status!=='compatible')throw new AssistantGenerationError('assistant_session_rejected',`prepared_context_${checked.format_status}`);}
 async prepare(scope:VerifiedReplyScope,sessionId:string,body:unknown,signal:AbortSignal){
  const {input,adoption}=parseAssistantGeneration(body);await this.requireFormat(scope,sessionId,input.idempotency_key,signal);const reserved=await this.store.prepareReservation(scope,sessionId,input.idempotency_key,async client=>adoption?reserveAssistantAdoption(this.store,client,scope,sessionId,adoption):{row:await this.store.reserve(client,scope,sessionId,input),input},signal);
  return this.execute(scope,sessionId,reserved,signal,true);
 }
 async generate(scope:VerifiedReplyScope,sessionId:string,body:unknown,signal:AbortSignal){
  const {input,adoption}=parseAssistantGeneration(body);await this.requireFormat(scope,sessionId,input.idempotency_key,signal);const reserved=await this.store.transaction(scope,async client=>adoption?reserveAssistantAdoption(this.store,client,scope,sessionId,adoption):{row:await this.store.reserve(client,scope,sessionId,input),input},signal);
  return this.execute(scope,sessionId,reserved,signal,false);
 }
 private async execute(scope:VerifiedReplyScope,sessionId:string,reserved:{row:GenerationRow;input:ReplyRequestInput;auth?:AuthenticatedContinuation},signal:AbortSignal,prepare:boolean){
  const {row,input,auth}=reserved;
  const key=`${scope.owner_id}:${scope.contact_id}:${input.idempotency_key}`;
  if(!prepare){if(this.generating.has(key))throw new ReplyError('reply_in_progress',409);this.generating.add(key);}
  try{
   if(!prepare){const active=await this.store.transaction(scope,async client=>(await client.query("SELECT 1 FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 AND state='running' AND lease_expires_at>clock_timestamp()",[scope.owner_id,scope.contact_id,input.idempotency_key])).rowCount,signal);if(active)throw new ReplyError('reply_in_progress',409);}
   const result=await this.options.replyService[prepare?'prepare':'generate'](scope,input,signal,auth?{authenticatedContinuation:auth}:{});signal.throwIfAborted();
   if(prepare)return generationReceipt(row);
   await this.store.complete(scope,sessionId,row,result,signal);const session=await this.discussion.readSession(scope,sessionId);return session.turns.find((turn:GenerationRow)=>turn.turn_id===row.id);
  }catch(error){if((error as {code?:string}).code!=='reply_in_progress')await this.store.fail(scope,row);throw error;}finally{if(!prepare)this.generating.delete(key);}
 }
 async replace(scope:VerifiedReplyScope,session:string,body:unknown,signal:AbortSignal,prepare=false){
  if(!exact(body,['running_request_key','replacement']))return invalid();
  const key=replyUuid(body.running_request_key),{input,adoption}=parseAssistantGeneration(body.replacement);if(key===input.idempotency_key)return invalid();await this.requireFormat(scope,session,input.idempotency_key,signal);
  const reserve=async(client:import('pg').Client)=>adoption?reserveAssistantAdoption(this.store,client,scope,session,adoption,key):{row:await this.store.reserve(client,scope,session,input,{runningKey:key}),input};
  const reserved=prepare?await this.store.prepareReservation(scope,session,input.idempotency_key,reserve,signal):await this.store.transaction(scope,reserve,signal);
  return this.execute(scope,session,reserved,signal,prepare);
 }
 async retryInterrupted(scope:VerifiedReplyScope,session:string,body:unknown,signal:AbortSignal,prepare=false){
  if(!exact(body,['original_turn_id','original_input_version_id','request_key']))return invalid();
  const command=Object.fromEntries(Object.entries(body).map(([key,value])=>[key,replyUuid(value)]));
  await this.requireFormat(scope,session,command.request_key,signal);
  const reserve=(client:import('pg').Client)=>this.store.retry(client,scope,session,command);
  const reserved=prepare?await this.store.prepareReservation(scope,session,command.request_key,reserve,signal):await this.store.transaction(scope,reserve,signal);
  return this.execute(scope,session,reserved,signal,prepare);
 }
 async continue(scope:VerifiedReplyScope,session:string,body:unknown,signal:AbortSignal,prepare=false){
  const command=parseAssistantContinuation(body),reserve=(client:import('pg').Client)=>reserveAssistantContinuation(this.store,client,scope,session,command);
  await this.requireFormat(scope,session,command.idempotency_key,signal);
  const reserved=prepare?await this.store.prepareReservation(scope,session,command.idempotency_key,reserve,signal):await this.store.transaction(scope,reserve,signal);
  const result=await this.execute(scope,session,reserved,signal,prepare);
  return prepare?result:{...result,continuation:reserved.auth!.continuation,effective_input:reserved.row.input_payload.content,effective_scene:reserved.row.input_payload.scene??null};
 }
 async handle(input:AssistantGenerationHandleInput):Promise<AssistantGenerationResponse|null>{
  const parts=new URL(input.path,'http://localhost').pathname.split('/').filter(Boolean);
  const jobPath=parts.length===9&&parts[7]==='status'&&parts[6]==='prepare'&&['replies','replace','retry-interrupted'].includes(parts[5]);
  if(jobPath&&parts[0]==='api'&&parts[1]==='contacts'&&parts[3]==='assistant-sessions'){
   if(!['GET','DELETE'].includes(input.method))return {status:405,payload:{error:'method_not_allowed'}};
   try{if(replyUuid(parts[2])!==input.scope.contact_id)return {status:404,payload:{error:'not_found'}};replyUuid(parts[4]);return this.jobs.status(input.scope,'/'+parts.slice(0,7).join('/'),replyUuid(parts[8]),input.method==='DELETE');}catch{return {status:404,payload:{error:'not_found'}};}
  }
  if(parts.length!==6&&parts.length!==7||parts[0]!=='api'||parts[1]!=='contacts'||parts[3]!=='assistant-sessions'||!['replies','replace','retry-interrupted','continue','interrupt','preparation-format'].includes(parts[5])||parts.length===7&&(parts[6]!=='prepare'||['interrupt','preparation-format'].includes(parts[5])))return null;
  if(input.method!=='POST')return {status:405,payload:{error:'method_not_allowed'}};
  if(this.stopping)return {status:503,payload:{error:'runtime_stopping'}};
  const operation=(async()=>{try{
   const contact=replyUuid(parts[2]),session=replyUuid(parts[4]);if(contact!==input.scope.contact_id)throw new AssistantGenerationError('assistant_session_request_invalid',undefined,400);
   if(input.respondAsync&&parts.length===7&&parts[5]!=='continue'){
    let key:string;
    if(parts[5]==='retry-interrupted'){if(!exact(input.body,['original_turn_id','original_input_version_id','request_key']))return invalid();key=replyUuid(input.body.request_key);replyUuid(input.body.original_turn_id);replyUuid(input.body.original_input_version_id);}
    else if(parts[5]==='replace'){if(!exact(input.body,['running_request_key','replacement']))return invalid();replyUuid(input.body.running_request_key);key=parseAssistantGeneration(input.body.replacement).input.idempotency_key;}
    else key=parseAssistantGeneration(input.body).input.idempotency_key;
    const body=structuredClone(input.body),fingerprint=parts[5]==='retry-interrupted'?Object.fromEntries(Object.entries(body as GenerationRow).map(([key,value])=>[key,replyUuid(value)])):parts[5]==='replace'?{running_request_key:replyUuid((body as GenerationRow).running_request_key),replacement:preparationFingerprint((body as GenerationRow).replacement)}:preparationFingerprint(body);
    return this.jobs.start(input.scope,'/'+parts.join('/'),key,fingerprint,async signal=>{
     const run=async()=>(await this.handle({...input,body,signal,respondAsync:false}))!;return this.options.runInScope?this.options.runInScope(input.scope,run):run();
    });
   }
   const signal=AbortSignal.any([input.signal,this.stoppingController.signal]);
   let payload:unknown;
   if(parts[5]==='replace')payload=await this.replace(input.scope,session,input.body,signal,parts.length===7);
   else if(parts[5]==='retry-interrupted')payload=await this.retryInterrupted(input.scope,session,input.body,signal,parts.length===7);
   else if(parts[5]==='continue')payload=await this.continue(input.scope,session,input.body,signal,parts.length===7);
   else if(parts[5]==='preparation-format'){
    const body=input.body;if(!exact(body,['request_key','input_version_id']))return invalid();const key=replyUuid(body.request_key),version=replyUuid(body.input_version_id);payload=await this.store.transaction(input.scope,client=>checkGenerationFormat(this.store,client,input.scope,session,key,version),signal);if(!payload)throw new AssistantGenerationError('not_found',undefined,404);
   }
   else if(parts[5]==='interrupt'){
    const body=input.body;if(!exact(body,['request_key','input_version_id'],['reason']))return invalid();const reason=body.reason??'app_quit';if(!['app_quit','configuration_reload','user_cancelled'].includes(reason))return invalid();
    const key=replyUuid(body.request_key),version=replyUuid(body.input_version_id);payload=await this.store.transaction(input.scope,client=>interruptAssistantGeneration(this.store,client,input.scope,session,key,version,reason),signal);
   }else payload=parts.length===7?await this.prepare(input.scope,session,input.body,signal):await this.generate(input.scope,session,input.body,signal);
   return {status:200,payload};
  }catch(error){if(error instanceof AssistantContinuationClarification)return {status:409,payload:error.payload()};if(error instanceof ReplyStoreError)return {status:409,payload:{error:'assistant_session_rejected',reason:error.code==='reply_input_conflict'?'input_version_stale':'source_unavailable'}};if(error instanceof ReplyError)return replyFailure(error,parts[5]);return {status:503,payload:{error:'assistant_session_save_failed'}};}})();
  this.pending.add(operation);try{return await operation;}finally{this.pending.delete(operation);}
 }
 async handleExploration(input:AssistantGenerationHandleInput,exploration:ExplorationHttpService):Promise<AssistantGenerationResponse|null>{
  if(this.stopping)return {status:503,payload:{error:'runtime_stopping'}};
  const operation=(async()=>{try{return await handleAssistantExplorationGeneration(this,this.store,{...input,signal:AbortSignal.any([input.signal,this.stoppingController.signal])},exploration);}catch(error){
   if(error instanceof ExplorationError||error instanceof ReplyStoreError||error instanceof AssistantGenerationError&&error.code==='assistant_session_rejected')return {status:409,payload:{error:'exploration_rejected'}};
   if(error instanceof ReplyError){if(error.code==='exploration_request_invalid'||error.code==='reply_request_invalid')return {status:400,payload:{error:'exploration_request_invalid'}};if('input_budget'in error)return {status:409,payload:{error:'exploration_rejected',input_budget:error.input_budget}};if(error.code==='provider_context_limit')return {status:409,payload:{error:error.code}};}
   return {status:503,payload:{error:'exploration_failed'}};
  }})();
  this.pending.add(operation);try{return await operation;}finally{this.pending.delete(operation);}
 }
 async recover(ownerId:string):Promise<void>{
  replyUuid(ownerId);
  if(this.pending.size)throw new AssistantGenerationError('assistant_session_in_progress');
  await this.store.transaction({owner_id:ownerId,contact_id:ownerId},async client=>{
   const rows=(await client.query("SELECT t.*,r.state AS request_state,r.lease_expires_at,coalesce(m.id IS NOT NULL,false) AS manual FROM assistant_session_turn t LEFT JOIN reply_request r ON r.owner_id=t.owner_id AND r.contact_id=t.contact_id AND r.idempotency_key=t.idempotency_key LEFT JOIN manual_contact_confirmation m ON m.owner_id=t.owner_id AND m.contact_id=t.contact_id AND m.id=t.conversation_binding_id WHERE t.owner_id=$1 AND t.state='running' ORDER BY t.created_at,t.id FOR UPDATE OF t",[ownerId])).rows;
   for(const row of rows){
    // 宿主应先取得本业务唯一责任；仍有运行租约时不凭进程重启猜测安全终态。
    if(row.request_state==='running')throw new AssistantGenerationError('assistant_generation_recovery_unconfirmed',undefined,503);
    const scope:VerifiedReplyScope={owner_id:ownerId,contact_id:row.contact_id,conversation_binding_id:row.conversation_binding_id,confirmation:row.manual?'manual':'desktop'};
    await interruptAssistantGeneration(this.store,client,scope,row.session_id,row.idempotency_key,row.input_version_id,'app_quit');
   }
  });
 }
 async drain(_reason:'runtime_stopping'='runtime_stopping'):Promise<void>{this.stopping=true;this.stoppingController.abort('runtime_stopping');await this.jobs.drain();await Promise.allSettled([...this.pending]);}
}
