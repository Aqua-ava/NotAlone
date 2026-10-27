/** 仅从真实记忆任务、批次与回执关联恢复调用身份；独立回复和 Skill 不属于此集合。 */
import type pg from 'pg';
import {modelTaskRequestId} from '../../host/host-model-accounting.ts';
import type {TaskScope} from '../../tasks/task-control.ts';

export async function memoryModelRequestIds(c:pg.ClientBase,scope:TaskScope,tasks:readonly {id:string;task_type:string}[]):Promise<Set<string>>{
 const requests=new Set(tasks.filter(task=>task.task_type==='layered_memory').map(task=>task.id));
 const extraction=tasks.filter(task=>['import','observation'].includes(task.task_type)).map(task=>task.id);
 if(scope.contactId===null||!extraction.length)return requests;
 // 与预约资格一致：A 使用冻结批次键，B 使用同批次合法候选索引，不读取消息或候选正文。
 const batches=(await c.query(`SELECT DISTINCT trace.batch_key,source_window.payload#>>'{task_runtime,task_id}' AS task_id,
  (SELECT jsonb_array_length(result.payload#>'{outcome,accepted}') FROM memory_extraction_trace_event result
   WHERE result.trace_id=trace.trace_id AND result.stage='typescript_a_result'
    AND jsonb_typeof(result.payload#>'{outcome,accepted}')='array' ORDER BY result.position DESC LIMIT 1) AS accepted_count
  FROM memory_extraction_trace trace JOIN memory_extraction_trace_event source_window ON source_window.trace_id=trace.trace_id
   AND source_window.owner_id=trace.owner_id AND source_window.contact_id=trace.contact_id AND source_window.stage='window'
  WHERE trace.owner_id=$1 AND trace.contact_id=$2 AND source_window.payload#>>'{task_runtime,task_id}'=ANY($3::text[])`,[scope.ownerId,scope.contactId,extraction])).rows;
 for(const batch of batches){
  if(typeof batch.batch_key!=='string'||!/^[a-f0-9]{64}$/.test(batch.batch_key))continue;
  requests.add(modelTaskRequestId('extraction',batch.task_id,batch.batch_key));
  const accepted=Number(batch.accepted_count);
  if(batch.accepted_count===null||!Number.isSafeInteger(accepted)||accepted<0||accepted>100)continue;
  requests.add(modelTaskRequestId('adjudication',batch.task_id,`${batch.batch_key}:batch`));
  requests.add(modelTaskRequestId('relation_verification',batch.task_id,`${batch.batch_key}:batch`));
  for(let index=0;index<accepted;index++)requests.add(modelTaskRequestId('merge_verification',batch.task_id,`${batch.batch_key}:${index}`));
 }
 // 正文擦除后的最小 input 关联仍可证明回执用途；不靠任意 request 字符串猜测来源。
 const recorded=(await c.query(`SELECT DISTINCT receipt.request_id FROM memory_extraction_trace_call call
  JOIN model_call_receipt receipt ON receipt.ledger_entry_id=call.ledger_entry_id
   AND receipt.owner_id=call.owner_id AND receipt.contact_id=call.contact_id
  WHERE call.owner_id=$1 AND call.contact_id=$2 AND (EXISTS(SELECT 1 FROM memory_extraction_trace_event source_window
   WHERE source_window.trace_id=call.trace_id AND source_window.stage='window' AND source_window.payload#>>'{task_runtime,task_id}'=ANY($3::text[]))
   OR EXISTS(SELECT 1 FROM memory_extraction_trace_link link JOIN memory_processing_target target ON target.message_id=link.record_id
    AND target.owner_id=link.owner_id AND target.contact_id=link.contact_id WHERE link.trace_id=call.trace_id
    AND link.record_kind='message' AND link.operation='input' AND link.commit_status='committed' AND target.task_id=ANY($3::uuid[])))`,[scope.ownerId,scope.contactId,extraction])).rows;
 for(const row of recorded)requests.add(row.request_id);
 return requests;
}
