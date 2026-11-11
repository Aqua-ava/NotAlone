import {assertFrozenContent,contentRows} from './content.ts';
import { StorageFailure,type StorageTransaction,type StorageRow,type StorageLease } from '../../storage/sqlite/contracts.ts';
import { assertSourceEligibility,type SourceEligibility } from '../../history/sqlite/source.ts';
export const fail=(code:string):never=>{throw new StorageFailure(code);};
export const textId=(v:unknown):string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v)?v:fail('memory_extraction_input_invalid');
export function assertContribution(tx:StorageTransaction,ownerId:string,runId:string,contactId:string):void {
 const valid=tx.get(`SELECT rc.contact_id FROM run_contact rc
 JOIN contact c ON c.owner_id=rc.owner_id AND c.id=rc.contact_id
 JOIN owner o ON o.owner_id=c.owner_id
 JOIN read_grant g ON g.owner_id=rc.owner_id AND g.id=rc.grant_id AND g.contact_id=rc.contact_id
 JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
 JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id
 JOIN channel_conversation cv ON cv.owner_id=b.owner_id AND cv.id=b.conversation_id
 JOIN channel_account a ON a.owner_id=cv.owner_id AND a.id=cv.account_id
 WHERE rc.owner_id=? AND rc.run_id=? AND rc.contact_id=? AND rc.state='active'
 AND o.state='active' AND c.state='active' AND g.revoked_at IS NULL AND b.state='verified' AND a.identity_state='verified'
 AND c.selection_generation=rc.accepted_selection_generation AND g.selection_generation=c.selection_generation
 AND c.data_generation=rc.accepted_data_generation AND c.feedback_revision=rc.accepted_feedback_revision
 AND b.id=rc.binding_id AND b.identity_generation=rc.accepted_identity_generation AND v.identity_generation=b.identity_generation
 AND a.scope_revision=rc.accepted_account_revision AND a.source_generation=rc.accepted_source_generation`,[ownerId,runId,contactId]);
 if(!valid)fail('memory_extraction_scope_stale');
}
/** 复验任务冻结的完整贡献范围，不能用单条产物实际来源替代本人混合任务门禁。 */
export function assertTaskContributions(tx:StorageTransaction,ownerId:string,runId:string,taskId:string):void {
 const contributions=tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND run_id=? AND task_id=?',[ownerId,runId,taskId]);
 if(!contributions.length)fail('memory_extraction_scope_stale');
 for(const contribution of contributions)assertContribution(tx,ownerId,runId,String(contribution.source_contact_id));
}
export function inputRows(tx:StorageTransaction,ownerId:string,stepId:string):StorageRow[]{
 return contentRows(tx,ownerId,tx.all(`SELECT i.*,si.input_no AS planned_input_no,m.text_body,m.sender_role,m.sent_at,m.kind AS message_kind,m.display_no FROM step_input si
 JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 JOIN message m ON m.owner_id=i.owner_id AND m.contact_id=i.source_contact_id AND m.id=i.message_id
 WHERE si.owner_id=? AND si.step_id=? ORDER BY si.input_no`,[ownerId,stepId]));
}
export function assertInputs(tx:StorageTransaction,ownerId:string,runId:string,rows:StorageRow[],sourceEligibility:SourceEligibility=assertSourceEligibility):void {
 const r=tx.get('SELECT accepted_owner_feedback_revision FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 const o=tx.get("SELECT feedback_revision FROM owner WHERE owner_id=? AND state='active'",[ownerId]);
 if(!r||!o||r.accepted_owner_feedback_revision!==o.feedback_revision)fail('memory_extraction_scope_stale');
 for(const i of rows){
  assertContribution(tx,ownerId,runId,String(i.source_contact_id));
  sourceEligibility(tx,{owner_id:ownerId,contact_id:String(i.source_contact_id),record_id:String(i.record_id),message_id:String(i.message_id)});
  const m=tx.get("SELECT * FROM message WHERE owner_id=? AND contact_id=? AND id=? AND availability='available'",[ownerId,i.source_contact_id,i.message_id]);
  if(!m||m.interpretation_revision!==i.accepted_interpretation_revision)fail('memory_extraction_source_stale');
  assertFrozenContent(tx,ownerId,i,m!);
 }
}
export function currentAttempt(tx:StorageTransaction,ownerId:string,attemptId:string,lease:StorageLease):{attempt:StorageRow;task:StorageRow;rows:StorageRow[]} {
 const a=tx.get("SELECT * FROM step_attempt WHERE owner_id=? AND id=? AND state='running' AND runtime_token=?",[ownerId,attemptId,lease.runtimeId]);
 if(!a||BigInt(Date.now())>(a.lease_expires_at as bigint))return fail('memory_extraction_attempt_stale');
 const t=tx.get(`SELECT t.* FROM processing_task t JOIN processing_step s ON s.owner_id=t.owner_id AND s.task_id=t.id WHERE s.owner_id=? AND s.id=?`,[ownerId,a.step_id]);
 if(!t||t.state==='revoked'||a.accepted_control_revision!==t.control_revision)return fail('memory_extraction_attempt_stale');
 const rows=inputRows(tx,ownerId,String(a.step_id));assertInputs(tx,ownerId,String(t.run_id),rows);return {attempt:a,task:t,rows};
}
