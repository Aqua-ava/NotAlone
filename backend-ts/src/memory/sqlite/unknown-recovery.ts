/** 裁决类未知回执的用户放弃重试：只处理 adjudication / relation_verification / merge_verification，不清账、不重发原请求。 */
import {randomUUID} from 'node:crypto';
import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {fail,textId} from './qualification.ts';
import {laterStagesState as scheduledLaterStagesState} from './documents/later-schedule.ts';

const family="('adjudication','relation_verification','merge_verification')";
const unknownSignal=`(s.state='unknown'
 OR EXISTS(SELECT 1 FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id AND a.state='unknown')
 OR EXISTS(SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE o.owner_id=s.owner_id AND o.memory_step_id=s.id AND c.state='unknown'))`;

/** 本轮未撤销任务中带 unknown 迹象的步骤；inFamily 区分裁决类与其他用途。 */
function unknownSteps(tx:StorageTransaction,ownerId:string,runId:string,inFamily:boolean):StorageRow[]{
 return tx.all(`SELECT s.id,s.task_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND t.state<>'revoked' AND s.kind ${inFamily?'':'NOT '}IN ${family} AND ${unknownSignal}`,[ownerId,runId]);
}
/** 只有未知全部来自裁决类步骤时才可放弃：提取核验、任务级及文档阶段的未知保持原有保守口径。 */
export function abandonableUnknown(tx:StorageTransaction,ownerId:string,runId:string):boolean{
 if(!unknownSteps(tx,ownerId,runId,true).length)return false;
 if(unknownSteps(tx,ownerId,runId,false).length)return false;
 if(tx.get("SELECT 1 FROM processing_task WHERE owner_id=? AND run_id=? AND state='unknown' LIMIT 1",[ownerId,runId]))return false;
 const later=scheduledLaterStagesState(tx,ownerId,runId);
 return !(later&&later.state==='unknown'&&later.reasons.includes('document_call_unknown'));
}
/**
 * 用户明确放弃未知裁决调用：调用记为 failed（unknown_abandoned），但 settlement_state 与回执保持 unknown，
 * 成本仍按未知核算；占位释放后才能重新裁决。裁决阶段只在成功输出后写业务数据，重发不会产生重复写入。
 */
export function abandonUnknownAdjudication(tx:StorageTransaction,input:{ownerId:string;runId:string;actionVersion?:number;operationId?:string}):{abandoned:number;callIds:string[]}{
 const ownerId=textId(input.ownerId),runId=textId(input.runId);
 const run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);if(!run)fail('memory_extraction_not_found');
 if(!Number.isSafeInteger(input.actionVersion)||(input.actionVersion as number)<0)fail('memory_extraction_input_invalid');
 if(input.operationId!==undefined&&typeof input.operationId!=='string')fail('memory_extraction_input_invalid');
 if(BigInt(input.actionVersion as number)!==(run!.intent_revision as bigint))fail('memory_extraction_control_conflict');
 if(['revoked','completed','preparing'].includes(String(run!.state))||!abandonableUnknown(tx,ownerId,runId))fail('memory_extraction_control_conflict');
 const callIds:string[]=[],now=Date.now();
 for(const step of unknownSteps(tx,ownerId,runId,true)){
  const stepId=String(step.id);
  const calls=tx.all("SELECT c.id,c.step_attempt_id FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE o.owner_id=? AND o.memory_step_id=? AND c.state='unknown'",[ownerId,stepId]);
  tx.run("UPDATE model_call SET state='failed',error_code='unknown_abandoned' WHERE owner_id=? AND state='unknown' AND id IN (SELECT c.id FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE o.owner_id=? AND o.memory_step_id=?)",[ownerId,ownerId,stepId]);
  tx.run("UPDATE model_operation SET state='failed' WHERE owner_id=? AND memory_step_id=? AND state='unknown'",[ownerId,stepId]);
  for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND state='unknown' AND operation_id IN (SELECT id FROM model_operation WHERE owner_id=? AND memory_step_id=?)`,[ownerId,ownerId,stepId]);
  for(const attempt of tx.all("SELECT id FROM step_attempt WHERE owner_id=? AND step_id=? AND state='unknown'",[ownerId,stepId])){
   const attemptCalls=calls.filter(call=>String(call.step_attempt_id)===String(attempt.id)).map(call=>String(call.id));
   const eventNo=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attempt.id])!.n;
   tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',
    [ownerId,randomUUID(),attempt.id,eventNo,'adjudication_unknown_abandoned',JSON.stringify({actor:'user',call_ids:attemptCalls,...(input.operationId?{operation_id:input.operationId}:{})}),now]);
   tx.run("UPDATE step_attempt SET state='failed',error_code='unknown_abandoned' WHERE owner_id=? AND id=?",[ownerId,attempt.id]);
  }
  tx.run("UPDATE processing_step SET state='failed' WHERE owner_id=? AND id=? AND state='unknown'",[ownerId,stepId]);
  callIds.push(...calls.map(call=>String(call.id)));
 }
 return {abandoned:callIds.length,callIds};
}
