import {registry as base} from '../history/recertify-registry.mjs';
export const registry={...base,actions:[...base.actions,{
 name:'fixture.memoryRawControl',mode:'read',retryBusy:false,execute(tx,i){
  return {run:tx.get('SELECT state,pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[i.ownerId,i.runId]),
   steps:tx.all('SELECT s.state FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? ORDER BY s.rowid',[i.ownerId,i.runId]),
   calls:tx.all('SELECT c.state FROM model_call c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? ORDER BY c.rowid',[i.ownerId,i.runId])};
 }
}]};
