/** 迁移 A 段的实际服务：读取原 trace/window，核原任务租约；B 段仍由原唯一写入方提交。 */
import type pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalJSON,parseStoredJSON,digest} from './contact-overview-evidence.ts';
import {freezeExtractionSources,requireCurrent,type FrozenExtractionSources} from './extraction-sources.ts';
import {runExtractionFlow,type ExtractionFlowOutcome} from './extraction-flow.ts';
import {attachVerifiedSourceReceipt,dimensionEvidencePayload,evidenceTimestamp,type EvidenceFact} from './extraction-evidence.ts';
import {modelTaskRequestId} from './host-model-accounting.ts';
import {sourceAllowed} from './extraction-task-store.ts';
import type {ExtractionModelInput} from './extraction-model.ts';
import type {ModelLedgerReceipt} from './model-ledger.ts';
import type {ModelTaskClaim} from './model-permit-server.ts';
import type {MessagesBudgetBinding,MessagesBudgetProfile} from './model-input-budget.ts';
import type {ContentBlock} from '@deepseek-ai/dsh-llm';
import type {ExtractionWindow} from './extraction-protocol.ts';

type Transaction=<T>(work:(client:pg.Client)=>Promise<T>)=>Promise<T>;
export interface ExtractionBatchInput {owner_id:string;contact_id:string;trace_id:string;batch_key:string;claim:ModelTaskClaim;}
export interface ExtractionBatchWireOutcome extends Omit<ExtractionFlowOutcome,'accepted'|'verification'> {
 accepted:(Omit<EvidenceFact,'dimension_evidence'>&{dimension_evidence:ReturnType<typeof dimensionEvidencePayload>})[];
 candidate_trace_ids:string[];model_accounting_owner:'typescript';model_call_ids:string[];
 a_execution_id:string;a_input_sha256:string;a_rule_version:string;
}
export class ExtractionBatchError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
interface Options {
 ownerId:string;transaction:Transaction;ruleVersion:string;
 model:{binding:MessagesBudgetBinding;profile:MessagesBudgetProfile};
 call(input:ExtractionModelInput):Promise<{text:string;blocks:ContentBlock[];receipt?:ModelLedgerReceipt}>;
 unconfirmedRequests(scope:{owner_id:string;contact_id:string}):Promise<string[]>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reject=(code='extraction_batch_stale'):never=>{throw new ExtractionBatchError(code);};
function parseInput(value:ExtractionBatchInput,owner:string):ExtractionBatchInput {
 if(!value||Object.keys(value).sort().join()!=='batch_key,claim,contact_id,owner_id,trace_id'||value.owner_id!==owner
  ||[value.owner_id,value.contact_id,value.trace_id].some(id=>typeof id!=='string'||!uuid.test(id))||!/^[a-f0-9]{64}$/.test(value.batch_key))reject('extraction_batch_invalid');
 const c=value.claim;
 if(!c||Object.keys(c).sort().join()!=='lease_generation,step_id,step_name,task_id,worker_id'
  ||[c.task_id,c.step_id,c.worker_id].some(id=>typeof id!=='string'||!uuid.test(id))||c.step_name!=='extract_memory'
  ||!Number.isSafeInteger(c.lease_generation)||c.lease_generation<1)reject('extraction_batch_invalid');
 return structuredClone(value);
}
async function lockedClaim(client:pg.Client,input:ExtractionBatchInput):Promise<void>{
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${input.owner_id}:${input.contact_id}`]);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${input.owner_id}`]);
 const c=input.claim;
 const row=(await client.query(`SELECT t.extraction_runtime_config FROM background_task t JOIN background_task_step s ON s.task_id=t.id
  WHERE t.id=$1 AND s.id=$2 AND t.owner_id=$3 AND t.contact_id=$4 AND t.task_type IN ('import','observation')
  AND t.current_step='extract_memory' AND t.status='running' AND s.step_name='extract_memory' AND s.status='running'
  AND s.worker_id=$5 AND s.lease_generation=$6 AND s.lease_expires_at>clock_timestamp() AND ${sourceAllowed} FOR UPDATE OF t,s`,
 [c.task_id,c.step_id,input.owner_id,input.contact_id,c.worker_id,c.lease_generation])).rows[0];
 if(!row)reject();
 if(row.extraction_runtime_config&&row.extraction_runtime_config.mode!=='legacy')reject('extraction_batch_mode_not_migrated');
}
function originalMessage(message:FrozenExtractionSources['messages'][number]){
 return {message_id:message.message_id,text:message.text,sender:message.sender,occurred_at:message.occurred_at,
  source_snapshots:message.source_snapshots,message_type:message.message_snapshot?.message_type,
  text_representation:message.text_representation,message_snapshot:message.message_snapshot};
}
function normalizedMessage(message:Record<string,any>){
 return {...message,occurred_at:evidenceTimestamp(message.occurred_at),
  message_snapshot:{...message.message_snapshot,occurred_at:evidenceTimestamp(message.message_snapshot.occurred_at)}};
}
function eventPayload(value:unknown,rule:string){
 const payload=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{value};
 const now=new Date().toISOString();
 return {...payload,_execution:{kind:'snapshot_capture',started_at:now,finished_at:now,status:'recorded',rule_version:rule,payload_sha256:digest(payload)}};
}
async function append(client:pg.Client,input:ExtractionBatchInput,stage:string,payload:unknown,rule:string,callId:string|null=null,candidateTraceId:string|null=null){
 const trace=(await client.query('SELECT status FROM memory_extraction_trace WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 FOR UPDATE',[input.trace_id,input.owner_id,input.contact_id])).rows[0];
 if(trace?.status!=='running')reject();
 await client.query(`INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload,call_id,candidate_trace_id)
  SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,$5,$6::jsonb,$7,$8 FROM memory_extraction_trace_event WHERE trace_id=$2`,
 [randomUUID(),input.trace_id,input.owner_id,input.contact_id,stage,canonicalJSON(eventPayload(payload,rule)),callId,candidateTraceId]);
}

export class ExtractionBatchService {
 private readonly options:Options;private readonly active=new Set<string>();
 constructor(options:Options){
  if(!uuid.test(options.ownerId)||!/^[a-f0-9]{64}$/.test(options.ruleVersion))reject('extraction_batch_configuration_invalid');
  this.options={...options,model:structuredClone(options.model)};
 }
 async run(value:ExtractionBatchInput,signal:AbortSignal):Promise<ExtractionBatchWireOutcome>{
  const input=parseInput(value,this.options.ownerId);
  if(this.active.has(input.trace_id))reject('extraction_batch_busy');
  this.active.add(input.trace_id);
  try{return await this.execute(input,signal);}finally{this.active.delete(input.trace_id);}
 }
 private async execute(input:ExtractionBatchInput,signal:AbortSignal):Promise<ExtractionBatchWireOutcome>{
  signal.throwIfAborted();
  const requestId=modelTaskRequestId('extraction',input.claim.task_id,input.batch_key);
  const unconfirmed=await this.options.unconfirmedRequests(input).catch(()=>reject('extraction_batch_recovery_unavailable'));
  if(!Array.isArray(unconfirmed)||unconfirmed.some(id=>typeof id!=='string'||!uuid.test(id)))reject('extraction_batch_recovery_unavailable');
  if(unconfirmed.includes(requestId))reject('extraction_batch_outcome_unknown');
  const scope={ownerId:input.owner_id,contactId:input.contact_id};
  const prepared=await this.options.transaction(async client=>{
   await lockedClaim(client,input);
   const trace=(await client.query(`SELECT e.payload::text AS payload FROM memory_extraction_trace tr JOIN memory_extraction_trace_event e ON e.trace_id=tr.trace_id
    WHERE tr.trace_id=$1 AND tr.owner_id=$2 AND tr.contact_id=$3 AND tr.batch_key=$4 AND tr.status='running' AND e.stage='window'
    AND e.payload#>>'{task_runtime,task_id}'=$5 AND e.payload#>>'{task_runtime,step_id}'=$6
    AND e.payload#>>'{task_runtime,worker_id}'=$7 AND e.payload#>>'{task_runtime,lease_generation}'=$8`,
   [input.trace_id,input.owner_id,input.contact_id,input.batch_key,input.claim.task_id,input.claim.step_id,input.claim.worker_id,String(input.claim.lease_generation)])).rows;
   if(trace.length!==1)reject();
   const recorded=parseStoredJSON(trace[0].payload);
   const targets=recorded.target_message_ids as string[],messages=recorded.messages as Record<string,any>[];
   if(!Array.isArray(targets)||!targets.length||targets.length>20||!Array.isArray(messages)||messages.length>60
    ||createHash('sha256').update(targets.join('|')).digest('hex')!==input.batch_key)reject();
   const selected=new Set(targets);
   const frozen=await freezeExtractionSources(client,scope,{target_message_ids:targets,context_message_ids:messages.filter(m=>!selected.has(m.message_id)).map(m=>m.message_id)});
   const original=messages.map(({role,...message})=>message);
   if(canonicalJSON(frozen.messages.map(originalMessage).map(normalizedMessage))!==canonicalJSON(original.map(normalizedMessage)))reject();
   // 同一时刻可由PG连接返回不同偏移；发送给模型的表示沿原已记录窗口，不静默改提示输入。
   const window:ExtractionWindow={owner_id:input.owner_id,contact_id:input.contact_id,messages:frozen.messages.map((message,index)=>({
    ...message,occurred_at:original[index]!.occurred_at,message_snapshot:original[index]!.message_snapshot})),target_message_ids:targets};
   const inputSha=digest({window,rule_version:this.options.ruleVersion,model:this.options.model});
   if((await client.query("SELECT 1 FROM model_call_receipt WHERE owner_id=$1 AND contact_id=$2 AND request_id=$3 AND outcome IN ('pending','unknown') LIMIT 1",[input.owner_id,input.contact_id,requestId])).rowCount)reject('extraction_batch_outcome_unknown');
   // 消费证据只认原B事务的batch_end；trace因断连失败并不表示结果已消费。
   const executions=(await client.query(`SELECT b.trace_id,b.payload AS begun,r.payload->'outcome' AS outcome
    FROM memory_extraction_trace_event b JOIN memory_extraction_trace tr ON tr.trace_id=b.trace_id
    LEFT JOIN memory_extraction_trace_event r ON r.trace_id=b.trace_id AND r.stage='typescript_a_result'
    WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND tr.batch_key=$3 AND b.stage='typescript_a_begin'
    AND b.payload->>'task_id'=$4 AND NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event e
     WHERE e.owner_id=$1 AND e.contact_id=$2 AND e.stage='batch_end'
     AND e.payload#>>'{typescript_a_receipt,a_execution_id}'=b.payload->>'execution_id'
     AND e.payload#>>'{typescript_a_receipt,a_input_sha256}'=b.payload->>'input_sha256'
     AND e.payload#>>'{typescript_a_receipt,a_rule_version}'=b.payload->>'rule_version')
    AND NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event n WHERE n.trace_id=b.trace_id AND n.stage='typescript_a_not_sent'
     AND n.payload->>'proof' IN ('before_model_invocation','known_not_sent_receipts')
     AND n.payload->>'a_execution_id'=b.payload->>'execution_id'
     AND n.payload->>'a_input_sha256'=b.payload->>'input_sha256' AND n.payload->>'a_rule_version'=b.payload->>'rule_version')`,
    [input.owner_id,input.contact_id,input.batch_key,input.claim.task_id])).rows;
   if(executions.length>1)reject('extraction_batch_outcome_unknown');
   const prior=executions[0];
   if(prior){
    if(prior.begun.input_sha256!==inputSha||prior.begun.rule_version!==this.options.ruleVersion||!prior.outcome)reject('extraction_batch_outcome_unknown');
    const cached=prior.outcome as ExtractionBatchWireOutcome;
    if(cached.a_execution_id!==prior.begun.execution_id||cached.a_input_sha256!==inputSha||cached.a_rule_version!==this.options.ruleVersion)reject('extraction_batch_outcome_unknown');
    if(!Array.isArray(cached.model_call_ids)||new Set(cached.model_call_ids).size!==cached.model_call_ids.length)reject('extraction_batch_outcome_unknown');
    const known=(await client.query(`SELECT c.call_id FROM memory_extraction_trace_call c JOIN model_call_receipt r
     ON r.ledger_entry_id=c.ledger_entry_id AND r.owner_id=c.owner_id AND r.contact_id=c.contact_id
     WHERE c.trace_id=$1 AND c.owner_id=$2 AND c.contact_id=$3 AND c.call_id=ANY($4::uuid[])
     AND c.ledger_commit_status='committed' AND r.outcome NOT IN ('pending','unknown') AND r.request_id=$5`,
     [prior.trace_id,input.owner_id,input.contact_id,cached.model_call_ids,requestId])).rows;
    if(known.length!==cached.model_call_ids.length)reject('extraction_batch_outcome_unknown');
    if(prior.trace_id!==input.trace_id)await append(client,input,'typescript_a_recovered',{
     a_execution_id:cached.a_execution_id,a_input_sha256:inputSha,a_rule_version:this.options.ruleVersion},this.options.ruleVersion);
    return {frozen,window,inputSha,cached};
   }
   if((await client.query("SELECT 1 FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage IN ('typescript_a_begin','typescript_a_recovered') LIMIT 1",[input.trace_id])).rowCount)reject('extraction_batch_already_consumed');
   // 正文清除不等于结果已被业务消费；原最小调用关联仍能阻止同一request重发。
   if((await client.query(`SELECT 1 FROM memory_extraction_trace tr JOIN memory_extraction_trace_call c ON c.trace_id=tr.trace_id
    JOIN model_call_receipt r ON r.ledger_entry_id=c.ledger_entry_id AND r.owner_id=c.owner_id AND r.contact_id=c.contact_id
    WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND tr.batch_key=$3 AND r.request_id=$4 AND r.provider=$5
    AND (c.provider_attempts>0 OR r.dispatch IN ('http_accepted','response_observed'))
    AND tr.status NOT IN ('succeeded','skipped') AND NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event e
     WHERE e.trace_id=tr.trace_id AND e.stage='typescript_a_begin') LIMIT 1`,
    [input.owner_id,input.contact_id,input.batch_key,requestId,this.options.model.binding.provider])).rowCount)reject('extraction_batch_outcome_unknown');
   await append(client,input,'typescript_a_begin',{execution_id:input.trace_id,request_id:requestId,task_id:input.claim.task_id,
    batch_key:input.batch_key,input_sha256:inputSha,executor:'typescript',rule_version:this.options.ruleVersion},this.options.ruleVersion);
   return {frozen,window,inputSha,cached:null};
  });
  if(prepared.cached)return prepared.cached;
  const requireSources=()=>this.options.transaction(async client=>{await lockedClaim(client,input);await requireCurrent(client,scope,prepared.frozen);});
  const modelCallIds:string[]=[];let currentCall:string|null=null,enteredModel=0;
  const receiptStates=new Map<string,{receipt:ModelLedgerReceipt;committed:boolean}>();
  const record=async(event:{stage:string;payload:unknown;candidate_trace_id?:string})=>this.options.transaction(async client=>{
   await lockedClaim(client,input);await requireCurrent(client,scope,prepared.frozen);
   await append(client,input,event.stage,event.payload,this.options.ruleVersion,currentCall,event.candidate_trace_id??null);
  });
  let outcome:ExtractionFlowOutcome;
  try{outcome=await runExtractionFlow({window:prepared.window,signal,requireCurrent:requireSources,record,
   invoke:async(request,callSignal)=>{
    currentCall=randomUUID();const callId=currentCall;
    await record({stage:'model_request',payload:{purpose:request.purpose,messages:[{role:'system',content:request.system},{role:'user',content:request.user}],schema:request.tool.parameters,capture_layer:'application_request'}});
    const recordReceipt=async(receipt:ModelLedgerReceipt,committed:boolean)=>{
     await this.options.transaction(async client=>{
      // 来源已删时只保存既有trace的无正文真实调用关联；整体删除不重建任何记录。
      if(!(await client.query('SELECT 1 FROM memory_extraction_trace WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3',[input.trace_id,input.owner_id,input.contact_id])).rowCount)return;
      await client.query(`INSERT INTO memory_extraction_trace_call(call_id,trace_id,owner_id,contact_id,purpose,called_at,finished_at,response_status,provider_attempts,ledger_entry_id,ledger_commit_status,disposition)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'consumed') ON CONFLICT(call_id) DO UPDATE SET ledger_commit_status=CASE
       WHEN memory_extraction_trace_call.ledger_commit_status='committed' THEN 'committed' ELSE EXCLUDED.ledger_commit_status END`,
      [callId,input.trace_id,input.owner_id,input.contact_id,request.purpose,receipt.called_at,new Date().toISOString(),
       receipt.outcome==='succeeded'||receipt.legacy_outcome==='rejected_by_validation'?'returned':receipt.dispatch==='response_observed'?'received':'unavailable',
       ['response_observed','http_accepted'].includes(receipt.dispatch)?1:0,receipt.ledger_entry_id??receipt.attempt_id,committed?'committed':'unknown']);
     });
     if(!modelCallIds.includes(callId))modelCallIds.push(callId);
     receiptStates.set(callId,{receipt,committed:committed||receiptStates.get(callId)?.committed===true});
    };
    enteredModel++;
    try{return await this.options.call({owner_id:input.owner_id,contact_id:input.contact_id,claim:input.claim,
     request_id:modelTaskRequestId('extraction',input.claim.task_id,input.batch_key),attempt_id:randomUUID(),ledger_entry_id:randomUUID(),
     binding:this.options.model.binding,profile:this.options.model.profile,system:request.system,
     messages:[{role:'user',content:[{type:'text',text:request.user}]}],tools:[request.tool],signal:callSignal,
     requireCurrent:requireSources,validateOutput:request.validateOutput,onReceipt:receipt=>recordReceipt(receipt,true)});}
    catch(error){const receipt=(error as {receipt?:ModelLedgerReceipt})?.receipt;if(receipt)await recordReceipt(receipt,false);throw error;}
   }});}catch(error){
   const zeroDispatch=enteredModel===0||receiptStates.size===enteredModel&&[...receiptStates.values()].every(
    state=>state.committed&&state.receipt.dispatch==='not_sent'&&state.receipt.outcome==='cancelled');
   if(zeroDispatch)try{
    const pending=await this.options.unconfirmedRequests(input);
    if(!Array.isArray(pending)||pending.some(id=>typeof id!=='string'||!uuid.test(id))||pending.includes(requestId))throw new Error('recovery_unknown');
    await this.options.transaction(async client=>{
     // 这里只结算可信执行的零派发元数据；暂停使旧租约失效不应抹掉这一事实。
     await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${input.owner_id}:${input.contact_id}`]);
     await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${input.owner_id}`]);
     if((await client.query("SELECT 1 FROM model_call_receipt WHERE owner_id=$1 AND contact_id=$2 AND request_id=$3 AND outcome IN ('pending','unknown') LIMIT 1",[input.owner_id,input.contact_id,requestId])).rowCount)reject('extraction_batch_outcome_unknown');
     const original=(await client.query(`SELECT tr.trace_id FROM memory_extraction_trace tr JOIN memory_extraction_trace_event b ON b.trace_id=tr.trace_id
      WHERE tr.trace_id=$1 AND tr.owner_id=$2 AND tr.contact_id=$3 AND b.stage='typescript_a_begin'
      AND b.payload->>'execution_id'=$1::text AND b.payload->>'input_sha256'=$4 AND b.payload->>'rule_version'=$5 FOR UPDATE OF tr`,
      [input.trace_id,input.owner_id,input.contact_id,prepared.inputSha,this.options.ruleVersion])).rows;
     if(original.length!==1)return;
     const proof={a_execution_id:input.trace_id,a_input_sha256:prepared.inputSha,a_rule_version:this.options.ruleVersion,
      proof:enteredModel===0?'before_model_invocation':'known_not_sent_receipts'};
     await client.query(`INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload)
      SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,'typescript_a_not_sent',$5::jsonb FROM memory_extraction_trace_event WHERE trace_id=$2`,
      [randomUUID(),input.trace_id,input.owner_id,input.contact_id,canonicalJSON(eventPayload(proof,this.options.ruleVersion))]);
    });
   }catch{/* 未能持久证明零派发时保留unknown，原始故障继续向调用者传播。 */}
   throw error;
  }
  const accepted=outcome.accepted.map(fact=>{
   const verification=outcome.verification.find(item=>item.fact===fact)?.result??null;
   const bound=attachVerifiedSourceReceipt(prepared.window,fact,verification);
   return {...bound,dimension_evidence:dimensionEvidencePayload(bound.dimension_evidence)};
  });
  const {verification,...rest}=outcome;
  const result={...rest,accepted,candidate_trace_ids:outcome.candidate_trace_ids,model_accounting_owner:'typescript' as const,model_call_ids:modelCallIds,
   a_execution_id:input.trace_id,a_input_sha256:prepared.inputSha,a_rule_version:this.options.ruleVersion};
  await record({stage:'typescript_a_result',payload:{outcome:result}});
  return result;
 }
}
