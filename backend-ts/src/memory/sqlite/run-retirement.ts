import {recordProcessingRunChange} from './diagnostics.ts';
import {assertContribution,assertInputs} from './qualification.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';

/** 同一运行的完整调用链；执行或结算尚未知时绝不因运行主状态释放目标。 */
function unsettledRunSql(run:string):string {
 return `(EXISTS(SELECT 1 FROM processing_task held_unknown_task WHERE held_unknown_task.owner_id=${run}.owner_id AND held_unknown_task.run_id=${run}.id AND held_unknown_task.state='unknown')
  OR EXISTS(SELECT 1 FROM processing_task held_task JOIN processing_step held_step ON held_step.owner_id=held_task.owner_id AND held_step.task_id=held_task.id
  LEFT JOIN step_attempt held_attempt ON held_attempt.owner_id=held_step.owner_id AND held_attempt.step_id=held_step.id
  LEFT JOIN model_operation held_operation ON held_operation.owner_id=held_step.owner_id AND held_operation.memory_step_id=held_step.id
  LEFT JOIN model_call held_call ON held_call.owner_id=held_operation.owner_id AND held_call.operation_id=held_operation.id
  WHERE held_task.owner_id=${run}.owner_id AND held_task.run_id=${run}.id
   AND (held_step.state IN ('running','unknown') OR held_attempt.state IN ('running','unknown')
    OR held_operation.state IN ('prepared','in_flight','unknown') OR held_call.state IN ('prepared','sending','unknown') OR held_call.settlement_state IN ('reserved','unknown'))))`;
}
function occupiedRunSql(run:string):string {
 return `EXISTS(SELECT 1 FROM processing_task occupied_task JOIN processing_step occupied_step ON occupied_step.owner_id=occupied_task.owner_id AND occupied_step.task_id=occupied_task.id
  JOIN model_operation occupied_operation ON occupied_operation.owner_id=occupied_step.owner_id AND occupied_operation.memory_step_id=occupied_step.id
  WHERE occupied_task.owner_id=${run}.owner_id AND occupied_task.run_id=${run}.id AND (
   EXISTS(SELECT 1 FROM operation_item occupied_item WHERE occupied_item.owner_id=occupied_operation.owner_id AND occupied_item.operation_id=occupied_operation.id AND occupied_item.state IN ('reserved','sent','unknown'))
   OR EXISTS(SELECT 1 FROM operation_scope occupied_scope WHERE occupied_scope.owner_id=occupied_operation.owner_id AND occupied_scope.operation_id=occupied_operation.id AND occupied_scope.state IN ('reserved','sent','unknown'))))`;
}
function pendingCandidateSql(run:string):string {
 return `EXISTS(SELECT 1 FROM processing_task candidate_task JOIN processing_step candidate_step ON candidate_step.owner_id=candidate_task.owner_id AND candidate_step.task_id=candidate_task.id
  JOIN step_attempt candidate_attempt ON candidate_attempt.owner_id=candidate_step.owner_id AND candidate_attempt.step_id=candidate_step.id
  JOIN memory_candidate held_candidate ON held_candidate.owner_id=candidate_attempt.owner_id AND held_candidate.produced_attempt_id=candidate_attempt.id
  WHERE candidate_task.owner_id=${run}.owner_id AND candidate_task.run_id=${run}.id AND held_candidate.state='pending')`;
}
export function releasedRunSql(run:string):string {
 return `(${run}.state IN ('failed','revoked','completed') AND NOT ${unsettledRunSql(run)} AND NOT ${occupiedRunSql(run)} AND NOT ${pendingCandidateSql(run)})`;
}
/** 统计与领取共用一次物化的运行集合，避免逐消息重复扫描同一运行的调用链。 */
export function assignedRunItemsCte(name:'current_assigned_items'|'schedule_assigned_items'):string {
 return `${name}_runs AS MATERIALIZED (
  SELECT held_run.owner_id,held_run.id,held_contact.contact_id FROM run_contact held_contact JOIN processing_run held_run ON held_run.owner_id=held_contact.owner_id AND held_run.id=held_contact.run_id
  WHERE held_contact.owner_id=? AND held_contact.contact_id=? AND NOT ${releasedRunSql('held_run')}
 ),${name} AS MATERIALIZED (
  SELECT DISTINCT held_input.item_id FROM ${name}_runs held_run JOIN run_input held_input ON held_input.owner_id=held_run.owner_id AND held_input.run_id=held_run.id AND held_input.source_contact_id=held_run.contact_id
  WHERE held_input.role='target' AND held_input.item_id IS NOT NULL
 )`;
}
/** 只读判定：终态且无候选门、未知调用或效果占位，才不再占用联系人。 */
export function runTargetsReleased(tx:StorageTransaction,ownerId:string,runId:string):boolean {
 return !!tx.get(`SELECT 1 FROM processing_run released_run WHERE released_run.owner_id=? AND released_run.id=? AND ${releasedRunSql('released_run')}`,[ownerId,runId]);
}

/** 只退休范围代次已永久失配的暂停轮；每次最多处理128轮，真实调用/候选未知时保持原状。 */
export function retireStalePausedRuns(tx:StorageTransaction,ownerId:string,now=Date.now()):number {
 const hasLater=!!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_document_later_run_requirement'");
 const staleOwnerScope=`NOT EXISTS(SELECT 1 FROM owner current_owner WHERE current_owner.owner_id=retiring_run.owner_id
  AND current_owner.state='active' AND current_owner.feedback_revision=retiring_run.accepted_owner_feedback_revision)`;
 const staleScope=`EXISTS(SELECT 1 FROM run_contact old_contact WHERE old_contact.owner_id=retiring_run.owner_id AND old_contact.run_id=retiring_run.id AND NOT EXISTS(
  SELECT 1 FROM contact c JOIN owner o ON o.owner_id=c.owner_id JOIN read_grant g ON g.owner_id=c.owner_id AND g.id=old_contact.grant_id AND g.contact_id=c.id
  JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id
  JOIN channel_conversation cv ON cv.owner_id=b.owner_id AND cv.id=b.conversation_id JOIN channel_account a ON a.owner_id=cv.owner_id AND a.id=cv.account_id
  WHERE c.owner_id=old_contact.owner_id AND c.id=old_contact.contact_id AND old_contact.state='active'
   AND o.state='active' AND c.state='active' AND g.revoked_at IS NULL AND b.state='verified' AND a.identity_state='verified'
   AND c.selection_generation=old_contact.accepted_selection_generation AND g.selection_generation=c.selection_generation
   AND c.data_generation=old_contact.accepted_data_generation AND c.feedback_revision=old_contact.accepted_feedback_revision
   AND b.id=old_contact.binding_id AND b.identity_generation=old_contact.accepted_identity_generation AND v.identity_generation=b.identity_generation
   AND a.scope_revision=old_contact.accepted_account_revision AND a.source_generation=old_contact.accepted_source_generation))`;
 const laterUnsettled=hasLater?`AND NOT EXISTS(SELECT 1 FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule later ON later.owner_id=q.owner_id AND later.scope_key=q.scope_key AND later.generation=q.generation
  WHERE q.owner_id=retiring_run.owner_id AND q.run_id=retiring_run.id AND (q.outcome='unknown' OR later.state IN ('unknown','running')))` :'';
 const rows=tx.all(`SELECT retiring_run.id,retiring_run.state FROM processing_run retiring_run WHERE retiring_run.owner_id=? AND (retiring_run.state='paused' OR retiring_run.pause_requested_at IS NOT NULL)
  AND (${staleScope} OR ${staleOwnerScope}) AND NOT ${unsettledRunSql('retiring_run')} AND NOT ${pendingCandidateSql('retiring_run')} ${laterUnsettled}
  AND NOT EXISTS(SELECT 1 FROM model_operation o JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   WHERE t.owner_id=retiring_run.owner_id AND t.run_id=retiring_run.id AND (
    EXISTS(SELECT 1 FROM operation_item i WHERE i.owner_id=o.owner_id AND i.operation_id=o.id AND i.state IN ('reserved','unknown'))
    OR EXISTS(SELECT 1 FROM operation_scope scope WHERE scope.owner_id=o.owner_id AND scope.operation_id=o.id AND scope.state IN ('reserved','unknown'))))
  ORDER BY retiring_run.started_at,retiring_run.id LIMIT 128`,[ownerId]);
 let retired=0;
 for(const row of rows){
  const runId=String(row.id),contacts=tx.all('SELECT contact_id FROM run_contact WHERE owner_id=? AND run_id=?',[ownerId,runId]);let stale=false;
  // 空输入只复验owner快照，与正常assertInputs保持同一永久失配判定。
  try{assertInputs(tx,ownerId,runId,[]);}catch(error){if(!(error instanceof StorageFailure)||error.code!=='memory_extraction_scope_stale')throw error;stale=true;}
  for(const contact of contacts)try{assertContribution(tx,ownerId,runId,String(contact.contact_id));}catch(error){if(!(error instanceof StorageFailure)||error.code!=='memory_extraction_scope_stale')throw error;stale=true;}
  if(!stale)continue;
  // 成功步骤和原始失败事实保留；已知但尚未提交的效果不再占用后续运行。
  for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id IN (
   SELECT o.id FROM model_operation o JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?)`,[ownerId,ownerId,runId]);
  tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=coalesce(commit_forbidden_at,?) WHERE owner_id=? AND memory_step_id IN (SELECT s.id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?) AND state<>'applied'",[now,ownerId,ownerId,runId]);
  tx.run("UPDATE processing_step SET state='revoked' WHERE owner_id=? AND task_id IN (SELECT id FROM processing_task WHERE owner_id=? AND run_id=?) AND state IN ('pending','failed')",[ownerId,ownerId,runId]);
  tx.run("UPDATE processing_task SET state='revoked',control_revision=control_revision+1,error_code='memory_extraction_scope_stale' WHERE owner_id=? AND run_id=? AND state NOT IN ('succeeded','awaiting_decision','revoked')",[ownerId,runId]);
  tx.run("UPDATE run_contact SET state='revoked' WHERE owner_id=? AND run_id=?",[ownerId,runId]);
  if(hasLater)tx.run("UPDATE memory_document_later_run_requirement SET outcome='revoked',paused=0,reason='memory_extraction_scope_stale',updated_at=? WHERE owner_id=? AND run_id=? AND outcome IN ('pending','failed')",[now,ownerId,runId]);
  tx.run("UPDATE processing_run SET state='revoked',pause_requested_at=NULL,intent_revision=intent_revision+1 WHERE owner_id=? AND id=?",[ownerId,runId]);
  recordProcessingRunChange(tx,runId,String(row.state),'revoked','source_changed');retired++;
 }
 return retired;
}
