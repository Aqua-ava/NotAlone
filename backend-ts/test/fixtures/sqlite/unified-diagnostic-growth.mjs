import {randomUUID} from 'node:crypto';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {observedProcessingAction} from '../../../src/memory/sqlite/diagnostics.ts';
const control=observedProcessingAction({name:'memoryExtraction.control',mode:'write',retryBusy:false,execute(tx,input){
 tx.run("UPDATE processing_run SET state='paused' WHERE owner_id=? AND id=?",[input.ownerId,input.runId]);
 tx.run("UPDATE processing_task SET state='paused' WHERE owner_id=? AND run_id=?",[input.ownerId,input.runId]);return true;
}});
export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'fixture.growthPrepare',mode:'write',retryBusy:false,execute(tx,input){
  const sample=tx.get('SELECT * FROM contact WHERE owner_id=? AND id=?',[input.ownerId,input.contactId]),columns=Object.keys(sample),runId=randomUUID();
  tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'running',?,0,'{}')",[input.ownerId,runId,randomUUID(),Date.now()]);
  for(let n=0;n<input.count;n++){const contactId=n?randomUUID():input.contactId;if(n)tx.run(`INSERT INTO contact(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,columns.map(key=>key==='id'?contactId:sample[key]));
   tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state) VALUES(?,?,?,'contact',?,'running')",[input.ownerId,randomUUID(),runId,contactId]);}
  return {runId};
 }},
 {name:'fixture.growthControl',mode:'write',retryBusy:false,execute(tx,input){let generated=0;const value=control.execute({...tx,recordUnifiedDiagnostic(event){generated++;tx.recordUnifiedDiagnostic?.(event);}},input);return {generated,value};}},
]};
