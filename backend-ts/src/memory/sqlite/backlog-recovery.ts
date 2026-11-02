import type {StorageAction,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {fail,textId} from './qualification.ts';
import {applyControl} from './control.ts';

/** 已知L1失败仅自动重试一次；明确的应用中断可安全续跑，用户暂停与未决模型调用保持原样。 */
export function recoverableBacklogRuns(tx:StorageTransaction,ownerId:string):{runId:string;controlVersion:number}[]{
 const rows=tx.all(`SELECT r.id,r.intent_revision FROM processing_run r
  WHERE r.owner_id=? AND r.state IN ('failed','incomplete') AND r.pause_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM processing_run next WHERE next.owner_id=r.owner_id AND next.start_request_key='policy-recovery:'||r.id)
   AND EXISTS(SELECT 1 FROM processing_task t WHERE t.owner_id=r.owner_id AND t.run_id=r.id AND t.state='failed'
     AND (t.error_code='memory_extraction_interrupted' OR t.resume_no=0 AND (t.error_code='history_source_not_available' OR (t.error_code LIKE 'extraction_%' OR t.error_code LIKE 'memory_extraction_%') AND EXISTS(SELECT 1 FROM processing_step s WHERE s.owner_id=t.owner_id AND s.task_id=t.id AND s.kind='extraction_verification' AND s.state='failed'))))
   AND NOT EXISTS(SELECT 1 FROM processing_task t WHERE t.owner_id=r.owner_id AND t.run_id=r.id AND (t.state IN ('paused','unknown','running') OR t.resume_no>0 AND t.state='failed' AND coalesce(t.error_code,'')<>'memory_extraction_interrupted'))
   AND NOT EXISTS(SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE t.owner_id=r.owner_id AND t.run_id=r.id AND s.state IN ('unknown','running'))
   AND NOT EXISTS(SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
    JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE t.owner_id=r.owner_id AND t.run_id=r.id AND c.state IN ('unknown','prepared','sending'))
   AND NOT EXISTS(SELECT 1 FROM model_operation o JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id
    JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE t.owner_id=r.owner_id AND t.run_id=r.id AND o.state IN ('prepared','in_flight','unknown'))
   AND NOT EXISTS(SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
    JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE t.owner_id=r.owner_id AND t.run_id=r.id AND c.state='pending')
   AND NOT EXISTS(SELECT 1 FROM run_contact own JOIN run_contact other ON other.owner_id=own.owner_id AND other.contact_id=own.contact_id
    JOIN processing_run active ON active.owner_id=other.owner_id AND active.id=other.run_id
    WHERE own.owner_id=r.owner_id AND own.run_id=r.id AND other.run_id<>r.id AND active.state IN ('preparing','pending','running'))
  ORDER BY r.started_at,r.rowid`,[ownerId]);
 return rows.map(row=>{
  const version=Number(row.intent_revision);if(!Number.isSafeInteger(version)||version<0)fail('memory_extraction_count_invalid');
  return {runId:String(row.id),controlVersion:version};
 });
}
export function backlogRunRecoverable(tx:StorageTransaction,ownerId:string,runId:string):boolean{
 return recoverableBacklogRuns(tx,ownerId).some(run=>run.runId===runId);
}
export const backlogRecoveryActions:StorageAction[]=[{
 name:'memoryExtraction.recoverableBacklog',mode:'read',retryBusy:false,execute(tx,raw){
  const input=raw as {ownerId:string};return recoverableBacklogRuns(tx,textId(input.ownerId));
 }
},{
 name:'memoryExtraction.autoContinue',mode:'write',retryBusy:true,execute(tx,raw){
  const input=raw as {ownerId:string;runId:string;controlVersion:number},ownerId=textId(input.ownerId),runId=textId(input.runId);
  // 扫描与领取之间可能发生暂停、决定或模型回执变化；与continue在同一写事务内复验。
  if(!backlogRunRecoverable(tx,ownerId,runId))return null;
  return applyControl(tx,{ownerId,runId,action:'continue',actionVersion:input.controlVersion});
 }
}];
