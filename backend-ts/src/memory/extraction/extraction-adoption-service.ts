/** A 结果之后的单一 B 段服务：领取由调用方持有，本服务只执行裁决、采纳与同事务批次收尾。 */
import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {canonicalJSON,digest,parseStoredJSON} from '../overview/contact-overview-evidence.ts';
import type {ExtractionBatchWireOutcome} from './extraction-batch-service.ts';
import type {ExtractionClaim,ExtractionTaskStore} from './extraction-task-store.ts';
import {EMBEDDING_MODEL,EMBEDDING_REVISION} from '../../retrieval/retrieval-embedding.ts';
import type {EmbedTexts} from '../../retrieval/retrieval-hybrid.ts';
import {
 DshMemoryAdjudicationRuntime,type StructuredAdjudicationCallInput,type StructuredAdjudicationCallPort,type StructuredAdjudicationCallResult,
} from '../management/memory-adjudication-dsh.ts';
import {
 MemoryAdoption,MemoryAdoptionError,type AdoptionFact,type AdoptionStats,type ModelUsage,
} from '../management/memory-adoption.ts';
import type {ModelTaskClaim} from '../../platform/models/model-permit-server.ts';

type Row=Record<string,any>;
type Purpose=NonNullable<ModelUsage['purpose']>;
type FenceStore=Pick<ExtractionTaskStore,'fenced'|'assertVerificationPolicy'>;
export interface FixedLocalEmbedding {model:string;revision:string;embed:EmbedTexts}
export interface ExtractionAdoptionModelCallInput extends Omit<StructuredAdjudicationCallInput,'request_key'> {
 owner_id:string;
 contact_id:string;
 trace_id:string;
 batch_key:string;
 claim:ModelTaskClaim;
 request_id:string;
}
export interface ExtractionAdoptionModelCallPort {
 call(input:ExtractionAdoptionModelCallInput):Promise<StructuredAdjudicationCallResult>;
}
export interface ExtractionAdoptionInput {
 owner_id:string;
 contact_id:string;
 trace_id:string;
 batch_key:string;
 claim:ModelTaskClaim;
 a_result:ExtractionBatchWireOutcome;
}
export interface ExtractionAdoptionReceipt {
 version:1;
 b_execution_id:string;
 trace_id:string;
 a_execution_id:string;
 a_input_sha256:string;
 a_rule_version:string;
 candidate_trace_ids:string[];
 accepted_count:number;
 rejected_count:number;
 stats:AdoptionStats;
 watermark_before:string|null;
 watermark_planned:string;
 watermark_after:string|null;
}
export interface ExtractionAdoptionResult {
 trace_id:string;
 b_execution_id:string;
 stats:AdoptionStats;
 receipt:ExtractionAdoptionReceipt;
 watermark:string|null;
 cached:boolean;
}
export class ExtractionAdoptionError extends Error {
 readonly code:string;
 readonly retryable:boolean;
 readonly partial:AdoptionStats|null;
 constructor(code:string,retryable:boolean,partial:AdoptionStats|null,cause?:unknown){
  super(code,{cause});this.code=code;this.retryable=retryable;this.partial=partial;this.name='ExtractionAdoptionError';
 }
}
interface Options {ownerId:string;taskStore:FenceStore;adjudicationPort:ExtractionAdoptionModelCallPort;embedding:FixedLocalEmbedding}
interface PreparedBatch {
 target_ids:string[];
 message_ids:string[];
 b_execution_id:string;
 a_receipt:{a_execution_id:string;a_input_sha256:string;a_rule_version:string};
 cached:ExtractionAdoptionResult|null;
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=/^[a-f0-9]{64}$/;
const failure=(code:string):never=>{throw new ExtractionAdoptionError(code,false,null);};
const uniqueIds=(value:unknown,limit:number,code='adoption_request_invalid'):string[]=>{
 if(!Array.isArray(value)||value.length>limit||value.some(item=>typeof item!=='string'||!uuid.test(item)))failure(code);
 const ids=(value as string[]).map(item=>item.toLowerCase());
 if(new Set(ids).size!==ids.length)failure(code);
 return ids;
};
const purposeList:readonly Purpose[]=['adjudication','relation_verification','merge_verification'];
const uuidv5=(name:string):string=>{
 const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
 const bytes=createHash('sha1').update(namespace).update(name,'utf8').digest().subarray(0,16);
 bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
 const h=bytes.toString('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
/** Host ModelHost 扩展 B 用途时应复用该请求身份，不能让三类调用共享 extraction key。 */
export function adoptionPurposeRequestId(purpose:Purpose,taskId:string,batchKey:string,detail='batch'):string{
 if(!purposeList.includes(purpose)||!uuid.test(taskId)||!sha.test(batchKey)||!detail.trim())failure('adoption_request_invalid');
 return uuidv5(`notalone:${purpose}:${taskId}:${batchKey}:${detail}`);
}
function parseInput(value:ExtractionAdoptionInput,owner:string):ExtractionAdoptionInput{
 if(!value||Object.keys(value).sort().join(',')!=='a_result,batch_key,claim,contact_id,owner_id,trace_id'
  ||value.owner_id!==owner||!uuid.test(value.owner_id)||!uuid.test(value.contact_id)||!uuid.test(value.trace_id)
  ||!sha.test(value.batch_key))failure('adoption_request_invalid');
 const claim=value.claim,c=claim;
 if(!c||Object.keys(c).sort().join(',')!=='lease_generation,step_id,step_name,task_id,worker_id'
  ||!uuid.test(c.task_id)||!uuid.test(c.step_id)||!uuid.test(c.worker_id)||c.step_name!=='extract_memory'
  ||!Number.isSafeInteger(c.lease_generation)||c.lease_generation<1)failure('adoption_request_invalid');
 const a=value.a_result;
 if(!a||a.model_accounting_owner!=='typescript'||a.extraction_completed!==true||a.failure_reason!==null
  ||!uuid.test(a.a_execution_id)||!sha.test(a.a_input_sha256)||!sha.test(a.a_rule_version)
  ||!Array.isArray(a.accepted)||a.accepted.length>100||!Array.isArray(a.candidate_trace_ids)
  ||a.candidate_trace_ids.length!==a.accepted.length||a.candidate_trace_ids.some(id=>typeof id!=='string'||!uuid.test(id))
  ||new Set(a.candidate_trace_ids.map(id=>id.toLowerCase())).size!==a.candidate_trace_ids.length
  ||!Number.isSafeInteger(a.rejected_count)||a.rejected_count<0)failure('adoption_a_result_invalid');
 return structuredClone(value);
}
function asClaim(input:ExtractionAdoptionInput):ExtractionClaim{
 const c=input.claim;
 // 结构适配只传五字段租约；策略另从围栏内的真实任务和窗口核对。
 return {ownerId:input.owner_id,contactId:input.contact_id,taskId:c.task_id,stepId:c.step_id,stepName:c.step_name,
  workerId:c.worker_id,leaseGeneration:c.lease_generation,attemptCount:0,messageCount:0,sourceDocumentId:null,
  taskType:'import',leaseExpiresAt:new Date(0),runtimeConfig:null};
}
function sameRuntime(value:Row|null,claim:ModelTaskClaim):boolean{
 const lease=value?.lease_generation&&typeof value.lease_generation==='object'&&'literal' in value.lease_generation
  ?Number(value.lease_generation.literal):Number(value?.lease_generation);
 return Boolean(value)&&String(value!.task_id)===claim.task_id&&String(value!.step_id)===claim.step_id
  &&String(value!.step_name)===claim.step_name&&String(value!.worker_id)===claim.worker_id
  &&lease===claim.lease_generation;
}
function eventPayload(payload:unknown):string{
 const body=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Row:{value:payload};
 const now=new Date().toISOString();
 return canonicalJSON({...body,_execution:{kind:'snapshot_capture',started_at:now,finished_at:now,status:'recorded',
  rule_version:'extraction-adoption-v1',payload_sha256:digest(body)}});
}
async function appendEvent(client:pg.ClientBase,input:ExtractionAdoptionInput,stage:string,payload:unknown,candidateTraceId:string|null=null):Promise<void>{
 await client.query(`INSERT INTO public.memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,candidate_trace_id,payload)
  SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,$5,$6,$7::jsonb FROM public.memory_extraction_trace_event
  WHERE trace_id=$2`,[randomUUID(),input.trace_id,input.owner_id,input.contact_id,stage,candidateTraceId,eventPayload(payload)]);
}
function validStats(value:unknown,expected:number):value is AdoptionStats{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const stats=value as AdoptionStats;
 return ['adopted','updated','merged','pending','skipped_duplicate','skipped_deleted','skipped_noop','failed']
  .every(key=>Number.isSafeInteger((stats as unknown as Row)[key])&&Number((stats as unknown as Row)[key])>=0)
  &&Array.isArray(stats.results)&&stats.results.length===expected
  &&stats.results.every((row,index)=>Number.isSafeInteger(row.candidate_index)&&row.candidate_index===index&&typeof row.disposition==='string')
  &&Array.isArray(stats.usages)&&stats.usages.every(row=>row===null||typeof row==='object');
}
function validReceipt(value:unknown,input:ExtractionAdoptionInput,bExecutionId:string,
 traceId=input.trace_id):value is ExtractionAdoptionReceipt{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const receipt=value as ExtractionAdoptionReceipt;
 return receipt.version===1&&receipt.b_execution_id===bExecutionId&&receipt.trace_id===traceId
  &&receipt.a_execution_id===input.a_result.a_execution_id&&receipt.a_input_sha256===input.a_result.a_input_sha256
  &&receipt.a_rule_version===input.a_result.a_rule_version
  &&canonicalJSON(receipt.candidate_trace_ids)===canonicalJSON(input.a_result.candidate_trace_ids.map(id=>id.toLowerCase()))
  &&receipt.accepted_count===input.a_result.accepted.length&&receipt.rejected_count===input.a_result.rejected_count
  &&validStats(receipt.stats,input.a_result.accepted.length)&&typeof receipt.watermark_planned==='string'
  &&uuid.test(receipt.watermark_planned)&&(receipt.watermark_before===null||uuid.test(receipt.watermark_before))
  &&(receipt.watermark_after===null||uuid.test(receipt.watermark_after));
}

export class ExtractionAdoptionService {
 private readonly options:Options;
 private readonly active=new Set<string>();
 constructor(options:Options){
  if(!uuid.test(options.ownerId)||options.embedding?.model!==EMBEDDING_MODEL
   ||options.embedding.revision!==EMBEDDING_REVISION||typeof options.embedding.embed!=='function')failure('adoption_configuration_invalid');
  if(!options.taskStore||typeof options.taskStore.fenced!=='function'||typeof options.taskStore.assertVerificationPolicy!=='function'||!options.adjudicationPort
   ||typeof options.adjudicationPort.call!=='function')failure('adoption_configuration_invalid');
  this.options=options;
 }
 async run(value:ExtractionAdoptionInput,signal:AbortSignal):Promise<ExtractionAdoptionResult>{
  const input=parseInput(value,this.options.ownerId);
  signal.throwIfAborted();
  const runKey=`${input.a_result.a_execution_id}:${input.claim.task_id}:${input.batch_key}`;
  if(this.active.has(runKey))failure('adoption_busy');
  this.active.add(runKey);
  try{return await this.execute(input,signal);}finally{this.active.delete(runKey);}
 }
 private async execute(input:ExtractionAdoptionInput,signal:AbortSignal):Promise<ExtractionAdoptionResult>{
  let prepared:PreparedBatch;
  try{prepared=await this.fenced(input,client=>this.inspect(client,input,true));}
  catch(error){throw this.wrap(error,null);}
  if(prepared.cached)return prepared.cached;
  const adoption=new MemoryAdoption({ownerId:this.options.ownerId,
   transaction:work=>this.fenced(input,client=>work(client as unknown as pg.Client)),
   embed:this.options.embedding.embed,
   adjudication:new DshMemoryAdjudicationRuntime({batchKey:input.batch_key,port:this.boundPort(input)})});
  let stats:AdoptionStats;
  try{
   stats=await adoption.adoptBatch({contact_id:input.contact_id,trace_id:input.trace_id,batch_key:input.batch_key,
    signal,facts:input.a_result.accepted.map((fact,index)=>({fact:fact as AdoptionFact,candidate_trace_id:input.a_result.candidate_trace_ids[index]!}))});
  }catch(error){
   const partial=error instanceof MemoryAdoptionError?error.partial:null;
   throw this.wrap(error,partial);
  }
  if(!validStats(stats,input.a_result.accepted.length)||stats.failed)
   throw new ExtractionAdoptionError('adoption_candidate_failed',false,stats);
  try{
   signal.throwIfAborted();
   const receipt=await this.fenced(input,client=>this.finalize(client,input,prepared.b_execution_id,stats,signal));
   return {trace_id:input.trace_id,b_execution_id:prepared.b_execution_id,stats:receipt.stats,receipt,watermark:receipt.watermark_after,cached:false};
  }catch(error){
   if(error instanceof ExtractionAdoptionError&&error.partial)throw error;
   throw this.wrap(error,stats);
  }
 }
 private wrap(error:unknown,partial:AdoptionStats|null):ExtractionAdoptionError{
  if(error instanceof ExtractionAdoptionError){if(!error.partial&&partial)return new ExtractionAdoptionError(error.code,error.retryable,partial,error.cause??error);return error;}
  const value=error as {code?:unknown;retryable?:unknown;partial?:unknown;cause?:unknown};
  let code=typeof value?.code==='string'&&value.code?value.code:'adoption_failed',current:unknown=error,retryable=value?.retryable===true;
  for(let depth=0;depth<8&&current&&typeof current==='object';depth++){
   const nested=current as {code?:unknown;retryable?:unknown;cause?:unknown};
   if(typeof nested.code==='string'&&nested.code)code=nested.code;
   retryable=retryable||nested.retryable===true;
   current=nested.cause;
  }
  const candidatePartial=value?.partial as Row|undefined;
  const preserved=partial??(candidatePartial&&Array.isArray(candidatePartial.results)
   &&validStats(candidatePartial,candidatePartial.results.length)?candidatePartial as unknown as AdoptionStats:null);
  return new ExtractionAdoptionError(code,retryable||code==='lease_stale',preserved,error);
}
 private boundPort(input:ExtractionAdoptionInput):StructuredAdjudicationCallPort{
  return {call:async request=>{
   const purpose=request.purpose;
   if(!purpose||!purposeList.includes(purpose))failure('adoption_purpose_invalid');
   const selectedPurpose=purpose as Purpose;
   await this.checkFence(input);
   const mergeIndex=selectedPurpose==='merge_verification'?request.request_key.split(':').at(-1):'batch';
   const detail=mergeIndex&&/^\d+$/.test(mergeIndex)?mergeIndex:'batch';
   const requestId=adoptionPurposeRequestId(selectedPurpose,input.claim.task_id,input.batch_key,detail);
   const result=await this.options.adjudicationPort.call({purpose:selectedPurpose,owner_id:input.owner_id,
    contact_id:input.contact_id,trace_id:input.trace_id,batch_key:input.batch_key,claim:structuredClone(input.claim),
    request_id:requestId,system:request.system,user:request.user,schema:request.schema,
    signal:request.signal,validateOutput:request.validateOutput});
   await this.checkFence(input);
   return result;
  }};
 }
 private async checkFence(input:ExtractionAdoptionInput):Promise<void>{
  await this.fenced(input,async()=>{});
 }
 private async fenced<T>(input:ExtractionAdoptionInput,work:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  return this.options.taskStore.fenced(asClaim(input),async client=>{
   const assertPolicy=async()=>{
    const windows=(await client.query(`SELECT payload::text AS payload FROM public.memory_extraction_trace_event
     WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='window'`,
     [input.trace_id,input.owner_id,input.contact_id])).rows;
    if(windows.length!==1)failure('adoption_trace_unavailable');
    const runtime=parseStoredJSON(windows[0]!.payload).task_runtime??null;
    if(!sameRuntime(runtime,input.claim))failure('adoption_task_scope_mismatch');
    await this.options.taskStore.assertVerificationPolicy(client,asClaim(input),runtime,input.a_result.a_rule_version);
   };
   await assertPolicy();const result=await work(client);await assertPolicy();return result;
  });
 }
 private async inspect(client:pg.PoolClient,input:ExtractionAdoptionInput,writeBegin:boolean):Promise<PreparedBatch>{
  const current=(await client.query(`SELECT trace_id,status,batch_key FROM public.memory_extraction_trace
   WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 FOR UPDATE`,[input.trace_id,input.owner_id,input.contact_id])).rows[0];
  if(!current||current.batch_key!==input.batch_key)failure('adoption_trace_unavailable');
  const windowRows=(await client.query(`SELECT payload::text AS payload FROM public.memory_extraction_trace_event
   WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='window'`,[input.trace_id,input.owner_id,input.contact_id])).rows;
  if(windowRows.length!==1)failure('adoption_trace_unavailable');
  const window=parseStoredJSON(windowRows[0]!.payload),runtime=window.task_runtime??null;
  const targetIds=uniqueIds(window.target_message_ids,20,'adoption_a_result_invalid');
  const messages=window.messages;
  if(!targetIds.length||!Array.isArray(messages)||messages.length>60)failure('adoption_a_result_invalid');
  if(!sameRuntime(runtime,input.claim))failure('adoption_task_scope_mismatch');
  if(createHash('sha256').update(targetIds.join('|')).digest('hex')!==input.batch_key)failure('adoption_batch_key_mismatch');
  const messageIds=uniqueIds(messages.map((row:Row)=>row.message_id),60,'adoption_a_result_invalid');
  if(targetIds.some(id=>!messageIds.includes(id)))failure('adoption_a_result_invalid');
  for(const fact of input.a_result.accepted)if(!Array.isArray(fact.source_message_ids)
   ||fact.source_message_ids.some(id=>!messageIds.includes(String(id))))failure('adoption_a_result_invalid');
  const originals=(await client.query(`SELECT b.payload::text AS begun
   FROM public.memory_extraction_trace tr
   JOIN public.memory_extraction_trace_event b ON b.trace_id=tr.trace_id AND b.stage='typescript_a_begin'
   JOIN public.memory_extraction_trace_event r ON r.trace_id=tr.trace_id AND r.stage='typescript_a_result'
   WHERE tr.trace_id=$1 AND tr.owner_id=$2 AND tr.contact_id=$3 AND tr.batch_key=$4
   AND r.payload->'outcome'=$5::jsonb
   ORDER BY r.position DESC LIMIT 1`,
   [input.a_result.a_execution_id,input.owner_id,input.contact_id,input.batch_key,canonicalJSON(input.a_result)])).rows;
  if(originals.length!==1)failure('adoption_a_result_unavailable');
  const begun=parseStoredJSON(originals[0]!.begun);
  if(begun.execution_id!==input.a_result.a_execution_id||begun.input_sha256!==input.a_result.a_input_sha256
   ||begun.rule_version!==input.a_result.a_rule_version||begun.task_id!==input.claim.task_id)failure('adoption_a_result_mismatch');
  if(input.a_result.a_execution_id!==input.trace_id){
   const recovered=(await client.query(`SELECT 1 FROM public.memory_extraction_trace_event
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='typescript_a_recovered'
    AND payload->>'a_execution_id'=$4 AND payload->>'a_input_sha256'=$5 AND payload->>'a_rule_version'=$6`,
    [input.trace_id,input.owner_id,input.contact_id,input.a_result.a_execution_id,input.a_result.a_input_sha256,input.a_result.a_rule_version])).rowCount;
   if(recovered!==1)failure('adoption_a_result_unavailable');
  }
  const bExecutionId=uuidv5(`notalone:extraction_adoption:${input.a_result.a_execution_id}:${input.a_result.a_input_sha256}:${input.claim.task_id}:${input.batch_key}`);
  const resultRows=(await client.query(`SELECT payload::text AS payload FROM public.memory_extraction_trace_event
   WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='typescript_b_result'`,
   [input.trace_id,input.owner_id,input.contact_id])).rows;
  if(resultRows.length>1)failure('adoption_trace_state_invalid');
  if(resultRows.length){
   // B receipt 只含 UUID、计数和事件关联；普通 JSON 恢复可直接交给调用方协调。
   const receipt=JSON.parse(resultRows[0]!.payload).receipt;
   if(current.status!=='succeeded'||!validReceipt(receipt,input,bExecutionId))failure('adoption_trace_state_invalid');
   const ended=(await client.query(`SELECT 1 FROM public.memory_extraction_trace_event
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='batch_end'
    AND payload#>>'{typescript_b_receipt,b_execution_id}'=$4`,[input.trace_id,input.owner_id,input.contact_id,bExecutionId])).rowCount;
   if(ended!==1)failure('adoption_trace_state_invalid');
   const aReceipt={a_execution_id:receipt.a_execution_id,a_input_sha256:receipt.a_input_sha256,a_rule_version:receipt.a_rule_version};
   return {target_ids:targetIds,message_ids:messageIds,b_execution_id:bExecutionId,a_receipt:aReceipt,cached:{
    trace_id:input.trace_id,b_execution_id:bExecutionId,stats:receipt.stats,receipt,watermark:receipt.watermark_after,cached:true}};
  }
  if(current.status!=='running'||resultRows.length)failure('adoption_trace_state_invalid');
  const aReceipt={a_execution_id:input.a_result.a_execution_id,a_input_sha256:input.a_result.a_input_sha256,
   a_rule_version:input.a_result.a_rule_version};
  const prior=(await client.query(`SELECT e.trace_id,e.payload->'typescript_b_receipt' AS receipt,tr.status
   FROM public.memory_extraction_trace_event e
   JOIN public.memory_extraction_trace tr ON tr.trace_id=e.trace_id
    AND tr.owner_id=e.owner_id AND tr.contact_id=e.contact_id
   WHERE e.owner_id=$1 AND e.contact_id=$2 AND e.stage='batch_end'
    AND e.payload#>>'{typescript_a_receipt,a_execution_id}'=$3
   FOR UPDATE OF tr`,[input.owner_id,input.contact_id,input.a_result.a_execution_id])).rows;
  if(prior.length>1)failure('adoption_trace_state_invalid');
  if(prior.length===1){
   const sourceTrace=String(prior[0].trace_id),sourceReceipt=prior[0].receipt;
   if(prior[0].status!=='succeeded'||!uuid.test(sourceTrace)
    ||!validReceipt(sourceReceipt,input,bExecutionId,sourceTrace))failure('adoption_trace_state_invalid');
   const receipt={...sourceReceipt,trace_id:input.trace_id};
   if(!validReceipt(receipt,input,bExecutionId))failure('adoption_trace_state_invalid');
   if(writeBegin){
    const recovered=(await client.query(`SELECT payload::text AS payload
     FROM public.memory_extraction_trace_event
     WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='typescript_b_recovered'`,
     [input.trace_id,input.owner_id,input.contact_id])).rows;
    if(recovered.length>1||recovered.some(row=>{
      const value=parseStoredJSON(row.payload);
      return value.b_execution_id!==bExecutionId||value.source_trace_id!==sourceTrace;
    }))failure('adoption_trace_state_invalid');
    if(!recovered.length){
     await appendEvent(client,input,'typescript_b_recovered',{version:1,b_execution_id:bExecutionId,
      source_trace_id:sourceTrace,receipt});
     await appendEvent(client,input,'typescript_b_result',{receipt,recovered_from_trace_id:sourceTrace});
     await appendEvent(client,input,'batch_end',{extracted:receipt.accepted_count,rejected:receipt.rejected_count,
      adoption:receipt.stats,watermark_before:receipt.watermark_before,
      watermark_planned:receipt.watermark_planned,watermark_after:receipt.watermark_after,
      watermark_commit:'already_committed_with_trace',typescript_a_receipt:aReceipt,
      typescript_b_receipt:receipt,recovered_from_trace_id:sourceTrace});
    }
    const finished=await client.query(`UPDATE public.memory_extraction_trace
     SET status='succeeded',finished_at=now(),failure_stage=NULL,error_code=NULL
     WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND status='running'`,
     [input.trace_id,input.owner_id,input.contact_id]);
    if(finished.rowCount!==1)failure('adoption_trace_state_invalid');
   }
   return {target_ids:targetIds,message_ids:messageIds,b_execution_id:bExecutionId,a_receipt:aReceipt,cached:{
    trace_id:input.trace_id,b_execution_id:bExecutionId,stats:receipt.stats,receipt,
    watermark:receipt.watermark_after,cached:true}};
  }
  const begins=(await client.query(`SELECT payload::text AS payload FROM public.memory_extraction_trace_event
   WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND stage='typescript_b_begin'`,
   [input.trace_id,input.owner_id,input.contact_id])).rows;
  if(begins.length>1||begins.some(row=>parseStoredJSON(row.payload).b_execution_id!==bExecutionId))failure('adoption_trace_state_invalid');
  if(writeBegin&&!begins.length)await appendEvent(client,input,'typescript_b_begin',{version:1,b_execution_id:bExecutionId,
   a_receipt:aReceipt,candidate_trace_ids:input.a_result.candidate_trace_ids.map(id=>id.toLowerCase()),
   embedding:{model:this.options.embedding.model,revision:this.options.embedding.revision},purposes:purposeList});
  return {target_ids:targetIds,message_ids:messageIds,b_execution_id:bExecutionId,a_receipt:aReceipt,cached:null};
 }
 private async finalize(client:pg.PoolClient,input:ExtractionAdoptionInput,bExecutionId:string,stats:AdoptionStats,signal:AbortSignal):Promise<ExtractionAdoptionReceipt>{
  signal.throwIfAborted();
  const inspected=await this.inspect(client,input,false);
  if(inspected.cached)return inspected.cached.receipt;
  const targets=(await client.query(`SELECT x.message_id FROM public.memory_processing_target x
   WHERE x.task_id=$1 AND x.owner_id=$2 AND x.contact_id=$3 AND x.message_id=ANY($4::uuid[])`,
   [input.claim.task_id,input.owner_id,input.contact_id,inspected.target_ids])).rows;
  if(targets.length!==inspected.target_ids.length)failure('adoption_target_unavailable');
  const before=(await client.query('SELECT last_message_id FROM public.memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2',
   [input.owner_id,input.contact_id])).rows[0]?.last_message_id??null;
  await client.query(`INSERT INTO public.memory_processing_receipt(message_id,owner_id,contact_id,outcome)
   SELECT id,owner_id,contact_id,'succeeded' FROM public.message
   WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) ON CONFLICT DO NOTHING`,
   [input.owner_id,input.contact_id,inspected.target_ids]);
  const completed=(await client.query(`SELECT count(*)::int AS n FROM public.memory_processing_receipt
   WHERE owner_id=$1 AND contact_id=$2 AND message_id=ANY($3::uuid[]) AND outcome='succeeded'`,
   [input.owner_id,input.contact_id,inspected.target_ids])).rows[0]?.n;
  if(completed!==inspected.target_ids.length)failure('adoption_processing_receipt_conflict');
  await client.query(`UPDATE public.memory_processing_target x SET completed_at=r.completed_at,outcome=r.outcome
   FROM public.memory_processing_receipt r WHERE x.task_id=$1 AND x.owner_id=$2 AND x.contact_id=$3
   AND x.message_id=ANY($4::uuid[]) AND x.message_id=r.message_id AND x.owner_id=r.owner_id
   AND x.contact_id=r.contact_id AND x.completed_at IS NULL`,
   [input.claim.task_id,input.owner_id,input.contact_id,inspected.target_ids]);
  await client.query('UPDATE public.memory_processing_plan SET updated_at=now() WHERE task_id=$1',[input.claim.task_id]);
  const planned=inspected.target_ids.at(-1)!;
  await client.query(`INSERT INTO public.memory_extraction_watermark(owner_id,contact_id,last_message_id)
   VALUES($1,$2,(SELECT id FROM public.message WHERE id=$3 AND owner_id=$1 AND contact_id=$2 AND occurred_at IS NOT NULL))
   ON CONFLICT(owner_id,contact_id) DO UPDATE SET
    last_message_id=COALESCE(EXCLUDED.last_message_id,public.memory_extraction_watermark.last_message_id),
    failure_count=0,failure_code=NULL,failed_from_id=NULL,failed_to_id=NULL,updated_at=now()`,
   [input.owner_id,input.contact_id,planned]);
  const after=(await client.query('SELECT last_message_id FROM public.memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2',
   [input.owner_id,input.contact_id])).rows[0]?.last_message_id??null;
  for(const messageId of inspected.message_ids){
   await client.query(`INSERT INTO public.memory_extraction_trace_link
    (trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,commit_status,operation)
    VALUES($1,$2,$3,NULL,'message',$4,'committed','input')
    ON CONFLICT(trace_id,record_kind,record_id) DO UPDATE SET commit_status='committed',operation='input'`,
    [input.trace_id,input.owner_id,input.contact_id,messageId]);
   await client.query(`INSERT INTO public.memory_extraction_trace_dependency(trace_id,owner_id,contact_id,source_id)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[input.trace_id,input.owner_id,input.contact_id,messageId]);
  }
  const receipt:ExtractionAdoptionReceipt={version:1,b_execution_id:bExecutionId,trace_id:input.trace_id,
   ...inspected.a_receipt,candidate_trace_ids:input.a_result.candidate_trace_ids.map(id=>id.toLowerCase()),
   accepted_count:input.a_result.accepted.length,rejected_count:input.a_result.rejected_count,stats,
   watermark_before:before,watermark_planned:planned,watermark_after:after};
  await appendEvent(client,input,'typescript_b_result',{receipt});
  await appendEvent(client,input,'batch_end',{extracted:input.a_result.accepted.length,rejected:input.a_result.rejected_count,adoption:stats,
   watermark_before:before,watermark_planned:planned,watermark_after:after,watermark_commit:'committed_with_trace',
   typescript_a_receipt:inspected.a_receipt,typescript_b_receipt:receipt});
  const finished=await client.query(`UPDATE public.memory_extraction_trace SET status='succeeded',finished_at=now(),
   failure_stage=NULL,error_code=NULL WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND status='running'`,
   [input.trace_id,input.owner_id,input.contact_id]);
  if(finished.rowCount!==1)failure('adoption_trace_state_invalid');
  return receipt;
 }
}
