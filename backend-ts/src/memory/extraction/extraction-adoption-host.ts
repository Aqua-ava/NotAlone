/** 将 B 段裁决接到共享 ModelHost；每次物理调用独立许可、回执和 trace 关联。 */
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {
  ExtractionAdoptionService,
  type ExtractionAdoptionInput,
  type ExtractionAdoptionModelCallInput,
  type ExtractionAdoptionModelCallPort,
  type ExtractionAdoptionResult,
} from './extraction-adoption-service.ts';
import type {ExtractionBatchWireOutcome} from './extraction-batch-service.ts';
import type {ExtractionModelInput} from './extraction-model.ts';
import type {ExtractionTaskStore} from './extraction-task-store.ts';
import {createLocalEmbeddingLifecycle} from '../../platform/models/local-embedding-lifecycle.ts';
import {EMBEDDING_MODEL,EMBEDDING_REVISION} from '../../retrieval/retrieval-embedding.ts';
import type {ModelLedgerReceipt} from '../../platform/models/model-ledger.ts';
import type {MessagesBudgetBinding,MessagesBudgetProfile} from '../../platform/models/model-input-budget.ts';

type Transaction=<T>(work:(client:pg.Client)=>Promise<T>)=>Promise<T>;
export interface ExtractionAdoptionHostOptions {
  ownerId:string;
  taskStore:ExtractionTaskStore;
  transaction:Transaction;
  call(input:ExtractionModelInput):Promise<{
    text:string;
    blocks:readonly unknown[];
    receipt?:ModelLedgerReceipt;
  }>;
  binding:MessagesBudgetBinding;
  profile:MessagesBudgetProfile;
  embeddingFactory?:Parameters<typeof createLocalEmbeddingLifecycle>[0];
}

/** A 失败不进入 B；A 成功（包括零候选）由调用方取得唯一 finalized 回执。 */
export async function runExtractionWithAdoption(
  batches:{run(input:Omit<ExtractionAdoptionInput,'a_result'>,signal:AbortSignal):Promise<ExtractionBatchWireOutcome>},
  adoption:Pick<ReturnType<typeof createExtractionAdoptionHost>,'run'>,
  input:Omit<ExtractionAdoptionInput,'a_result'>,
  signal:AbortSignal,
):Promise<{outcome:ExtractionBatchWireOutcome;adoption:ExtractionAdoptionResult|null}> {
  const outcome=await batches.run(input,signal);
  if(!outcome.extraction_completed||outcome.failure_reason!==null)return {outcome,adoption:null};
  return {outcome,adoption:await adoption.run(input,outcome,signal)};
}

export function createExtractionAdoptionHost(options:ExtractionAdoptionHostOptions){
  const embedding=createLocalEmbeddingLifecycle(options.embeddingFactory);
  const callAdoptionModel=async(request:ExtractionAdoptionModelCallInput)=>{
    const callId=randomUUID();
    const recordReceipt=async(receipt:ModelLedgerReceipt,committed:boolean)=>{
      await options.transaction(async client=>{
        if(!(await client.query('SELECT 1 FROM memory_extraction_trace WHERE trace_id=$1 AND owner_id=$2 AND contact_id=$3',
          [request.trace_id,request.owner_id,request.contact_id])).rowCount)return;
        await client.query(`INSERT INTO memory_extraction_trace_call
          (call_id,trace_id,owner_id,contact_id,purpose,called_at,finished_at,response_status,
           provider_attempts,ledger_entry_id,ledger_commit_status,disposition)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'consumed')
          ON CONFLICT(call_id) DO UPDATE SET
           ledger_commit_status=CASE WHEN memory_extraction_trace_call.ledger_commit_status='committed'
            THEN 'committed' ELSE EXCLUDED.ledger_commit_status END`,
        [callId,request.trace_id,request.owner_id,request.contact_id,request.purpose,receipt.called_at,
         new Date().toISOString(),receipt.outcome==='succeeded'||receipt.legacy_outcome==='rejected_by_validation'?'returned':
          receipt.dispatch==='response_observed'?'received':'unavailable',
         ['response_observed','http_accepted'].includes(receipt.dispatch)?1:0,
         receipt.ledger_entry_id??receipt.attempt_id,committed?'committed':'unknown']);
      });
    };
    const requireCurrent=()=>options.taskStore.check({ownerId:request.owner_id,contactId:request.contact_id,
      taskId:request.claim.task_id,stepId:request.claim.step_id,stepName:request.claim.step_name,
      workerId:request.claim.worker_id,leaseGeneration:request.claim.lease_generation,attemptCount:0,
      messageCount:0,sourceDocumentId:null,taskType:'import',leaseExpiresAt:new Date(0),runtimeConfig:null});
    const title=request.schema.title;
    if(typeof title!=='string'||!title.trim())throw new Error('adjudication_schema_invalid');
    try{
      const result=await options.call({owner_id:request.owner_id,contact_id:request.contact_id,claim:request.claim,
        request_id:request.request_id,attempt_id:randomUUID(),ledger_entry_id:randomUUID(),
        binding:options.binding,profile:options.profile,system:request.system,
        messages:[{role:'user',content:[{type:'text',text:request.user}]}],
        tools:[{name:title,description:'提交严格结构化核验结果',parameters:request.schema}],
        signal:request.signal,requireCurrent,validateOutput:request.validateOutput,
        onReceipt:receipt=>recordReceipt(receipt,true)});
      if(!result.receipt)throw new Error('adjudication_receipt_missing');
      return {blocks:result.blocks,usage:{call_id:callId,model_name:result.receipt.model,
        input_tokens:result.receipt.usage?.input_tokens??null,
        output_tokens:result.receipt.usage?.output_tokens??null,purpose:request.purpose}};
    }catch(error){
      const receipt=(error as {receipt?:ModelLedgerReceipt}).receipt;
      if(receipt)await recordReceipt(receipt,false);
      throw error;
    }
  };
  const port:ExtractionAdoptionModelCallPort={call:callAdoptionModel};
  const service=new ExtractionAdoptionService({ownerId:options.ownerId,taskStore:options.taskStore,
    adjudicationPort:port,embedding:{model:EMBEDDING_MODEL,revision:EMBEDDING_REVISION,embed:embedding.embed}});
  return {
    run(input:Omit<ExtractionAdoptionInput,'a_result'>,aResult:ExtractionBatchWireOutcome,
      signal:AbortSignal):Promise<ExtractionAdoptionResult>{
      return service.run({...input,a_result:aResult},signal);
    },
    close:()=>embedding.close(),
  };
}
