/** 原110物理调用和039批次关联恢复；清除窗口正文后仍使用原batch_key与input链接。 */
import type pg from 'pg';
import {modelTaskRequestId} from '../../host/host-model-accounting.ts';
import {ExtractionTaskError,type ExtractionScope,type ExtractionTaskStore} from './extraction-task-store.ts';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface UnsettledExtraction {direct:Set<string>;windows:Map<string,Set<string>>;}
async function unconfirmedARequests(c:pg.ClientBase,scope:ExtractionScope):Promise<Set<string>>{
 const tasks=(await c.query("SELECT id FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type IN ('import','observation')",[scope.ownerId,scope.contactId])).rows.map(r=>r.id as string);
 const rows=(await c.query(`SELECT tr.trace_id,tr.batch_key,e.stage,e.payload->>'execution_id' AS execution_id,
  e.payload->>'task_id' AS task_id,e.payload->>'request_id' AS request_id,e.payload->>'input_sha256' AS input_sha256,
  e.payload->>'rule_version' AS rule_version,e.payload#>>'{typescript_a_receipt,a_execution_id}' AS consumed_id,
  e.payload#>>'{typescript_a_receipt,a_input_sha256}' AS consumed_input,e.payload#>>'{typescript_a_receipt,a_rule_version}' AS consumed_rule,
  jsonb_typeof(e.payload->'outcome')='object' AS has_outcome,e.payload->>'a_execution_id' AS not_sent_id,
  e.payload->>'a_input_sha256' AS not_sent_input,e.payload->>'a_rule_version' AS not_sent_rule,e.payload->>'proof' AS not_sent_proof,
  e.payload->>'a_execution_id' AS superseded_id,e.payload->>'a_input_sha256' AS superseded_input,
  e.payload->>'a_rule_version' AS superseded_rule,tr.status AS trace_status,
  EXISTS(SELECT 1 FROM memory_extraction_trace_event end_event
   WHERE end_event.trace_id=tr.trace_id AND end_event.owner_id=tr.owner_id AND end_event.contact_id=tr.contact_id
   AND end_event.stage='batch_end' AND end_event.payload->>'watermark_commit'='not_advanced'
   AND end_event.payload->'watermark_before'=end_event.payload->'watermark_after'
   AND end_event.payload->'not_executed' @> '["remaining_write"]'::jsonb
   AND (tr.status='business_failed' OR NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event b_event
    WHERE b_event.trace_id=tr.trace_id AND b_event.stage='typescript_b_begin'))
   AND NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event receipt_event
    WHERE receipt_event.trace_id=tr.trace_id AND receipt_event.stage='batch_end'
    AND receipt_event.payload ? 'typescript_a_receipt')) AS no_write
  FROM memory_extraction_trace tr JOIN memory_extraction_trace_event e ON e.trace_id=tr.trace_id
   AND e.owner_id=tr.owner_id AND e.contact_id=tr.contact_id
  WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND e.stage IN ('typescript_a_begin','typescript_a_result','typescript_a_not_sent','typescript_a_superseded','batch_end')`,[scope.ownerId,scope.contactId])).rows;
 const completed=new Set(rows.filter(r=>r.stage==='typescript_a_result'&&r.has_outcome).map(r=>r.trace_id));
 const consumed=rows.filter(r=>r.stage==='batch_end'),consumedTraces=new Set<string>(),requests=new Set<string>();
 for(const row of rows){
  if(row.stage!=='typescript_a_begin')continue;
  if(consumed.some(r=>r.consumed_id===row.execution_id&&r.consumed_input===row.input_sha256&&r.consumed_rule===row.rule_version)
   ||rows.some(r=>r.stage==='typescript_a_superseded'&&r.superseded_id===row.execution_id
    &&r.superseded_input===row.input_sha256&&r.superseded_rule===row.rule_version)
   ||rows.some(r=>r.trace_id===row.trace_id&&r.no_write===true)
   ||rows.some(r=>r.trace_id===row.trace_id&&r.stage==='typescript_a_not_sent'&&['before_model_invocation','known_not_sent_receipts'].includes(r.not_sent_proof)
    &&r.not_sent_id===row.execution_id&&r.not_sent_input===row.input_sha256&&r.not_sent_rule===row.rule_version)){
   consumedTraces.add(row.trace_id);continue;
  }
  if(completed.has(row.trace_id))continue;
  if(tasks.includes(row.task_id)&&uuid.test(row.execution_id??'')&&row.request_id===modelTaskRequestId('extraction',row.task_id,row.batch_key))requests.add(row.request_id);
 }
 // 原正文已清时仍沿真实call/receipt身份恢复；known台账不能证明业务结果已消费。
 const erased=(await c.query(`SELECT DISTINCT tr.trace_id,tr.batch_key,r.request_id FROM memory_extraction_trace tr
  JOIN memory_extraction_trace_call call ON call.trace_id=tr.trace_id AND call.owner_id=tr.owner_id AND call.contact_id=tr.contact_id
  JOIN model_call_receipt r ON r.ledger_entry_id=call.ledger_entry_id AND r.owner_id=call.owner_id AND r.contact_id=call.contact_id
  WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND (call.provider_attempts>0 OR r.dispatch IN ('http_accepted','response_observed'))
  AND NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event e
   WHERE e.trace_id=tr.trace_id AND e.owner_id=tr.owner_id AND e.contact_id=tr.contact_id AND e.stage='window')`,[scope.ownerId,scope.contactId])).rows;
 for(const row of erased)if(!completed.has(row.trace_id)&&!consumedTraces.has(row.trace_id))for(const task of tasks)
  if(row.batch_key&&row.request_id===modelTaskRequestId('extraction',task,row.batch_key))requests.add(row.request_id);
 return requests;
}
export async function unsettledExtraction(store:ExtractionTaskStore,c:pg.ClientBase,scope:ExtractionScope):Promise<UnsettledExtraction>{
 const requests=new Set<string>((await c.query(`SELECT DISTINCT r.request_id FROM model_call_receipt r
  WHERE r.owner_id=$1 AND r.contact_id=$2 AND (r.outcome IN ('pending','unknown') OR EXISTS(
   SELECT 1 FROM memory_extraction_trace_call call WHERE call.owner_id=r.owner_id AND call.contact_id=r.contact_id
   AND call.ledger_entry_id=r.ledger_entry_id AND call.ledger_commit_status='unknown'))`,[scope.ownerId,scope.contactId])).rows.map(r=>r.request_id));
 for(const request of await unconfirmedARequests(c,scope))requests.add(request);
 if(store.options.unconfirmedRequests){try{
  const external=await store.options.unconfirmedRequests(scope);
  if(!Array.isArray(external)||external.some(v=>typeof v!=='string'||!uuid.test(v)))throw new Error('invalid');
  for(const request of external)requests.add(request);
 }catch{throw new ExtractionTaskError('model_accounting_recovery_unavailable');}}
 const direct=new Set<string>(),windows=new Map<string,Set<string>>();
 if(!requests.size)return {direct,windows};
 const tasks=(await c.query("SELECT id FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type IN ('import','observation')",[scope.ownerId,scope.contactId])).rows.map(r=>r.id as string);
 for(const task of tasks)if(requests.has(task))direct.add(task);
 const rows=(await c.query(`SELECT tr.trace_id,tr.batch_key,e.payload#>>'{task_runtime,task_id}' AS task_id,e.payload->'target_message_ids' AS ids
  FROM memory_extraction_trace tr JOIN memory_extraction_trace_event e ON e.trace_id=tr.trace_id
   AND e.owner_id=tr.owner_id AND e.contact_id=tr.contact_id
  WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND e.stage='window'`,[scope.ownerId,scope.contactId])).rows;
 function add(task:string,ids:string[]){const set=windows.get(task)??new Set<string>();for(const id of ids)set.add(id);windows.set(task,set);}
 for(const row of rows)if(typeof row.task_id==='string'&&tasks.includes(row.task_id)&&Array.isArray(row.ids)&&row.ids.every((v:unknown)=>typeof v==='string'&&uuid.test(v))&&requests.has(modelTaskRequestId('extraction',row.task_id,row.batch_key)))add(row.task_id,row.ids);
 const erased=(await c.query(`SELECT tr.trace_id,tr.batch_key FROM memory_extraction_trace tr WHERE tr.owner_id=$1 AND tr.contact_id=$2
  AND NOT EXISTS(SELECT 1 FROM memory_extraction_trace_event e WHERE e.trace_id=tr.trace_id AND e.owner_id=tr.owner_id AND e.contact_id=tr.contact_id AND e.stage='window')`,[scope.ownerId,scope.contactId])).rows;
 for(const row of erased)for(const task of tasks)if(row.batch_key&&requests.has(modelTaskRequestId('extraction',task,row.batch_key))){
  const links=(await c.query(`SELECT l.record_id FROM memory_extraction_trace_link l JOIN memory_processing_target x
   ON x.message_id=l.record_id AND x.owner_id=l.owner_id AND x.contact_id=l.contact_id AND x.task_id=$4
   WHERE l.trace_id=$1 AND l.owner_id=$2 AND l.contact_id=$3 AND l.record_kind='message' AND l.operation='input' AND l.commit_status='committed'`,[row.trace_id,scope.ownerId,scope.contactId,task])).rows;
  add(task,links.map(r=>r.record_id));
 }
 return {direct,windows};
}
export async function quarantineExtraction(c:pg.ClientBase,scope:ExtractionScope,taskId:string,ids:Set<string>):Promise<void>{
 if(!ids.size)return;
 await c.query(`INSERT INTO memory_processing_receipt(message_id,owner_id,contact_id,outcome)
  SELECT x.message_id,x.owner_id,x.contact_id,'unknown' FROM memory_processing_target x
  WHERE x.task_id=$1 AND x.owner_id=$2 AND x.contact_id=$3 AND x.completed_at IS NULL AND x.message_id=ANY($4::uuid[]) ON CONFLICT DO NOTHING`,[taskId,scope.ownerId,scope.contactId,[...ids]]);
 await c.query(`UPDATE memory_processing_target x SET completed_at=r.completed_at,outcome=r.outcome FROM memory_processing_receipt r
  WHERE x.task_id=$1 AND x.owner_id=$2 AND x.contact_id=$3 AND x.message_id=ANY($4::uuid[]) AND x.completed_at IS NULL
  AND r.message_id=x.message_id AND r.owner_id=x.owner_id AND r.contact_id=x.contact_id`,[taskId,scope.ownerId,scope.contactId,[...ids]]);
}
export async function blockedExtraction(c:pg.ClientBase,unsettled:UnsettledExtraction,taskId:string,allowFresh:boolean):Promise<boolean>{
 if(unsettled.direct.has(taskId))return true;
 const ids=unsettled.windows.get(taskId);if(!ids)return false;
 if(!allowFresh||!ids.size)return true;
 return !(await c.query('SELECT 1 FROM memory_processing_target WHERE task_id=$1 AND completed_at IS NULL AND NOT(message_id=ANY($2::uuid[])) LIMIT 1',[taskId,[...ids]])).rowCount;
}
