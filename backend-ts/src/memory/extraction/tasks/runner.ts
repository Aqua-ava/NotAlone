/** 原任务级提取编排：Worker只给租约，本模块独占分批、A/B、trace与处理回执。 */
import {randomUUID} from 'node:crypto';
import {resolveExtractionPolicy,type ExtractionPolicyVersion} from '../policy-version.ts';
import type pg from 'pg';
import {canonicalJSON,digest} from '../../overview/evidence/sources.ts';
import {
 freezeExtractionSources,
 loadExtractionSourceMessages,
 type ScopedExtractionMessage,
} from '../sources.ts';
import type {ExtractionBatchWireOutcome} from '../service.ts';
import {
 planExtractionBatches,
 runExtractionPipeline,
 type ExtractionBatch,
} from './pipeline.ts';
import type {ExtractionClaim,ExtractionTaskStore} from './store.ts';
import type {ExtractionWorkerResult,ExtractionWorkerRunner} from './worker.ts';

export interface ExtractionTaskAdoptionResult {watermark:string|null}
export interface ExtractionTaskRunnerOptions {
 store:Pick<ExtractionTaskStore,'targets'|'fenced'|'check'>;
 batches:{run(input:{
  owner_id:string;contact_id:string;trace_id:string;batch_key:string;
  claim:{task_id:string;step_id:string;step_name:'extract_memory';worker_id:string;lease_generation:number};
 },signal:AbortSignal):Promise<ExtractionBatchWireOutcome>};
 adopt(
  input:{
   owner_id:string;contact_id:string;trace_id:string;batch_key:string;
   claim:{task_id:string;step_id:string;step_name:'extract_memory';worker_id:string;lease_generation:number};
  },
  outcome:ExtractionBatchWireOutcome,
  signal:AbortSignal,
 ):Promise<ExtractionTaskAdoptionResult>;
 batchSize?:number;
 contextBefore?:number;
 contextAfter?:number;
 concurrency?:number;
 ruleVersion?:string;
 policyVersion?:ExtractionPolicyVersion;
 provider?:string;
 modelName?:string;
}

type Attempt={traceId:string;outcome:ExtractionBatchWireOutcome};
type Plan=ExtractionBatch<ScopedExtractionMessage>;

export class ExtractionTaskRunnerError extends Error {
 readonly code:string;
 readonly retryable:boolean;
 constructor(code:string,retryable=false){super(code);this.code=code;this.retryable=retryable;this.name='ExtractionTaskRunnerError';}
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value:unknown):value is Record<string,unknown>{
 return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
}
function tracePayload(value:unknown,ruleVersion:string):Record<string,unknown>{
 const body=record(value)?value:{value};
 const now=new Date().toISOString();
 return {...body,_execution:{kind:'snapshot_capture',started_at:now,finished_at:now,status:'recorded',
  rule_version:ruleVersion,payload_sha256:digest(body)}};
}
function claimIdentity(claim:ExtractionClaim){
 return {task_id:claim.taskId,step_id:claim.stepId,step_name:'extract_memory' as const,
  worker_id:claim.workerId,lease_generation:claim.leaseGeneration};
}
async function appendTraceEvent(
 client:pg.ClientBase,claim:ExtractionClaim,traceId:string,stage:string,
 payload:unknown,ruleVersion:string,
):Promise<void>{
 await client.query(`INSERT INTO public.memory_extraction_trace_event
  (event_id,trace_id,owner_id,contact_id,position,stage,payload)
  SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,$5,$6::jsonb
  FROM public.memory_extraction_trace_event WHERE trace_id=$2`,
 [randomUUID(),traceId,claim.ownerId,claim.contactId,stage,canonicalJSON(tracePayload(payload,ruleVersion))]);
}
export class ExtractionTaskRunner implements ExtractionWorkerRunner {
 private readonly options:ExtractionTaskRunnerOptions;
 constructor(options:ExtractionTaskRunnerOptions){
  if(!options.store||!options.batches||typeof options.adopt!=='function')
   throw new ExtractionTaskRunnerError('extraction_task_runner_configuration_invalid');
  this.options=options;
 }

 async run(claim:ExtractionClaim,signal:AbortSignal):Promise<ExtractionWorkerResult>{
  if(claim.stepName!=='extract_memory')throw new ExtractionTaskRunnerError('extraction_task_step_invalid');
  if(claim.contactId===null)throw new ExtractionTaskRunnerError('extraction_task_scope_invalid');
  const contactId=claim.contactId;
  const runId=randomUUID(),ruleVersion=(this.options.policyVersion?.resolve(claim.runtimeConfig)
   ??resolveExtractionPolicy(claim.runtimeConfig,this.options.ruleVersion??'typescript-extraction-v1')).ruleVersion;
  let processed=0;
  while(true){
   signal.throwIfAborted();
   const targetState=await this.options.store.targets(claim);
   if(!targetState.targetIds.length)break;
   const snapshots=await this.options.store.fenced(claim,async client=>{
    const ids=targetState.contextIds.length?targetState.contextIds:targetState.targetIds;
    if(!targetState.targetIds.every(id=>ids.includes(id)))
     throw new ExtractionTaskRunnerError('extraction_task_targets_invalid');
    const messages=await loadExtractionSourceMessages(client,{
     ownerId:claim.ownerId,contactId,
    },ids);
    const watermark=(await client.query(`SELECT last_message_id FROM public.memory_extraction_watermark
     WHERE owner_id=$1 AND contact_id=$2`,[claim.ownerId,contactId])).rows[0]?.last_message_id??null;
    return {messages,watermark};
   });
   const plans=planExtractionBatches({
    scope:{owner_id:claim.ownerId,contact_id:contactId},
    messages:snapshots.messages,
    target_message_ids:targetState.targetIds,
    initial_watermark:snapshots.watermark,
    batch_size:this.options.batchSize,
    context_before:this.options.contextBefore,
    context_after:this.options.contextAfter,
   });
   const attempt=new Map<number,string>();
   let failureCode:string|undefined;
   const result=await runExtractionPipeline<ScopedExtractionMessage,Attempt>({
    plans,
    concurrency:this.options.concurrency??1,
    signal,
    requireCurrent:async()=>{await this.options.store.check(claim);},
    extract:async(plan,batchSignal)=>{
     const traceId=await this.beginTrace(claim,plan,runId,ruleVersion);
     attempt.set(plan.index,traceId);
     try{
      const outcome=await this.options.batches.run({
       owner_id:claim.ownerId,contact_id:contactId,
       trace_id:traceId,batch_key:plan.batch_key,claim:claimIdentity(claim),
      },batchSignal);
      return {traceId,outcome};
     }catch(error){
      const cancelled=signal.aborted;
      try{
       await this.finishFailure(claim,traceId,ruleVersion,
        cancelled?'stopped':'trace_failed',cancelled?'cancelled':errorCode(error),
        plan.previous_watermark);
      }finally{attempt.delete(plan.index);}
      throw error;
     }
    },
    commit:async(plan,value,commitSignal)=>{
     if(value.outcome.failure_reason!==null||!value.outcome.extraction_completed){
      failureCode=value.outcome.failure_kind??'model_failed';
      try{
       await this.finishFailure(claim,value.traceId,ruleVersion,'model_failed',
        failureCode,plan.previous_watermark);
      }finally{attempt.delete(plan.index);}
      return {status:'model_failed',watermark:plan.previous_watermark,processed_messages:plan.target_count};
     }
     let adopted;
     try{
      adopted=await this.options.adopt({
       owner_id:claim.ownerId,contact_id:contactId,
       trace_id:value.traceId,batch_key:plan.batch_key,claim:claimIdentity(claim),
      },value.outcome,commitSignal);
     }catch(error){
      const cancelled=signal.aborted;
      try{
       await this.finishFailure(claim,value.traceId,ruleVersion,
        cancelled?'stopped':'business_failed',
        cancelled?'cancelled':errorCode(error),plan.previous_watermark,
        cancelled?undefined:['remaining_write']);
      }finally{attempt.delete(plan.index);}
      throw error;
     }
     attempt.delete(plan.index);
     return {status:'succeeded',watermark:adopted.watermark,processed_messages:plan.target_count};
    },
    stopped:async(plan,watermark,reason)=>{
     const traceId=attempt.get(plan.index);
     attempt.delete(plan.index);
     if(traceId)await this.finishFailure(claim,traceId,ruleVersion,'stopped',reason,watermark);
    },
   });
   if(result.status!=='succeeded'){
    if(signal.aborted)signal.throwIfAborted();
    throw new ExtractionTaskRunnerError(failureCode??'extraction_task_not_completed',true);
   }
   if(result.processed_messages<1)throw new ExtractionTaskRunnerError('extraction_task_progress_missing');
   processed+=result.processed_messages;
  }
  return {processedCount:processed,totalCount:processed||claim.messageCount};
 }

 private async beginTrace(
  claim:ExtractionClaim,plan:Plan,runId:string,ruleVersion:string,
 ):Promise<string>{
  if(claim.contactId===null)throw new ExtractionTaskRunnerError('extraction_task_scope_invalid');
  const contactId=claim.contactId;
  return this.options.store.fenced(claim,async client=>{
   const targets=plan.window.target_message_ids;
   const selected=new Set(targets);
   const context=plan.window.messages.map(message=>message.message_id).filter(id=>!selected.has(id));
   const frozen=await freezeExtractionSources(client,{
    ownerId:claim.ownerId,contactId,
   },{target_message_ids:[...targets],context_message_ids:context});
   if(canonicalJSON(frozen.messages.map(message=>message.message_id))
    !==canonicalJSON(plan.window.messages.map(message=>message.message_id)))
    throw new ExtractionTaskRunnerError('extraction_task_sources_changed');
   const traceId=randomUUID();
   const previous=(await client.query(`SELECT trace_id FROM public.memory_extraction_trace
    WHERE owner_id=$1 AND contact_id=$2 AND batch_key=$3 ORDER BY started_at DESC LIMIT 1`,
   [claim.ownerId,claim.contactId,plan.batch_key])).rows[0]?.trace_id??null;
   await client.query(`INSERT INTO public.memory_extraction_trace
    (trace_id,owner_id,contact_id,run_id,batch_key,retry_of)
    VALUES($1,$2,$3,$4,$5,$6)`,
   [traceId,claim.ownerId,claim.contactId,runId,plan.batch_key,previous]);
   const runtime={...claimIdentity(claim),mode:String(claim.runtimeConfig?.mode??'legacy'),
    config_version:claim.runtimeConfig?.version??null,
    rule_set_sha256:claim.runtimeConfig?.rule_set_sha256??null,
    ...(claim.runtimeConfig?.version===2?{verification_policy:claim.runtimeConfig.verification_policy,
     source_stamp:claim.runtimeConfig.source_stamp,rule_version:ruleVersion}:{})};
   const firstTarget=plan.window.messages.findIndex(message=>selected.has(message.message_id));
   const lastTarget=plan.window.messages.findLastIndex(message=>selected.has(message.message_id));
   const windowMessages=plan.window.messages.map((message,index)=>({
    message_id:message.message_id,text:message.text,sender:message.sender,occurred_at:message.occurred_at,
    source_snapshots:message.source_snapshots,message_type:message.message_snapshot?.message_type,
    text_representation:message.text_representation,message_snapshot:message.message_snapshot,
    role:selected.has(message.message_id)?'target':index<firstTarget?'context_before':'context_after',
   }));
   const windowPayload={
    task_runtime:runtime,
    messages:windowMessages,
    target_count:targets.length,
    context_before_count:firstTarget,
    context_after_count:plan.window.messages.length-lastTarget-1,
    target_message_ids:[...targets],
    watermark_before:plan.previous_watermark,
    watermark_planned:plan.next_watermark,
    configuration:{
     batch_size:this.options.batchSize??10,context_before:this.options.contextBefore??5,
     context_after:this.options.contextAfter??0,
     provider:this.options.provider??'typescript',model_name:this.options.modelName??'unknown',
    },
    sources_status:frozen.messages.every(message=>message.source_snapshots?.every(source=>source.processing_status==='recorded'))
     ?'recorded':'processing_missing',
    versions:{trace_schema:1,command:ruleVersion,flow:ruleVersion,adoption:ruleVersion},
    selection_receipts:[],
   };
   await appendTraceEvent(client,claim,traceId,'window',windowPayload,ruleVersion);
   for(const message of frozen.messages){
    await client.query(`INSERT INTO public.memory_extraction_trace_link
     (trace_id,owner_id,contact_id,record_kind,record_id,commit_status,operation)
     VALUES($1,$2,$3,'message',$4,'committed','input') ON CONFLICT DO NOTHING`,
    [traceId,claim.ownerId,claim.contactId,message.message_id]);
   }
   const dependencies=new Set<string>(frozen.messages.map(message=>message.message_id));
   for(const message of frozen.messages)for(const source of message.source_snapshots??[]){
    if(typeof source.source_id==='string'&&uuid.test(source.source_id))dependencies.add(source.source_id);
    const processor=source.processing_record;
    if(record(processor)&&typeof processor.batch_id==='string'&&uuid.test(processor.batch_id))
     dependencies.add(processor.batch_id);
   }
   for(const sourceId of dependencies){
    await client.query(`INSERT INTO public.memory_extraction_trace_dependency
     (trace_id,owner_id,contact_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [traceId,claim.ownerId,claim.contactId,sourceId]);
   }
   return traceId;
  });
 }

 private async finishFailure(
  claim:ExtractionClaim,traceId:string,ruleVersion:string,
  status:'trace_failed'|'model_failed'|'business_failed'|'stopped',error:string,
  watermark:string|null,notExecuted:readonly string[]=['remaining_adoption','remaining_write'],
 ):Promise<void>{
  await this.options.store.fenced(claim,async client=>{
   await appendTraceEvent(client,claim,traceId,'batch_end',{
    error_code:error,watermark_before:watermark,watermark_after:watermark,
    watermark_commit:'not_advanced',not_executed:[...notExecuted],
   },ruleVersion);
   const updated=await client.query(`UPDATE public.memory_extraction_trace
    SET status=$4,finished_at=now(),failure_stage='batch_end',error_code=$5
    WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3 AND status='running'`,
   [traceId,claim.ownerId,claim.contactId,status,error]);
   if(updated.rowCount!==1)throw new ExtractionTaskRunnerError('extraction_trace_finish_invalid');
  });
 }
}

function errorCode(error:unknown):string{
 const code=record(error)&&typeof error.code==='string'?error.code:'trace_failed';
 return /^[a-z][a-z0-9_]{0,63}$/.test(code)?code:'trace_failed';
}
