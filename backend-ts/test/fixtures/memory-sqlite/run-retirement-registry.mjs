import {registry as base} from '../memory-documents/later-schedule-registry.mjs';
import {retireStalePausedRuns} from '../../../src/memory/sqlite/run-retirement.ts';
export const registry={...base,actions:[...base.actions,
 {name:'fixture.retireStaleRuns',mode:'write',retryBusy:false,execute(tx,input){return retireStalePausedRuns(tx,input.ownerId,input.now);}},
 {name:'fixture.stalePausedRun',mode:'write',retryBusy:false,execute(tx,input){
  tx.run("UPDATE processing_run SET state='paused',pause_requested_at=1 WHERE owner_id=? AND id=?",[input.ownerId,input.runId]);
  if(input.hold){const call=tx.get('SELECT c.id FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? LIMIT 1',[input.ownerId,input.runId]);
   tx.run('UPDATE model_call SET state=?,settlement_state=? WHERE owner_id=? AND id=?',[input.hold.state,input.hold.settlement,input.ownerId,call.id]);}
  if(input.stale!==false)tx.run('UPDATE contact SET feedback_revision=feedback_revision+1 WHERE owner_id=? AND id=?',[input.ownerId,input.contactId]);
  return true;
 }},
]};
