import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {installedDeletionRegistration} from '../../../src/storage/sqlite/deletion/registration.ts';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';
import {memoryDocumentsDeletionDomain} from '../../../src/memory/sqlite/documents/deletion.ts';
import {documentKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
import {memoryDeletionImpact} from '../../../src/memory/sqlite/deletion-impact.ts';
const config={...installedDeletionRegistration,domains:[memoryDocumentsDeletionDomain,...installedDeletionRegistration.domains.filter(d=>d.id!=='memory_documents')],requiredDomains:[...new Set(['memory_documents',...installedDeletionRegistration.requiredDomains])]};
const replacement=createDeletionActions(config),replaced=new Set(replacement.map(a=>a.name));
export const registry={...base,actions:[...base.actions.filter(a=>!replaced.has(a.name)),...replacement,
 {name:'fixture.failedRunWithoutPause',mode:'write',retryBusy:false,execute(tx,{ownerId,runId}){
  tx.run("UPDATE processing_run SET state='failed',pause_requested_at=NULL WHERE owner_id=? AND id=?",[ownerId,runId]);
 }},
 {name:'fixture.extractionFailures',mode:'read',retryBusy:false,execute(tx,{ownerId,taskId}){
  return tx.all("SELECT a.state,a.error_code FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE s.owner_id=? AND s.task_id=? AND s.kind='extraction_verification' ORDER BY a.attempt_no",[ownerId,taskId]);
 }},
 {name:'fixture.removeDocumentMember',mode:'write',retryBusy:false,execute(tx,{ownerId,publicationId}){
  const member=tx.get('SELECT document_id FROM publication_member WHERE owner_id=? AND publication_id=? ORDER BY document_id LIMIT 1',[ownerId,publicationId]);
  if(!member)throw Error('synthetic_member_missing');
  tx.run('DELETE FROM publication_member WHERE owner_id=? AND publication_id=? AND document_id=?',[ownerId,publicationId,member.document_id]);
 }},
 {name:'fixture.documentIdentityCount',mode:'read',retryBusy:false,execute:(tx,{ownerId})=>tx.get('SELECT count(*) AS n FROM document_publication_identity WHERE owner_id=?',[ownerId]).n},
 {name:'fixture.documentIdentityShape',mode:'read',retryBusy:false,execute(tx,{ownerId,publicationId}){
  return {columns:tx.all("SELECT name FROM pragma_table_info('document_publication_identity') ORDER BY cid",[]).map(row=>row.name),identity:tx.get('SELECT * FROM document_publication_identity WHERE owner_id=? AND id=?',[ownerId,publicationId])??null};
 }},
 {name:'fixture.documentPhysicalVersions',mode:'read',retryBusy:false,execute(tx,{ownerId,versions}){
  return versions.map(({documentId,versionNo,attemptId})=>({documentId,versionNo,attemptId,
   versions:tx.get('SELECT count(*) AS n FROM memory_document_version WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,documentId,BigInt(versionNo)]).n,
   blocks:tx.get('SELECT count(*) AS n FROM document_block WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,documentId,BigInt(versionNo)]).n,
   statements:tx.get('SELECT count(*) AS n FROM document_statement WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,documentId,BigInt(versionNo)]).n,
   basis:tx.get('SELECT count(*) AS n FROM document_basis WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,documentId,BigInt(versionNo)]).n,
   events:tx.get('SELECT count(*) AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId]).n}));
 }},
 {name:'fixture.documentKnowledge',mode:'read',retryBusy:false,execute(tx,input){return documentKnowledgeReader.read(tx,input);}},
 {name:'fixture.documentCurrent',mode:'read',retryBusy:false,execute(tx,input){documentKnowledgeReader.requireCurrent(tx,input.scope,input.item);return true;}},
 {name:'fixture.documentTaskDiagnostics',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  return tx.all(`SELECT t.id,t.state,t.error_code,t.document_basis_state,t.accepted_publication_id,t.run_id,r.state AS run_state,CAST(r.started_at AS TEXT) AS started_at,CAST(r.rowid AS TEXT) AS run_rowid
   FROM processing_task t JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id
   WHERE t.owner_id=? AND t.scope_kind='self' AND t.contact_id IS NULL ORDER BY r.started_at DESC,r.rowid DESC`,[ownerId]).map(task=>({...task,steps:tx.all(`SELECT s.kind,s.state,s.not_applicable_reason,(SELECT a.error_code FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id ORDER BY a.attempt_no DESC LIMIT 1) AS error_code FROM processing_step s WHERE s.owner_id=? AND s.task_id=? AND s.kind IN ('document_scene','document_profile') ORDER BY s.step_no`,[ownerId,task.id])}));
 }},
 {name:'fixture.sourceImpact',mode:'read',retryBusy:false,execute(tx,{ownerId,contactId,sourceId,taskId,operationId}){
  const impact=memoryDeletionImpact(tx,{operationId,ownerId,scope:{kind:'source',contactId,sourceId},acceptedGeneration:0n,planRevision:0n,state:'fenced',createdAt:'1970-01-01T00:00:00.000Z',completedAt:null});
  const steps=tx.all('SELECT id,kind,state FROM processing_step WHERE owner_id=? AND task_id=?',[ownerId,taskId]);
  const ids=new Set(steps.map(row=>String(row.id))),events=impact.events.map(id=>tx.get(`SELECT e.id,e.kind,s.id AS step_id,s.kind AS step_kind,EXISTS(SELECT 1 FROM event_source es WHERE es.owner_id=e.owner_id AND es.event_id=e.id AND es.source_contact_id=? AND es.record_id=?) AS has_source,INSTR(e.payload,'蓝茶')>0 AS contains_source_text FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND e.id=?`,[contactId,sourceId,ownerId,id])).filter(row=>row&&ids.has(String(row.step_id))).map(row=>({...row,has_source:!!row.has_source,contains_source_text:!!row.contains_source_text}));
  const inputs=impact.stepInputs.filter(row=>ids.has(row.stepId)).map(row=>tx.get(`SELECT i.step_id,i.kind,i.source_contact_id,i.record_id,i.memory_id,i.candidate_id,EXISTS(SELECT 1 FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id WHERE x.owner_id=i.owner_id AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no AND e.kind='adjudication_input') AS sent,INSTR(v.body,'蓝茶')>0 AS memory_has_source_text FROM step_input i LEFT JOIN memory_version v ON v.owner_id=i.owner_id AND v.memory_id=i.memory_id AND v.version_no=i.memory_version_no WHERE i.owner_id=? AND i.step_id=? AND i.input_no=?`,[ownerId,row.stepId,row.inputNo])).filter(Boolean).map(row=>({...row,sent:!!row.sent,memory_has_source_text:!!row.memory_has_source_text}));
  return {taskAffected:impact.tasks.includes(taskId),steps:steps.filter(row=>impact.steps.includes(String(row.id))),events,inputs};
 }},
 {name:'fixture.publicationInputs',mode:'read',retryBusy:false,execute(tx,{ownerId,publicationId}){
  const publication=tx.get('SELECT * FROM document_publication WHERE owner_id=? AND id=?',[ownerId,publicationId]);
  if(!publication)return null;
  const task=tx.get('SELECT id,accepted_publication_id,document_basis_state FROM processing_task WHERE owner_id=? AND id=?',[ownerId,publication.basis_task_id]);
  const versions=tx.all(`SELECT m.document_id,m.version_no,v.produced_attempt_id,a.step_id FROM publication_member m JOIN memory_document_version v ON v.owner_id=m.owner_id AND v.document_id=m.document_id AND v.version_no=m.version_no JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id WHERE m.owner_id=? AND m.publication_id=? ORDER BY m.document_id`,[ownerId,publicationId]);
  return {publication:{availability:publication.availability},task,versions:versions.map(v=>({...v,inputs:tx.all('SELECT kind,source_contact_id,record_id,document_id,document_version_no,publication_id FROM step_input WHERE owner_id=? AND step_id=? ORDER BY input_no',[ownerId,v.step_id])}))};
 }},
 {name:'fixture.documentCalls',mode:'read',retryBusy:false,execute(tx,{ownerId,taskId}){
  return tx.all(`SELECT e.id,e.kind,e.originated_call_id,e.payload,s.id AS step_id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND s.task_id=? AND s.kind='document_scene' AND e.kind IN ('document_input','document_output') ORDER BY e.event_no`,[ownerId,taskId]).map(e=>({...e,payload:JSON.parse(e.payload),inputs:tx.all(`SELECT x.role,i.kind,i.document_id,i.document_version_no,i.memory_id,i.record_id FROM execution_input x JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no WHERE x.owner_id=? AND x.event_id=? ORDER BY x.input_no`,[ownerId,e.id])}));
 }},
 {name:'fixture.documentInputs',mode:'read',retryBusy:false,execute(tx,{ownerId,stepId}){return tx.all("SELECT source_contact_id,record_id FROM step_input WHERE owner_id=? AND step_id=? AND kind='message' ORDER BY source_contact_id,record_id",[ownerId,stepId]);}},
 {name:'fixture.documentAttempt',mode:'read',retryBusy:false,execute(tx,{ownerId,stepId,callId}){return {attempt:tx.get('SELECT id,state FROM step_attempt WHERE owner_id=? AND step_id=?',[ownerId,stepId])??null,call:tx.get('SELECT id,state,settlement_state,step_attempt_id,receipt FROM model_call WHERE owner_id=? AND id=?',[ownerId,callId])??null,operation:tx.get('SELECT o.state,o.memory_step_id,o.commit_forbidden_at,o.input_seal FROM model_operation o JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE c.owner_id=? AND c.id=?',[ownerId,callId])??null,occupations:tx.all('SELECT oi.state FROM operation_item oi JOIN model_call c ON c.owner_id=oi.owner_id AND c.operation_id=oi.operation_id WHERE c.owner_id=? AND c.id=?',[ownerId,callId])};}},
 {name:'fixture.documentErasure',mode:'read',retryBusy:false,execute(tx,{ownerId,text}){
  return {statements:tx.get('SELECT count(*) n FROM document_statement WHERE owner_id=? AND (body LIKE ? OR rationale LIKE ? OR left_claim LIKE ? OR right_claim LIKE ? OR resolution_text LIKE ? OR uncertainty LIKE ?)',[ownerId,...Array(6).fill(`%${text}%`)]).n,
   versions:tx.get('SELECT count(*) n FROM memory_document_version WHERE owner_id=? AND (title LIKE ? OR hint LIKE ? OR topic_key LIKE ?)',[ownerId,...Array(3).fill(`%${text}%`)]).n,
   blocks:tx.get('SELECT count(*) n FROM document_block WHERE owner_id=? AND heading LIKE ?',[ownerId,`%${text}%`]).n,
   events:tx.get("SELECT count(*) n FROM execution_event WHERE owner_id=? AND kind IN ('document_input','document_output') AND payload LIKE ?",[ownerId,`%${text}%`]).n,
   references:tx.get("SELECT count(*) n FROM step_input WHERE owner_id=? AND kind IN ('memory','document','message') AND step_id IN (SELECT id FROM processing_step WHERE owner_id=? AND kind IN ('document_scene','document_profile'))",[ownerId,ownerId]).n};
 }},
]};
