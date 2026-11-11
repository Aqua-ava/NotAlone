import {randomUUID} from 'node:crypto';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {currentSourceScopeCTE} from '../../../src/history/sqlite/current-scope.ts';
import {pendingMemoryInputStats,readScheduleInputRows,scheduleInputAvailability,withScheduleInputStats} from '../../../src/memory/sqlite/schedule-inputs.ts';

export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'scheduleInputs.inspect',mode:'read',retryBusy:false,execute(tx,input){
  let queries=0,sourceQueries=0,bodyRows=0;const began=performance.now();
  const count=(sql,rows)=>{queries++;if(sql.includes('schedule_candidate_messages'))sourceQueries++;bodyRows+=rows.filter(row=>Object.hasOwn(row,'text_body')).length;return rows;};
  const measured={run:tx.run,all:(sql,values)=>count(sql,tx.all(sql,values)),get:(sql,values)=>count(sql,[input.baseline!==undefined&&sql==='SELECT memory_incremental_baseline_display_no AS n FROM database_instance WHERE slot=1'?{n:input.baseline}:tx.get(sql,values)].filter(Boolean))[0]};
  return withScheduleInputStats(measured,()=>{
   const options={ownerId:input.ownerId,contactId:input.contactId,scopeCte:currentSourceScopeCTE,sourceOrder:'capture.acceptance_no,capture.captured_at,capture.rowid,source.item_no,source.id'};
   const metadata=input.metadata?readScheduleInputRows(measured,{...options,pendingOnly:false}):[];
   const availableBefore=input.availability==='all-first'?scheduleInputAvailability(measured,{...options,pendingOnly:false}):null;
   const history=pendingMemoryInputStats(measured,{...options,history:true}),incremental=pendingMemoryInputStats(measured,{...options,history:false});
   const available=input.availability?(availableBefore??scheduleInputAvailability(measured,{...options,pendingOnly:false})):null;
   return {history,incremental,queries,sourceQueries,bodyRows,availableCount:available?.size??null,elapsedMs:performance.now()-began,metadata:metadata.map(row=>({id:row.id,kind:row.kind,display_no:row.display_no,record_id:row.record_id,extraction_state:row.extraction_state,target_assigned:row.target_assigned}))};
  });
 }},
 {name:'scheduleInputs.change',mode:'write',retryBusy:false,execute(tx,input){
  for(const proof of input.proofs??[]){
   const source=tx.get("SELECT * FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' AND availability='available' LIMIT 1",[input.ownerId,input.contactId,proof.messageId]);
   const row={...source,id:proof.id,availability:proof.availability,capture_id:source.capture_id,item_no:tx.get('SELECT max(item_no)+1 AS n FROM capture_record WHERE owner_id=? AND capture_id=?',[input.ownerId,source.capture_id]).n};
   const columns=Object.keys(row);tx.run(`INSERT INTO capture_record(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,columns.map(column=>row[column]));
  }
  if(input.assign){
   const token=input.token,runId=randomUUID();
   tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'preparing',1,0,'{}')",[input.ownerId,runId,randomUUID()]);
   tx.run("INSERT INTO run_contact VALUES(?,?,?,?,?,?,?,?,?,?,?,'active')",[input.ownerId,runId,input.contactId,token.grant_id,token.binding_id,BigInt(token.selection_generation),BigInt(token.data_generation),BigInt(token.identity_generation),BigInt(token.scope_revision),token.source_generation,0]);
   for(let index=0;index<input.assign.length;index++){
    const messageId=input.assign[index],itemId=randomUUID(),source=tx.get("SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state='normalized' AND availability='available' LIMIT 1",[input.ownerId,input.contactId,messageId]);
    tx.run("INSERT INTO processing_item VALUES(?,?,?,?,'memory_extraction','pending','pending',NULL)",[input.ownerId,itemId,input.contactId,messageId]);
    tx.run("INSERT INTO run_input VALUES(?,?,?,'target','message',?,?,?,?,1)",[input.ownerId,runId,index,input.contactId,itemId,messageId,source.id]);
   }
   tx.run("UPDATE processing_run SET state='pending' WHERE owner_id=? AND id=?",[input.ownerId,runId]);
  }
  if(input.releaseAssigned)tx.run("UPDATE processing_run SET state='failed' WHERE owner_id=? AND id IN (SELECT run_id FROM run_contact WHERE owner_id=? AND contact_id=?)",[input.ownerId,input.ownerId,input.contactId]);
  if(input.sourceRemoved){
   // 重见消息的普通同步会去重；此处显式保留第二份合法来源以核验首次可用来源的切换。
   const source=tx.get('SELECT * FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND state=\'normalized\' LIMIT 1',[input.ownerId,input.contactId,input.sourceRemoved]);
   const capture=tx.get("SELECT c.id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE g.owner_id=? AND g.contact_id=? AND g.kind='incremental' ORDER BY c.acceptance_no DESC LIMIT 1",[input.ownerId,input.contactId]);
   const row={...source,id:randomUUID(),capture_id:capture.id,item_no:tx.get('SELECT coalesce(max(item_no),-1)+1 AS n FROM capture_record WHERE owner_id=? AND capture_id=?',[input.ownerId,capture.id]).n};
   const columns=Object.keys(row);tx.run(`INSERT INTO capture_record(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,columns.map(column=>row[column]));
   tx.run(`UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND message_id=?
    AND capture_id IN (SELECT c.id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE g.owner_id=? AND g.kind='history')`,[input.ownerId,input.contactId,input.sourceRemoved,input.ownerId]);
  }
  if(input.sourceChanged){
   const previous=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' ORDER BY creation_no DESC LIMIT 1",[input.ownerId,input.contactId]);
   const row={...previous,id:randomUUID(),target_json:JSON.stringify({...JSON.parse(previous.target_json),sourceGeneration:'obsolete'}),creation_no:tx.get('SELECT max(creation_no)+1 AS n FROM read_goal').n};
   const columns=Object.keys(row);tx.run(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,columns.map(column=>row[column]));
  }
  if(input.quarantine)tx.run("INSERT INTO history_message_quarantine VALUES(?,?,?,'合成隔离')",[input.ownerId,input.contactId,input.quarantine]);
  for(const row of input.states??[]){const existing=tx.get("SELECT id FROM processing_item WHERE owner_id=? AND contact_id=? AND message_id=? AND purpose='memory_extraction'",[input.ownerId,input.contactId,row.id]);
   if(existing)tx.run('UPDATE processing_item SET extraction_state=? WHERE owner_id=? AND id=?',[row.state,input.ownerId,existing.id]);
   else tx.run("INSERT INTO processing_item VALUES(?,?,?,?,'memory_extraction',?,'pending',NULL)",[input.ownerId,randomUUID(),input.contactId,row.id,row.state]);
  }
  return true;
 }},
]};
