import {assistantNow,recordAssistantUserActivity,type AssistantClock} from '../discussion/assistant-user-activity.ts';
/** generation 的唯一事务写者；沿用原 A 输入、失效键与回复来源守卫。 */
import {createHash} from 'node:crypto';
import type {Client} from 'pg';
import {parseReplyRequest,normalizeReplyInput,record,ReplyError,type ReplyRequestInput} from '../generation/reply-contract.ts';
import {requireReplyScope,type VerifiedReplyScope} from '../generation/reply-scope.ts';
import {SkillFiles} from '../../skills/skill-files.ts';
import {createReplySkillGuards} from '../generation/reply-skill-guards.ts';
import {createReplyAssistantGuards} from '../generation/reply-assistant-factory.ts';
import {canonical,inputRows,generationDependencies,carryEdges} from '../generation/reply-assistant-erasure.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
import type {AuthenticatedContinuation,ReplyAssistantPorts} from '../generation/reply-assistant-guards.ts';
import {prepareExploredGeneration,generationExplorationStore} from './assistant-generation-explored.ts';
import {interruptAssistantGeneration} from './assistant-generation-interruption.ts';
import {ExplorationError} from '../exploration/exploration-contract.ts';

export type GenerationRow=Record<string,any>;
/** 匹配真实受理会话或原请求别名；范围、输入与来源资格仍由各入口核验。 */
export function matchesGenerationSession(row:GenerationRow,sessionId:string):boolean{
 return row.session_id===sessionId||row.requested_session_id===sessionId;
}
export interface AssistantGenerationReceipt {session_id:string;turn_id:string;request_key:string;input_version_id:string;state:string;previous_session_id?:string;interruption_reason?:string|null}
export interface AssistantGenerationStoreOptions {transaction<T>(work:(client:Client)=>Promise<T>):Promise<T>;skillsRoot:string;assistantClock?:AssistantClock;requireSessionReady?:(client:Client,scope:VerifiedReplyScope,session:string,excludeRequestKey?:string)=>Promise<void>;resolveBinding?:ReplyAssistantPorts['requireActiveBinding']}
export class AssistantGenerationError extends ReplyError {
 readonly reason?:string;
 no_generation?:{contact_id:string;session_id:string;request_key:string;state:'not_reserved'};
 constructor(code='assistant_session_rejected',reason?:string,status=409){super(code,status);this.reason=reason;}
}
export const generationReject=(reason:string):never=>{throw new AssistantGenerationError('assistant_session_rejected',reason);};
export const generationReceipt=(row:GenerationRow):AssistantGenerationReceipt=>({session_id:row.session_id,turn_id:row.id,request_key:row.idempotency_key,input_version_id:row.input_version_id,state:row.state,...(row.requested_session_id&&row.requested_session_id!==row.session_id?{previous_session_id:row.requested_session_id}:{})});
export function generationPayload(input:ReplyRequestInput,auth?:AuthenticatedContinuation):GenerationRow {
 const normalized=JSON.parse(normalizeReplyInput({...input,suggestion:null}));
 const {mode,continued_from_candidate_id,skill,scene,allow_incomplete_history,history_coverage_warning,...content}=normalized;
 if(input.suggestion)content.suggestion=input.suggestion;
 return {content:{...content,type:mode},continued_from_candidate_id,skill_version_id:skill.startsWith('user_choice:')?skill.slice(12):null,skill_disabled:skill==='disabled',...(scene===undefined?{}:{scene}),...(allow_incomplete_history?{allow_incomplete_history,history_coverage_warning}:{}),...(auth?{continuation:auth.continuation}:{})};
}
export function generationRequest(scope:VerifiedReplyScope,key:string,payload:GenerationRow,auth?:AuthenticatedContinuation):ReplyRequestInput {
 if(!record(payload)||!record(payload.content))return generationReject('source_deleted');
 const content={...payload.content},suggestion=content.suggestion??null;delete content.suggestion;
 return parseReplyRequest({contact_id:scope.contact_id,idempotency_key:key,content,continued_from_candidate_id:payload.continued_from_candidate_id,skill_version_id:payload.skill_version_id,skill_disabled:payload.skill_disabled,scene:payload.scene??null,allow_incomplete_history:payload.allow_incomplete_history??false,suggestion},auth);
}
const unique=(ids:Iterable<string>):string[]=>[...new Set(ids)].sort();
export class AssistantGenerationStore {
 readonly options:AssistantGenerationStoreOptions;
 readonly guards:ReturnType<typeof createReplyAssistantGuards>;
 constructor(options:AssistantGenerationStoreOptions){
  this.options=options;
  this.guards=createReplyAssistantGuards(createReplySkillGuards({files:new SkillFiles(options.skillsRoot)}),async(client,scope)=>{
   if(options.resolveBinding)return options.resolveBinding(client,scope);
   const rows=(await client.query("SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",[scope.owner_id,scope.contact_id])).rows;
   if(rows.length===1)return rows[0].id;
   if(rows.length)generationReject('binding_ambiguous');
   const manual=(await client.query('SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2',[scope.owner_id,scope.contact_id])).rows;
   if(manual.length!==1)generationReject('no_active_binding');return manual[0].id;
  });
 }
 async transaction<T>(scope:Pick<VerifiedReplyScope,'owner_id'|'contact_id'>,work:(client:Client)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  let businessFailure:unknown;
  try{return await this.options.transaction(async client=>{
   try{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);signal?.throwIfAborted();const result=await work(client);signal?.throwIfAborted();return result;}catch(error){businessFailure=error;throw error;}
  });}catch(error){throw businessFailure??error;}
 }
 async session(client:Client,scope:VerifiedReplyScope,id:string):Promise<GenerationRow>{
  const row=(await client.query('SELECT * FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE',[scope.owner_id,scope.contact_id,id])).rows[0];
  if(!row)throw new AssistantGenerationError('not_found',undefined,404);return row;
 }
 async current(client:Client,scope:VerifiedReplyScope,sessionId:string,inputId:string):Promise<string[]>{
  const session=await this.session(client,scope,sessionId);
  if(session.current_input_version_id!==inputId)generationReject('input_version_stale');
  const row=(await inputRows(client,scope.owner_id,scope.contact_id,sessionId)).find(row=>row.id===inputId);
  if(!row||row.state!=='active')generationReject(row?.state==='redacted'?'source_deleted':'source_unavailable');
  if(row!.conversation_binding_id!==scope.conversation_binding_id)generationReject('binding_changed');
  const deps=new Set<string>(row!.input_type==='generation'?row!.turn_dependencies:row!.dependency_ids);
  if(row!.input_type==='generation'){
   if(!['running','failed','completed'].includes(row!.turn_state)||!row!.input_payload)generationReject('source_unavailable');
   if(row!.turn_state==='completed'&&!row!.reply_request_id)generationReject('source_unavailable');
   for(const id of await generationDependencies(client,scope.owner_id,scope.contact_id,row!))deps.add(id);
   if(row!.reply_request_id){await this.guards.ports.requireReplySourcesCurrent(client,scope,row!.reply_request_id,true);await this.guards.ports.requireSavedSkillPolicy(client,scope,row!.reply_request_id);}
  }else if(row!.input_type==='candidate_carry'){
   if(!(await carryEdges(client,scope.owner_id,row!.id)).some(edge=>edge.child===row!.id))generationReject('source_unavailable');
   const origin=row!.content,turn=(await client.query("SELECT dependency_ids FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4 AND input_version_id=$5 AND reply_request_id=$6 AND conversation_binding_id=$7 AND state='completed'",[scope.owner_id,scope.contact_id,origin.origin_session_id,origin.origin_turn_id,origin.origin_input_version_id,origin.origin_reply_request_id,scope.conversation_binding_id])).rows[0];
   if(!turn)generationReject('source_unavailable');await this.guards.ports.requireSavedSkillPolicy(client,scope,origin.origin_reply_request_id);
   const inherited=unique([...turn.dependency_ids,...await this.guards.ports.requireReplySourcesCurrent(client,scope,origin.origin_reply_request_id,true),...await generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:origin.origin_reply_request_id})]);
   await this.guards.ports.requireGenerationMemoryDependencies(client,scope,inherited);
   if(canonical(await this.guards.assistant.verifiedDiscussionDependencies(client,scope,inherited,true))!==canonical(unique(row!.dependency_ids)))generationReject('source_unavailable');
  }
  await this.guards.assistant.verifiedDiscussionDependencies(client,scope,unique(deps),row!.input_type==='generation');
  await this.guards.ports.requireGenerationMemoryDependencies(client,scope,unique(deps));return unique(deps);
 }
 async existing(client:Client,scope:VerifiedReplyScope,key:string):Promise<GenerationRow|undefined>{return (await client.query('SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE',[scope.owner_id,scope.contact_id,key])).rows[0];}
 async prepareReservation<T>(scope:VerifiedReplyScope,session:string,key:string,work:(client:Client)=>Promise<T>,signal:AbortSignal):Promise<T>{
  const result=await this.transaction(scope,async client=>{
   await client.query('SAVEPOINT assistant_generation_reservation');
   try{const result=await work(client);await client.query('RELEASE SAVEPOINT assistant_generation_reservation');return result;}
   catch(originalError){
    await client.query('ROLLBACK TO SAVEPOINT assistant_generation_reservation');
    const error=originalError instanceof ReplyStoreError?new AssistantGenerationError('assistant_session_rejected','source_unavailable'):originalError instanceof ExplorationError?new AssistantGenerationError('assistant_session_rejected','exploration_stale'):originalError instanceof ReplyError&&originalError.code==='reply_rejected'?new AssistantGenerationError('assistant_session_rejected',(originalError as ReplyError&{reason?:string}).reason):originalError;
    if(!(error instanceof AssistantGenerationError))throw error;
    const contact=(await client.query('SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rowCount;
    const reserved=(await client.query('SELECT 1 FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 UNION ALL SELECT 1 FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,key])).rowCount;
    if(!contact||reserved)throw error;
    if(error.reason!=='resume_required')await client.query('INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[scope.owner_id,scope.contact_id,key]);
    error.no_generation={contact_id:scope.contact_id,session_id:session,request_key:key,state:'not_reserved'};return error;
   }
  },signal);
  if(result instanceof AssistantGenerationError)throw result;return result;
 }
 async reserve(client:Client,scope:VerifiedReplyScope,sessionId:string,input:ReplyRequestInput,options:{auth?:AuthenticatedContinuation;dependencies?:string[];runningKey?:string}={}):Promise<GenerationRow>{
  let session=await this.session(client,scope,sessionId);const requestedSessionId=sessionId;await requireReplyScope(client,scope,input);
  const normalized=normalizeReplyInput(input),identity=options.auth?canonical({reply:normalized,continuation:options.auth.continuation}):normalized;
  const digest=createHash('sha256').update(scope.conversation_binding_id+':'+identity).digest('hex');
  const existing=await this.existing(client,scope,input.idempotency_key);
  if(existing){
   if(existing.state==='redacted'||!existing.input_payload)generationReject('source_deleted');
   if(!matchesGenerationSession(existing,sessionId)||existing.input_digest!==digest)throw new AssistantGenerationError('assistant_session_input_conflict');
   if(existing.interruption_reason!==null)generationReject('generation_interrupted');
  }
  if((await client.query('SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,input.idempotency_key])).rowCount)generationReject('request_deleted');
  if(existing){
   if(existing.state!=='completed')await this.options.requireSessionReady?.(client,scope,existing.session_id,existing.state==='running'?input.idempotency_key:undefined);
   await this.guards.assistant.prepareAssistantReplyStart(client,{...scope,idempotency_key:input.idempotency_key,normalized_input:normalized,continued_from_candidate_id:input.continued_from_candidate_id},options.auth);
   await this.guards.assistant.verifiedDiscussionDependencies(client,scope,existing.dependency_ids,true);
   await this.guards.ports.requireGenerationMemoryDependencies(client,scope,existing.dependency_ids);
   const request=(await client.query('SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,input.idempotency_key])).rows[0];
   if(request?.state==='completed'){if(request.normalized_input!==normalized)throw new AssistantGenerationError('assistant_session_input_conflict');await this.guards.ports.requireReplySourcesCurrent(client,scope,request.id,true);await this.guards.ports.requireSavedSkillPolicy(client,scope,request.id);}
   return existing;
  }
  if((await client.query('SELECT 1 FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,input.idempotency_key])).rowCount)throw new AssistantGenerationError('assistant_session_input_conflict');
  // 空闲只在新任务受理时裁定；同键重放已经在上方返回原决定。
  if(input.expected_input_version_id!==undefined&&session.current_input_version_id!==input.expected_input_version_id)generationReject('input_version_stale');
  const admissionTime=await assistantNow(client,this.options.assistantClock);
  if(!options.runningKey){
   const current=(await client.query('SELECT * FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND is_default FOR UPDATE',[scope.owner_id,scope.contact_id])).rows[0];
   if(current&&current.id!==sessionId&&current.idle_previous_session_id===sessionId){session=current;sessionId=current.id;}
   const expired=session.is_default&&(await client.query("SELECT last_user_activity_at IS NULL OR $4::timestamptz > last_user_activity_at + interval '12 hours' AS expired FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3",[scope.owner_id,scope.contact_id,sessionId,admissionTime])).rows[0].expired;
   if(expired){
    if(input.expected_input_version_id!==undefined&&session.current_input_version_id!==input.expected_input_version_id)generationReject('input_version_stale');
    await client.query('UPDATE assistant_session SET is_default=FALSE WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,sessionId]);
    session=(await client.query('INSERT INTO assistant_session(owner_id,contact_id,is_default,idle_previous_session_id) VALUES($1,$2,TRUE,$3) RETURNING *',[scope.owner_id,scope.contact_id,sessionId])).rows[0];sessionId=session.id;
   }
  }
  const moved=sessionId!==requestedSessionId;
  // 新键不能夺走已受理轮的当前输入；显式替换继续走原来的撤销合同。
  if(!options.runningKey&&(await client.query(`SELECT 1 FROM assistant_session_turn turn LEFT JOIN reply_request request ON request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id AND request.idempotency_key=turn.idempotency_key WHERE turn.owner_id=$1 AND turn.contact_id=$2 AND turn.session_id=$3 AND (request.state='running' AND request.lease_expires_at>clock_timestamp() OR request.id IS NULL AND turn.state='running')`,[scope.owner_id,scope.contact_id,sessionId])).rowCount)throw new AssistantGenerationError('assistant_session_in_progress');
  await this.options.requireSessionReady?.(client,scope,sessionId);
  if(!moved&&input.expected_input_version_id!==undefined&&session.current_input_version_id!==input.expected_input_version_id)generationReject('input_version_stale');
  const deps=new Set(options.dependencies??[]);
  if(!moved&&input.expected_input_version_id)for(const id of await this.current(client,scope,sessionId,input.expected_input_version_id))deps.add(id);
  if(input.content.type==='reply_to_message')deps.add(input.content.target_message_id as string);
  if(input.continued_from_candidate_id){await this.guards.assistant.readContinuationBasis(client,scope,scope.conversation_binding_id,input.continued_from_candidate_id);const candidate=(await client.query('SELECT reply_request_id FROM reply_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,input.continued_from_candidate_id])).rows[0];for(const id of await generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:candidate.reply_request_id}))deps.add(id);}
  const captured=await this.guards.assistant.verifiedDiscussionDependencies(client,scope,unique(deps),true);await this.guards.ports.requireGenerationMemoryDependencies(client,scope,captured);
  for(const id of await prepareExploredGeneration(this,client,scope,requestedSessionId,input,options.auth))if(!captured.includes(id))captured.push(id);
  if(options.runningKey)await this.replaceRunning(client,scope,sessionId,options.runningKey);
  const row=(await client.query('INSERT INTO assistant_session_turn(session_id,owner_id,contact_id,idempotency_key,conversation_binding_id,input_digest,input_payload,dependency_ids,requested_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[sessionId,scope.owner_id,scope.contact_id,input.idempotency_key,scope.conversation_binding_id,digest,JSON.stringify(generationPayload(input,options.auth)),captured,moved?requestedSessionId:null])).rows[0];
  await client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id) VALUES($1,$2,$3,$4,$5,'generation',$6)",[row.input_version_id,sessionId,scope.owner_id,scope.contact_id,scope.conversation_binding_id,row.id]);
  await client.query('UPDATE assistant_session SET current_input_version_id=$1,updated_at=now() WHERE owner_id=$2 AND contact_id=$3 AND id=$4',[row.input_version_id,scope.owner_id,scope.contact_id,sessionId]);await recordAssistantUserActivity(client,scope,sessionId,async()=>admissionTime);return row;
 }
 async replaceRunning(client:Client,scope:VerifiedReplyScope,sessionId:string,key:string):Promise<void>{
  const old=await this.existing(client,scope,key);if(!old||old.session_id!==sessionId)throw new AssistantGenerationError('not_found',undefined,404);
  await this.current(client,scope,sessionId,old.input_version_id);
  const request=(await client.query('SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 FOR UPDATE',[scope.owner_id,scope.contact_id,key])).rows[0];
  if((await client.query('SELECT 1 FROM reply_invalidated_key WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[scope.owner_id,scope.contact_id,key])).rowCount)generationReject('request_deleted');
  if(!['running','failed'].includes(old.state)||!request&&old.state!=='running'||request&&request.state!=='running')generationReject('generation_not_running');
  if(request)await this.guards.ports.requireReplySourcesCurrent(client,scope,request.id,false);
  await client.query('INSERT INTO reply_invalidated_key(owner_id,contact_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[scope.owner_id,scope.contact_id,key]);
  if(request){await client.query("UPDATE reply_request SET state='failed',lease_expires_at=least(lease_expires_at,now()),updated_at=now() WHERE id=$1",[request.id]);const changed=await client.query("UPDATE reply_attempt SET state='failed',failure_reason='generation_replaced',lease_expires_at=least(lease_expires_at,now()) WHERE reply_request_id=$1 AND number=$2 AND state='running'",[request.id,request.attempt]);if(changed.rowCount!==1)throw new AssistantGenerationError('assistant_session_save_failed',undefined,503);}
  await client.query("UPDATE assistant_session_turn SET state='failed',updated_at=now() WHERE id=$1",[old.id]);
 }
 async auth(client:Client,scope:VerifiedReplyScope,sessionId:string,payload:GenerationRow):Promise<AuthenticatedContinuation|undefined>{
  const metadata=payload.continuation;if(metadata===undefined)return undefined;
  if(!record(metadata)||!Array.isArray(metadata.effective_requirements)||metadata.effective_requirements.some(value=>typeof value!=='string'||!value.trim())||(payload.content.user_instruction??null)!==(metadata.effective_requirements.length?metadata.effective_requirements.join('；'):null))generationReject('source_unavailable');
  if(metadata.candidate_group_id!==null)await this.guards.ports.requireSavedSkillPolicy(client,scope,metadata.candidate_group_id);
  let reference:AuthenticatedContinuation['continuation_reference']=null;
  if(metadata.candidate_id!==null){
   const candidate=(await client.query("SELECT c.* FROM reply_candidate c JOIN assistant_session_turn t ON t.reply_request_id=c.reply_request_id AND t.owner_id=c.owner_id AND t.contact_id=c.contact_id AND t.conversation_binding_id=c.conversation_binding_id WHERE c.owner_id=$1 AND c.contact_id=$2 AND c.id=$3 AND t.session_id=$4 AND t.state='completed'",[scope.owner_id,scope.contact_id,metadata.candidate_id,sessionId])).rows[0];
   if(!candidate||candidate.conversation_binding_id!==scope.conversation_binding_id)generationReject('continued_candidate_unavailable');
   await this.guards.assistant.readContinuationBasis(client,scope,scope.conversation_binding_id,candidate.id);
   const version=(await client.query('SELECT * FROM assistant_candidate_version WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND candidate_id=$4 AND id=$5',[scope.owner_id,scope.contact_id,sessionId,candidate.id,metadata.version_id])).rows[0];
   if(!version&&metadata.version_id!==candidate.id)generationReject('continued_candidate_unavailable');
   reference={candidate_id:candidate.id,version_id:metadata.version_id as string,messages:version?.message_group??candidate.message_group};
  }else if(metadata.version_id!==null)generationReject('continued_candidate_unavailable');
  return {continuation:metadata,continuation_reference:reference};
 }
 async retry(client:Client,scope:VerifiedReplyScope,sessionId:string,command:GenerationRow){
  const original=(await client.query('SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4 AND input_version_id=$5 FOR UPDATE',[scope.owner_id,scope.contact_id,sessionId,command.original_turn_id,command.original_input_version_id])).rows[0];
  if(!original)throw new AssistantGenerationError('not_found',undefined,404);
  if(original.state!=='failed'||!['app_quit','configuration_reload','user_cancelled'].includes(original.interruption_reason))generationReject('generation_not_interrupted');
  if(original.idempotency_key===command.request_key)generationReject('generation_interrupted');
  if(!original.input_payload)generationReject('source_deleted');
  if(original.conversation_binding_id!==scope.conversation_binding_id)generationReject('binding_changed');
  const terminal=await interruptAssistantGeneration(this,client,scope,sessionId,original.idempotency_key,original.input_version_id,'app_quit');
  if(terminal.state!=='failed'||terminal.interruption_reason!==original.interruption_reason)generationReject('generation_not_interrupted');
  const origin={original_turn_id:original.id,original_input_version_id:original.input_version_id},existing=await this.existing(client,scope,command.request_key);
  let payload:GenerationRow,deps:string[]=[];
  if(existing){if(!matchesGenerationSession(existing,sessionId)||canonical(existing.input_payload?.continuation?.recovery??null)!==canonical(origin))throw new AssistantGenerationError('assistant_session_input_conflict');payload=existing.input_payload;}
  else{
   deps=await this.current(client,scope,sessionId,original.input_version_id);payload=structuredClone(original.input_payload);
   const content=payload.content,source=content.type==='reply_to_message'||content.input_kind==='current_chat'?'direction':content.type==='initiate_conversation'?'purpose':'draft_text';
   const metadata=payload.continuation??{version:1,submission:origin,candidate_group_id:null,candidate_number:null,candidate_id:null,version_id:null,effective_intent:{source},effective_requirements:content.user_instruction?[content.user_instruction]:[],intention_changed:false,scope:'this_assistant_session_only'};
   payload.continuation={...metadata,recovery:origin};
  }
  const auth=await this.auth(client,scope,sessionId,payload);let input={...generationRequest(scope,command.request_key,payload,auth),expected_input_version_id:command.original_input_version_id};
  if(!existing&&input.suggestion){
   const reference=input.suggestion,parent=(await client.query('SELECT 1 FROM reply_exploration WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND id=$4 AND request_key=$5',[scope.owner_id,scope.contact_id,sessionId,reference.task_id,original.idempotency_key])).rowCount;
   if(parent){const field=input.content.type==='reply_to_message'?'direction':'purpose',source=input.content[field+'_source'],intent=input.content[field];
    const task=await generationExplorationStore(this,scope).reconfirm_in_transaction(client,{owner_id:scope.owner_id,contact_id:scope.contact_id},sessionId,reference.task_id,reference.input_version,{expected_input_version_id:original.input_version_id,request_key:command.request_key,suggestion_id:source==='confirmed_suggestion'?reference.suggestion_id:null,direct_intent:source==='direct_input'?intent as string:null});
    input={...input,suggestion:{task_id:task.exploration_id,input_version:task.input_version_id,suggestion_id:task.selection_id!},expected_input_version_id:task.input_version_id};
   }
  }
  const row=await this.reserve(client,scope,sessionId,input,{auth,dependencies:deps});return {row,input,auth};
 }
 async complete(scope:VerifiedReplyScope,sessionId:string,row:GenerationRow,result:unknown,signal:AbortSignal):Promise<void>{
  if(!record(result)||typeof result.reply_request_id!=='string')throw new AssistantGenerationError('assistant_session_save_failed',undefined,503);
  await this.transaction(scope,async client=>{
   const current=await this.existing(client,scope,row.idempotency_key);if(!current||current.id!==row.id||current.session_id!==sessionId||current.input_version_id!==row.input_version_id||current.state==='redacted'||current.interruption_reason!==null)generationReject('generation_interrupted');
   const saved=(await client.query("SELECT * FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND idempotency_key=$4 AND conversation_binding_id=$5 AND state='completed'",[scope.owner_id,scope.contact_id,result.reply_request_id,row.idempotency_key,scope.conversation_binding_id])).rows[0];if(!saved)throw new AssistantGenerationError('assistant_session_save_failed',undefined,503);
   await this.guards.ports.requireReplySourcesCurrent(client,scope,saved.id,true);await this.guards.ports.requireSavedSkillPolicy(client,scope,saved.id);
   const deps=unique([...current!.dependency_ids,...await generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:saved.id})]);
   await this.guards.assistant.verifiedDiscussionDependencies(client,scope,deps,true);await this.guards.ports.requireGenerationMemoryDependencies(client,scope,deps);
   await client.query("UPDATE assistant_session_turn SET state='completed',interruption_reason=NULL,reply_request_id=$2,dependency_ids=$3,updated_at=now() WHERE id=$1",[row.id,saved.id,deps]);
  },signal);
 }
 async fail(scope:VerifiedReplyScope,row:GenerationRow):Promise<void>{await this.transaction(scope,async client=>{
  const completed=(await client.query("SELECT 1 FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3 AND state='completed'",[scope.owner_id,scope.contact_id,row.idempotency_key])).rowCount;
  // 文件关闭或发布失败不撤销已经可靠提交的候选；仍沿同一来源、输入和Skill守卫裁定。
  if(completed){await interruptAssistantGeneration(this,client,scope,row.session_id,row.idempotency_key,row.input_version_id,'app_quit');return;}
  await client.query("UPDATE assistant_session_turn SET state='failed',updated_at=now() WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND state='running'",[scope.owner_id,scope.contact_id,row.id]);
 });}
}
