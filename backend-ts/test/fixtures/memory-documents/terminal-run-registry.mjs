import {registry as base} from './later-schedule-registry.mjs';
export const registry={...base,actions:[...base.actions,{
 name:'fixture.terminalRunState',mode:'read',retryBusy:false,execute(tx,input){
  return {run:tx.get('SELECT state,pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[input.ownerId,input.runId]),
   steps:tx.all('SELECT s.state,count(*) n FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? GROUP BY s.state',[input.ownerId,input.runId]),
   publications:tx.get('SELECT count(*) n FROM document_publication WHERE owner_id=? AND run_id=?',[input.ownerId,input.runId])};
 }
},{
 name:'fixture.legacyTerminalRunning',mode:'write',retryBusy:false,execute(tx,input){
  tx.run("UPDATE processing_run SET state='running' WHERE owner_id=? AND id=? AND state IN ('running','failed','incomplete')",[input.ownerId,input.runId]);
 }
}]};
