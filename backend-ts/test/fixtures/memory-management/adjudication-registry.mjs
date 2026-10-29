import {registry as base} from './registry.mjs';

/** 只读观察正式流水线；候选、决定、版本、执行和账本均由生产动作写入。 */
export const registry={...base,actions:[...base.actions,{
 name:'fixture.adjudicationTrace',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  return {
   steps:tx.all("SELECT s.*,a.id AS attempt_id,a.state AS attempt_state,a.error_code FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id WHERE s.owner_id=? AND s.kind<>'extraction_verification' ORDER BY s.task_id,s.step_no",[ownerId]),
   calls:tx.all("SELECT c.*,o.purpose,o.state AS operation_state,o.commit_forbidden_at FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND o.purpose IN ('adjudication','relation_verification','merge_verification') ORDER BY c.rowid",[ownerId]).map(c=>({...c,receipt:c.receipt===null?null:JSON.parse(c.receipt)})),
   events:tx.all("SELECT e.*,s.kind AS step_kind FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND s.kind<>'extraction_verification' ORDER BY e.rowid",[ownerId]).map(e=>({...e,payload:JSON.parse(e.payload)})),
   inputs:tx.all("SELECT i.* FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id WHERE i.owner_id=? AND s.kind<>'extraction_verification' ORDER BY i.step_id,i.input_no",[ownerId]),
   eventInputs:tx.all("SELECT e.kind AS event_kind,i.event_id,i.input_no,i.planned_step_id,i.planned_input_no,s.kind,s.candidate_id,s.memory_id,s.source_contact_id,s.message_id,s.record_id FROM execution_input i JOIN execution_event e ON e.owner_id=i.owner_id AND e.id=i.event_id JOIN step_input s ON s.owner_id=i.owner_id AND s.step_id=i.planned_step_id AND s.input_no=i.planned_input_no WHERE i.owner_id=? AND e.kind IN ('adjudication_basis','adjudication_input','adjudication_output') ORDER BY i.event_id,i.input_no",[ownerId]),
   decisions:tx.all('SELECT * FROM memory_decision WHERE owner_id=? ORDER BY rowid',[ownerId]),
   memories:tx.all('SELECT * FROM memory WHERE owner_id=? ORDER BY id',[ownerId]),
  };
 },
}]};
