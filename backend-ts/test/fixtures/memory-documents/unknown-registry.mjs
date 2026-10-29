import {randomUUID} from 'node:crypto';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {eligiblePriorMembers} from '../../../src/memory/sqlite/documents/basis.ts';

const realNow=Date.now;
export const registry={...base,actions:[...base.actions,
 {name:'fixture.effectScopes',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  return tx.all(`SELECT e.operation_id,e.scope_kind,e.contact_id,e.effect_kind,e.state,o.state AS operation_state,o.memory_step_id,o.commit_forbidden_at,
   c.id AS call_id,c.state AS call_state,c.settlement_state,c.reserved_budget_units,c.actual_budget_units,c.receipt
   FROM document_effect_scope e JOIN model_operation o ON o.owner_id=e.owner_id AND o.id=e.operation_id
   JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE e.owner_id=? ORDER BY e.operation_id`,[ownerId]);
 }},
 {name:'fixture.modelCall',mode:'read',retryBusy:false,execute(tx,{ownerId,callId}){
  return tx.get(`SELECT c.*,o.state AS operation_state,o.commit_forbidden_at FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.id=?`,[ownerId,callId])??null;
 }},
 {name:'fixture.scopeRevision',mode:'read',retryBusy:false,execute(tx,{ownerId,contactId}){
  return tx.get('SELECT current_publication_id,document_revision,memory_revision FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId])??null;
 }},
 {name:'fixture.advanceClock',mode:'write',retryBusy:false,execute(_tx,{milliseconds}){
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0||milliseconds>120000)throw Error('invalid synthetic clock');Date.now=()=>realNow()+milliseconds;
 }},
 {name:'fixture.corruptTime',mode:'write',retryBusy:false,execute(tx,{ownerId,memoryId}){
  tx.run(`UPDATE execution_event SET payload=json_set(payload,'$.fact.invalid_at','not-a-valid-time') WHERE owner_id=? AND id IN (SELECT c.event_id FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no JOIN decision_candidate d ON d.owner_id=v.owner_id AND d.decision_id=v.decision_id JOIN memory_candidate c ON c.owner_id=d.owner_id AND c.id=d.candidate_id WHERE m.owner_id=? AND m.id=?)`,[ownerId,ownerId,memoryId]);
 }},
 {name:'fixture.inspectPrior',mode:'read',retryBusy:false,execute(tx,{ownerId,publicationId,contactId,taskId}){
  return eligiblePriorMembers(tx,ownerId,{id:taskId,scope_kind:'contact',contact_id:contactId,accepted_publication_id:publicationId});
 }},
 {name:'fixture.corruptPublication',mode:'write',retryBusy:false,execute(tx,{ownerId,publicationId,kind}){
  const row=tx.get(`SELECT m.document_id,m.version_no FROM publication_member m JOIN memory_document d ON d.owner_id=m.owner_id AND d.id=m.document_id WHERE m.owner_id=? AND m.publication_id=? AND d.kind='scene'`,[ownerId,publicationId]);
  if(kind==='member')tx.run('DELETE FROM publication_member WHERE owner_id=? AND publication_id=? AND document_id=?',[ownerId,publicationId,row.document_id]);
  else if(kind==='basis')tx.run('DELETE FROM document_basis WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,row.document_id,row.version_no]);
  else if(kind==='event_source')tx.run(`DELETE FROM event_source WHERE owner_id=? AND event_id IN (SELECT e.id FROM memory_document_version v JOIN execution_event e ON e.owner_id=v.owner_id AND e.step_attempt_id=v.produced_attempt_id WHERE v.owner_id=? AND v.document_id=? AND v.version_no=? AND e.kind='document_input')`,[ownerId,ownerId,row.document_id,row.version_no]);
  else throw Error('invalid synthetic corruption');
 }},
 {name:'fixture.duplicateEffect',mode:'write',retryBusy:false,execute(tx,{ownerId,operationId}){
  const old=tx.get('SELECT * FROM document_effect_scope WHERE owner_id=? AND operation_id=?',[ownerId,operationId]);
  const o=tx.get('SELECT * FROM model_operation WHERE owner_id=? AND id=?',[ownerId,operationId]);
  const id=randomUUID(),slot=tx.get('SELECT coalesce(max(slot),0)+1 AS n FROM model_operation WHERE owner_id=? AND memory_step_id=?',[ownerId,o.memory_step_id]).n;
  tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,?,?,?,?,'prepared')",[ownerId,id,o.purpose,o.memory_step_id,slot,'synthetic']);
  try{tx.run("INSERT INTO document_effect_scope VALUES(?,?,?,?,?,'reserved')",[ownerId,id,old.scope_kind,old.contact_id,old.effect_kind]);}
  catch(error){if(String(error.message).includes('UNIQUE constraint failed: document_effect_scope.'))throw new StorageFailure('fixture_effect_scope_unique');throw error;}
 }},
]};
