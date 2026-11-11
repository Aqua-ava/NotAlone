import {registry as base} from '../memory-documents/later-schedule-registry.mjs';
import {retireStalePausedRuns} from '../../../src/memory/sqlite/run-retirement.ts';
import {assertInputs} from '../../../src/memory/sqlite/qualification.ts';
export const registry={...base,actions:[...base.actions,
 {name:'fixture.retireStaleRuns',mode:'write',retryBusy:false,execute(tx,input){return retireStalePausedRuns(tx,input.ownerId,input.now);}},
 {name:'fixture.stalePausedRun',mode:'write',retryBusy:false,execute(tx,input){
  tx.run("UPDATE processing_run SET state='paused',pause_requested_at=1 WHERE owner_id=? AND id=?",[input.ownerId,input.runId]);
  if(input.hold){const call=tx.get('SELECT c.id FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? LIMIT 1',[input.ownerId,input.runId]);
   tx.run('UPDATE model_call SET state=?,settlement_state=? WHERE owner_id=? AND id=?',[input.hold.state,input.hold.settlement,input.ownerId,call.id]);}
  if(input.stale!==false)tx.run('UPDATE contact SET feedback_revision=feedback_revision+1 WHERE owner_id=? AND id=?',[input.ownerId,input.contactId]);
  if(input.ownerFeedbackStale)tx.run('UPDATE owner SET feedback_revision=feedback_revision+1 WHERE owner_id=?',[input.ownerId]);
  return true;
 }},
 {name:'fixture.assertRunInputs',mode:'read',execute(tx,input){assertInputs(tx,input.ownerId,input.runId,tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=?',[input.ownerId,input.runId]));return true;}},
 {name:'fixture.runSuccessfulHistory',mode:'read',execute(tx,input){return {
  steps:tx.all("SELECT s.id,s.state,s.successful_attempt_id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? AND s.state='succeeded' ORDER BY s.id",[input.ownerId,input.runId]),
  attempts:tx.all("SELECT a.id,a.state,a.finished_at FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? AND a.state='succeeded' ORDER BY a.id",[input.ownerId,input.runId]),
 };}},
]};
