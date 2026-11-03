/** 正式profile停止后只读核对统一台账，不替换业务写入或制造成功记录。 */
import {registry as base} from '../../src/storage/sqlite/registry.ts';
export const registry={...base,actions:[...base.actions,{name:'fixture.replyBackgroundConcurrencyEvidence',mode:'read',retryBusy:false,execute(tx,{ownerId}){
 return tx.all(`SELECT c.id,c.state,c.settlement_state,c.receipt,c.provider,c.model,o.purpose,
  coalesce(r.contact_id,t.contact_id) AS contact_id,c.reply_attempt_id,c.step_attempt_id FROM model_call c
  JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
  LEFT JOIN reply_request r ON r.owner_id=o.owner_id AND r.id=o.reply_request_id
  LEFT JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id
  LEFT JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE c.owner_id=?`,[ownerId]).map(row=>({
   id:String(row.id),state:String(row.state),settlement:String(row.settlement_state),purpose:String(row.purpose),provider:String(row.provider),model:String(row.model),contactId:String(row.contact_id),replyAttemptId:row.reply_attempt_id,stepAttemptId:row.step_attempt_id,receipt:JSON.parse(String(row.receipt))}));
}}]};
