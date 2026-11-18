import {registry as base} from '../../../src/storage/sqlite/registry.ts';
/** 仅用于在真实 SQLite/动作边界制造租约与进程重启时序；不替代控制事务本身。 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.stalePolicy',mode:'write',retryBusy:true,execute(tx,input){tx.run("UPDATE processing_run SET policy_config=json_set(policy_config,'$.source_stamp',?) WHERE owner_id=? AND id=?",['a'.repeat(64),input.ownerId,input.runId]);return true;}},
 {name:'fixture.messages',mode:'read',retryBusy:false,execute(tx,input){return tx.all(`SELECT m.id,m.text_body,m.availability,m.kind,r.id AS record_id,r.state AS record_state,r.availability AS record_availability,p.extraction_state FROM message m LEFT JOIN capture_record r ON r.owner_id=m.owner_id AND r.message_id=m.id LEFT JOIN processing_item p ON p.owner_id=m.owner_id AND p.message_id=m.id AND p.purpose='memory_extraction' WHERE m.owner_id=? AND m.contact_id=? ORDER BY m.display_no`,[input.ownerId,input.contactId]);}},
 {name:'fixture.processingRun',mode:'read',retryBusy:false,execute(tx,input){return tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[input.ownerId,input.runId]);}},
 {name:'fixture.processingTasks',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[input.ownerId,input.runId]);}},
 {name:'fixture.steps',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT * FROM processing_step WHERE owner_id=? AND task_id=? ORDER BY step_no',[input.ownerId,input.taskId]);}},
 {name:'fixture.attempts',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT * FROM step_attempt WHERE owner_id=? AND step_id IN (SELECT id FROM processing_step WHERE owner_id=? AND task_id=?) ORDER BY attempt_no',[input.ownerId,input.ownerId,input.taskId]);}},
 {name:'fixture.modelCalls',mode:'read',retryBusy:false,execute(tx,input){return tx.all(`SELECT c.*,o.purpose AS purpose FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
  JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? ORDER BY c.attempt_no`,[input.ownerId,input.runId]);}},
 {name:'fixture.runInputs',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=? ORDER BY input_no',[input.ownerId,input.runId]);}},
 {name:'fixture.expireAttempt',mode:'write',retryBusy:true,execute(tx,input){tx.run('UPDATE step_attempt SET lease_expires_at=? WHERE owner_id=? AND id=?',[Date.now()-1000,input.ownerId,input.attemptId]);return input.attemptId;}},
 {name:'fixture.setRuntimeToken',mode:'write',retryBusy:true,execute(tx,input){tx.run('UPDATE step_attempt SET runtime_token=? WHERE owner_id=? AND id=?',[input.token,input.ownerId,input.attemptId]);return input.attemptId;}},
 {name:'fixture.ownerReadEnabled',mode:'read',retryBusy:false,execute(tx,input){return tx.get('SELECT read_enabled FROM owner WHERE owner_id=?',[input.ownerId])?.read_enabled===1n;}},
]};
