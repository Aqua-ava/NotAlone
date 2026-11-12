import {registry as base} from './unknown-registry.mjs';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {memoryBasis} from '../../../src/memory/sqlite/documents/basis.ts';
import {memoryDocumentsPublicationActions} from '../../../src/memory/sqlite/documents/publication.ts';

const original=(tx,ownerId,taskId)=>tx.get(`SELECT a.* FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 WHERE s.owner_id=? AND s.task_id=? AND s.kind='document_profile' AND a.error_code='document_profile_unverified'
 AND EXISTS(SELECT 1 FROM model_call c WHERE c.owner_id=a.owner_id AND c.step_attempt_id=a.id) ORDER BY a.attempt_no DESC LIMIT 1`,[ownerId,taskId]);

/** 仅用于独立合成库的故障注入，不在产品 registry 中注册。 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.profilePublicationMetrics',mode:'write',retryBusy:false,execute(tx,{ownerId,taskId,runId,stage},lease){
  let queries=0,semanticSourceChecks=0,writes=0;
  const measured={...tx,all:(sql,args)=>{queries++;if(sql.startsWith('SELECT v.restored_from_version_no,d.action '))semanticSourceChecks++;return tx.all(sql,args);},get:(sql,args)=>{queries++;if(sql.startsWith('SELECT v.restored_from_version_no,d.action '))semanticSourceChecks++;return tx.get(sql,args);},run:(sql,args)=>{writes++;return tx.run(sql,args);}};
  const action=memoryDocumentsPublicationActions.find(a=>a.name===`memoryDocuments.${stage}`),result=action.execute(measured,{ownerId,taskId,runId},lease);
  return {result,queries,semanticSourceChecks,writes};
 }},
 {name:'fixture.profilePublicationMemoBoundary',mode:'write',retryBusy:false,execute(tx,{ownerId,taskId,runId,stage},lease){
  const memory=tx.get("SELECT m.*,v.* FROM step_input i JOIN memory m ON m.owner_id=i.owner_id AND m.id=i.memory_id JOIN memory_version v ON v.owner_id=i.owner_id AND v.memory_id=i.memory_id AND v.version_no=i.memory_version_no JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id WHERE i.owner_id=? AND s.task_id=? AND i.kind='memory' LIMIT 1",[ownerId,taskId]);
  const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,memory.memory_id]),v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memory.memory_id,memory.version_no]);
  const action=memoryDocumentsPublicationActions.find(a=>a.name===`memoryDocuments.${stage}`);
  return action.execute({...tx,run:()=>{
   tx.run(`UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND id IN (SELECT message_id FROM memory_citation WHERE owner_id=? AND memory_id=? AND version_no=?)`,[ownerId,ownerId,m.id,v.version_no]);
   let rejected=false;try{memoryBasis(tx,ownerId,m,v);}catch(error){rejected=['memory_source_stale','document_source_stale'].includes(error.code);}
   throw new StorageFailure(rejected?'fixture_memo_boundary_safe':'fixture_memo_crossed_write');
  }},{ownerId,taskId,runId},lease);
 }},
 {name:'fixture.profileReplayFacts',mode:'read',retryBusy:false,execute(tx,{ownerId,taskId}){
  const first=original(tx,ownerId,taskId);
  return {attempts:tx.all('SELECT id,state,error_code,attempt_no FROM step_attempt WHERE owner_id=? AND step_id=? ORDER BY attempt_no',[ownerId,first.step_id]),
   events:tx.all(`SELECT e.kind,e.originated_call_id,e.reused_call_id,e.payload,e.content_state,a.attempt_no FROM execution_event e
    JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id WHERE e.owner_id=? AND a.step_id=? ORDER BY a.attempt_no,e.event_no`,[ownerId,first.step_id])};
 }},
 {name:'fixture.profileReplayFault',mode:'write',retryBusy:false,execute(tx,{ownerId,taskId,kind}){
  const first=original(tx,ownerId,taskId),call=tx.get('SELECT * FROM model_call WHERE owner_id=? AND step_attempt_id=? ORDER BY sent_at,id LIMIT 1',[ownerId,first.id]);
  const input=tx.get("SELECT id FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND originated_call_id=? AND kind='document_input'",[ownerId,first.id,call.id]);
  if(kind==='receipt_missing')tx.run('UPDATE model_call SET receipt=NULL WHERE owner_id=? AND id=?',[ownerId,call.id]);
  else if(kind==='receipt_json')tx.run("UPDATE model_call SET receipt='{}' WHERE owner_id=? AND id=?",[ownerId,call.id]);
  else if(kind==='receipt_dispatch')tx.run("UPDATE model_call SET receipt=json_set(receipt,'$.dispatch','http_accepted') WHERE owner_id=? AND id=?",[ownerId,call.id]);
  else if(kind==='receipt_outcome')tx.run("UPDATE model_call SET receipt=json_set(receipt,'$.outcome','unknown') WHERE owner_id=? AND id=?",[ownerId,call.id]);
  else if(kind==='receipt_identity')tx.run("UPDATE model_call SET receipt=json_set(receipt,'$.request_id','10000000-0000-4000-8000-000000000001') WHERE owner_id=? AND id=?",[ownerId,call.id]);
  else if(kind==='input_seal')tx.run("UPDATE model_operation SET input_seal='synthetic-wrong-seal' WHERE owner_id=? AND id=?",[ownerId,call.operation_id]);
  else if(kind==='event_source')tx.run('DELETE FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,input.id]);
  else if(kind==='execution_input')tx.run('DELETE FROM execution_input WHERE owner_id=? AND event_id=?',[ownerId,input.id]);
  else if(kind==='scope_missing')tx.run('DELETE FROM task_contribution WHERE owner_id=? AND task_id=?',[ownerId,taskId]);
  else if(kind==='ledger_scope_missing')tx.run('DELETE FROM operation_scope WHERE owner_id=? AND operation_id=?',[ownerId,call.operation_id]);
  else if(kind==='effect_missing')tx.run('DELETE FROM document_effect_scope WHERE owner_id=? AND operation_id=?',[ownerId,call.operation_id]);
  else if(kind==='source_revision')tx.run(`UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=?
   AND id IN (SELECT message_id FROM step_input WHERE owner_id=? AND step_id=? AND kind='message')`,[ownerId,ownerId,first.step_id]);
  else if(kind==='call_unknown')tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND id=?",[ownerId,call.id]);
  else if(kind==='commit_forbidden')tx.run('UPDATE model_operation SET commit_forbidden_at=1 WHERE owner_id=? AND id=?',[ownerId,call.operation_id]);
  else if(kind==='effect_occupied')tx.run("UPDATE document_effect_scope SET state='unknown' WHERE owner_id=? AND operation_id=?",[ownerId,call.operation_id]);
  else if(kind==='document_revision')tx.run('UPDATE contact SET document_revision=document_revision+1 WHERE owner_id=? AND id=(SELECT contact_id FROM processing_task WHERE owner_id=? AND id=?)',[ownerId,ownerId,taskId]);
  else if(kind==='saved_event_source')tx.run(`DELETE FROM event_source WHERE owner_id=? AND event_id IN (SELECT e.id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id WHERE e.owner_id=? AND a.step_id=? AND a.state='succeeded' AND e.kind='document_input' LIMIT 1)`,[ownerId,ownerId,first.step_id]);
  else if(kind==='saved_packet')tx.run(`UPDATE execution_event SET payload=json_set(payload,'$.synthetic_corruption',1) WHERE owner_id=? AND step_attempt_id=(SELECT successful_attempt_id FROM processing_step WHERE owner_id=? AND id=?) AND kind='document_output'`,[ownerId,ownerId,first.step_id]);
  else throw Error('invalid synthetic profile replay fault');
 }},
]};
