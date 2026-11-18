import {registry as base} from '../../../src/storage/sqlite/registry.ts';

export const registry={
 ...base,
 actions:[...base.actions,{
  name:'fixture.laterScheduleHistory',mode:'read',retryBusy:false,execute(tx,input){
   return tx.all('SELECT generation,stage,state,due_at,error_code FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? ORDER BY generation',[input.ownerId,input.scopeKey]);
  }
 },{
  name:'fixture.laterRunState',mode:'read',retryBusy:false,execute(tx,input){
   return {run:tx.get('SELECT state,pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[input.ownerId,input.runId]),
    requirements:tx.all('SELECT q.scope_key,q.paused,q.outcome,s.state,s.stage FROM memory_document_later_run_requirement q JOIN memory_document_later_schedule s ON s.owner_id=q.owner_id AND s.scope_key=q.scope_key AND s.generation=q.generation WHERE q.owner_id=? AND q.run_id=?',[input.ownerId,input.runId])};
  }
 },{
  name:'fixture.laterScheduleFailure',mode:'write',retryBusy:false,execute(tx,input){
   if(!['failed','unknown'].includes(input.state))throw Error('合成队列状态无效');
   tx.run('UPDATE memory_document_later_schedule SET state=?,error_code=? WHERE owner_id=? AND scope_key=? AND state IN (\'scheduled\',\'failed\',\'unknown\')',[input.state,'synthetic_document_'+input.state,input.ownerId,input.scopeKey]);
  }
 }],
};
