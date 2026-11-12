import {observedProcessingAction} from '../diagnostics.ts';
import {randomUUID} from 'node:crypto';
import type {StorageAction,StorageLease,StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {readExtractionToolArguments} from '../../extraction/arguments.ts';
import {DEFAULT_L2_SCENARIO_BUDGET,parseScenarioVerification,validateScenarioDocument,type L2ScenarioMemory,type L2ScenarioReference} from '../../scenarios/workspace.ts';
import {selectProfilePublication,validateProfile,type ProfileVerification} from '../../profiles/workspace.ts';
import {documentSources,frozenMemories,eligiblePriorMembers,publicationMembers,publicationDigest,renderDocuments,withDocumentSourceQualifications} from './basis.ts';
import {current} from './stages.ts';
import {preconditions,revisions,task,taskView} from './actions.ts';
import {fail,textId} from '../qualification.ts';
import {finishLaterStagePublication} from './later-schedule.ts';
const act=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:any,lease:StorageLease)=>unknown):StorageAction=>observedProcessingAction({name:`memoryDocuments.${name}`,mode,retryBusy:false,execute:(tx,input,lease)=>withDocumentSourceQualifications(tx,()=>execute(tx,input,lease))} as StorageAction);
function verification(tx:StorageTransaction,ownerId:string,attemptId:string,eventId:string,tool:string):unknown {
 const e=tx.get(`SELECT e.payload FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=coalesce(e.originated_call_id,e.reused_call_id)
  JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE e.owner_id=? AND e.id=? AND e.step_attempt_id=? AND e.kind='document_output' AND c.state='succeeded' AND o.commit_forbidden_at IS NULL`,[ownerId,eventId,attemptId]);
 if(!e)fail('document_verification_unbound');
 return readExtractionToolArguments(JSON.parse(String(e!.payload)).blocks,tool).value;
}
const members=eligiblePriorMembers;
function laterStage(tx:StorageTransaction,ownerId:string,t:StorageRow):string|null {
 const row=tx.get('SELECT policy_config FROM processing_run WHERE owner_id=? AND id=?',[ownerId,t.run_id]);if(!row)return null;
 try{const policy=JSON.parse(String(row.policy_config));return policy?.intent==='memory_document_later_stage'&&['document_scene','document_profile'].includes(policy.stage)?String(policy.stage):null;}catch{return null;}
}
function storeBasis(tx:StorageTransaction,ownerId:string,documentId:string,versionNo:bigint,blockNo:number,statementNo:number,eventId:string,refs:readonly L2ScenarioReference[],relation:'support'|'contradiction'='support'){
 if(!refs.length)fail('document_basis_missing');
 for(const [index,ref] of refs.entries()){
  const x=tx.get(`SELECT x.input_no FROM execution_input x JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no
   WHERE x.owner_id=? AND x.event_id=? AND i.kind='memory' AND i.memory_id=? AND i.memory_version_no=?`,[ownerId,eventId,ref.memory_id,ref.revision]);
  if(!x)fail('document_basis_missing');
  tx.run('INSERT INTO document_basis VALUES(?,?,?,?,?,?,?,?,?,?)',[ownerId,documentId,versionNo,blockNo,statementNo,index+1,eventId,x!.input_no,relation,relation==='contradiction'?(index===0?'left':'right'):null]);
 }
}
function makeVersion(tx:StorageTransaction,ownerId:string,t:StorageRow,attemptId:string,kind:'scene'|'profile',documentId:string,title:string,hint:string|null,topicKey:string|null):{versionNo:bigint;versionId:string}{
 const existing=tx.get('SELECT * FROM memory_document WHERE owner_id=? AND id=?',[ownerId,documentId]);
 if(existing){if(existing.scope_kind!==t.scope_kind||existing.contact_id!==t.contact_id||existing.kind!==kind||existing.state!=='active')fail('document_scope_stale');}
 else tx.run("INSERT INTO memory_document VALUES(?,?,?,?,?,'active')",[ownerId,documentId,t.scope_kind,t.contact_id,kind]);
 const versionNo=tx.get('SELECT coalesce(max(version_no),0)+1 AS n FROM memory_document_version WHERE owner_id=? AND document_id=?',[ownerId,documentId])!.n as bigint;
 const old=tx.get('SELECT version_no FROM publication_member WHERE owner_id=? AND publication_id=? AND document_id=?',[ownerId,t.accepted_publication_id,documentId]);
 if(versionNo>1n&&!old)fail('document_version_conflict');
 const versionId=randomUUID();
 tx.run("INSERT INTO memory_document_version VALUES(?,?,?,?,?,?,?,?,?,?,'present')",[ownerId,documentId,versionNo,versionId,title,hint,topicKey,attemptId,old?.version_no??null,'documents-v1']);
 return {versionNo,versionId};
}
function markSuccess(tx:StorageTransaction,ownerId:string,a:StorageRow):void {
 if(tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state<>'succeeded'",[ownerId,a.id]))fail('document_call_incomplete');
 tx.run("UPDATE step_attempt SET state='succeeded',finished_at=? WHERE owner_id=? AND id=?",[Date.now(),ownerId,a.id]);
 tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[a.id,ownerId,a.step_id]);
 tx.run("UPDATE model_operation SET state='applied' WHERE owner_id=? AND memory_step_id=? AND state='resolved'",[ownerId,a.step_id]);
}
function replace(tx:StorageTransaction,ownerId:string,t:StorageRow,documentId:string,versionNo:bigint,versionIdentity:string){
 const old=tx.get(`SELECT m.document_id,m.version_no FROM publication_member m JOIN memory_document_version v ON v.owner_id=m.owner_id AND v.document_id=m.document_id AND v.version_no=m.version_no WHERE m.owner_id=? AND m.publication_id=? AND v.version_identity=?`,[ownerId,t.accepted_publication_id,versionIdentity]);
 if(!old)fail('document_replacement_stale');
 tx.run('INSERT INTO document_replacement VALUES(?,?,?,?,?)',[ownerId,documentId,versionNo,old!.document_id,old!.version_no]);
}
function sceneVersions(tx:StorageTransaction,ownerId:string,t:StorageRow,memories:L2ScenarioMemory[]){
 const old=members(tx,ownerId,t);
 const staged=tx.all(`SELECT v.*,d.kind,d.scope_kind,d.contact_id,d.state FROM memory_document_version v JOIN memory_document d ON d.owner_id=v.owner_id AND d.id=v.document_id
  JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
  WHERE v.owner_id=? AND s.task_id=? AND s.kind='document_scene' AND s.state='succeeded' AND a.state='succeeded' ORDER BY d.id`,[ownerId,t.id]);
 const replacements=tx.all(`SELECT r.old_document_id,r.old_version_no FROM document_replacement r JOIN memory_document_version v ON v.owner_id=r.owner_id AND v.document_id=r.document_id AND v.version_no=r.version_no
  JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE r.owner_id=? AND s.task_id=? AND s.kind='document_scene'`,[ownerId,t.id]);
 const retained=old.filter(o=>o.kind==='scene'&&!replacements.some(r=>r.old_document_id===o.document_id&&r.old_version_no===o.version_no));
 return renderDocuments(tx,ownerId,[...retained,...staged],memories).scenarios;
}
export const memoryDocumentsPublicationActions:StorageAction[]=[
 act('saveScene','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId),{attempt,t}=current(tx,ownerId,textId(i.attemptId),lease);if(attempt.kind!=='document_scene')fail('document_stage_invalid');
  const memories=frozenMemories(tx,ownerId,String(attempt.step_id)),old=members(tx,ownerId,t),previous=renderDocuments(tx,ownerId,old,memories).scenarios;
  const scenarios=validateScenarioDocument({scenarios:i.scenarios},memories,previous,DEFAULT_L2_SCENARIO_BUDGET),eventId=textId(i.verificationEventId);
  parseScenarioVerification(verification(tx,ownerId,String(attempt.id),eventId,'ScenarioVerificationOutput'),scenarios,memories);
  const replaced=new Set<string>();
  for(const draft of scenarios){
   for(const version of draft.replaces){if(replaced.has(version))fail('document_replacement_conflict');replaced.add(version);}
   const documentId=draft.scenario_id??randomUUID(),v=makeVersion(tx,ownerId,t,String(attempt.id),'scene',documentId,draft.title,draft.hint,draft.topic_key);
   for(const oldId of draft.replaces)replace(tx,ownerId,t,documentId,v.versionNo,oldId);
   for(const [index,paragraph] of draft.paragraphs.entries()){
    const n=index+1;tx.run("INSERT INTO document_block VALUES(?,?,?,?, 'scene',NULL)",[ownerId,documentId,v.versionNo,n]);
    tx.run("INSERT INTO document_statement(owner_id,document_id,version_no,block_no,statement_no,kind,body) VALUES(?,?,?,?,1,'fact',?)",[ownerId,documentId,v.versionNo,n,paragraph.text]);
    storeBasis(tx,ownerId,documentId,v.versionNo,n,1,eventId,paragraph.references);
   }
  }
  markSuccess(tx,ownerId,attempt);return {scenarios:sceneVersions(tx,ownerId,t,memories)};
 }),
 act('saveProfile','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId),{attempt,t}=current(tx,ownerId,textId(i.attemptId),lease);if(attempt.kind!=='document_profile')fail('document_stage_invalid');
  const memories=frozenMemories(tx,ownerId,String(attempt.step_id)),old=members(tx,ownerId,t),previous=renderDocuments(tx,ownerId,old,memories).profile;
  const proposal=validateProfile({entries:i.entries},memories,DEFAULT_L2_SCENARIO_BUDGET),eventId=textId(i.verificationEventId);
  const checked=verification(tx,ownerId,String(attempt.id),eventId,'ProfileVerificationOutput') as ProfileVerification;
  const prior=new Set(renderDocuments(tx,ownerId,old,memories).scenarios.map(s=>s.version_id));
  const selection=selectProfilePublication(proposal,checked,memories,DEFAULT_L2_SCENARIO_BUDGET,previous,
    previous?sceneVersions(tx,ownerId,t,memories).filter(s=>!prior.has(s.version_id)):[]);
  const eventNo=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attempt.id])!.n;
  tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',
    [ownerId,randomUUID(),attempt.id,eventNo,'document_profile_selection',JSON.stringify({verificationEventId:eventId,
      accepted:selection.accepted.map(item=>item.index),rejected:selection.rejected.map(index=>({index,code:'document_profile_entry_unsupported'})),
      retained:selection.retained.map(item=>item.index)}),Date.now()]);
  if(!selection.accepted.length){markSuccess(tx,ownerId,attempt);return true;}
  const oldProfile=old.find(v=>v.kind==='profile'),documentId=oldProfile?String(oldProfile!.document_id):randomUUID();
  const v=makeVersion(tx,ownerId,t,String(attempt.id),'profile',documentId,'长期背景',null,null);
  if(oldProfile)replace(tx,ownerId,t,documentId,v.versionNo,String(oldProfile.version_identity));
  for(const {index,entry} of selection.accepted){
   const n=index+1;tx.run("INSERT INTO document_block VALUES(?,?,?,?, 'profile',?)",[ownerId,documentId,v.versionNo,n,entry.section]);
   const kind=entry.kind==='contradiction'?'contradiction':entry.kind==='inference'?'inference':'fact';
   const refs=entry.references.map(ref=>memories.find(m=>m.memory_id===ref.memory_id&&m.revision===ref.revision));
   if(kind==='contradiction'&&(refs.length!==2||refs.some(r=>!r)||refs[0]!.memory_id===refs[1]!.memory_id))fail('document_contradiction_basis_missing');
   tx.run('INSERT INTO document_statement(owner_id,document_id,version_no,block_no,statement_no,kind,body,rationale,left_claim,right_claim,resolution_state,resolution_text,profile_kind,section,temporal_status,uncertainty) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)',
    [ownerId,documentId,v.versionNo,n,kind,entry.text,entry.basis,kind==='contradiction'?refs[0]!.text:null,kind==='contradiction'?refs[1]!.text:null,kind==='contradiction'?'unresolved':null,null,entry.kind,entry.section,entry.temporal_status,entry.uncertainty]);
   storeBasis(tx,ownerId,documentId,v.versionNo,n,1,eventId,entry.references,kind==='contradiction'?'contradiction':'support');
  }
  if(selection.retained.length){
   if(!oldProfile)fail('document_profile_previous_missing');
   const statements=tx.all('SELECT * FROM document_statement WHERE owner_id=? AND document_id=? AND version_no=? ORDER BY block_no,statement_no',[ownerId,oldProfile!.document_id,oldProfile!.version_no]);
   for(const [offset,item] of selection.retained.entries()){
    const row=statements[item.index];if(!row)fail('document_profile_previous_missing');
    const n=proposal.entries.length+offset+1;
    tx.run("INSERT INTO document_block VALUES(?,?,?,?, 'profile',?)",[ownerId,documentId,v.versionNo,n,row.section]);
    tx.run('INSERT INTO document_statement(owner_id,document_id,version_no,block_no,statement_no,kind,body,rationale,left_claim,right_claim,resolution_state,resolution_text,profile_kind,section,temporal_status,uncertainty) VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)',
     [ownerId,documentId,v.versionNo,n,row.kind,row.body,row.rationale,row.left_claim,row.right_claim,row.resolution_state,row.resolution_text,row.profile_kind,row.section,row.temporal_status,row.uncertainty]);
    tx.run('INSERT INTO document_basis SELECT owner_id,?,?,?,1,basis_no,event_id,input_no,relation_kind,contradiction_side FROM document_basis WHERE owner_id=? AND document_id=? AND version_no=? AND block_no=? AND statement_no=?',
     [documentId,v.versionNo,n,ownerId,oldProfile!.document_id,oldProfile!.version_no,row.block_no,row.statement_no]);
   }
  }
  markSuccess(tx,ownerId,attempt);return true;
 }),
 act('publish','write',(tx,i)=>{
  const ownerId=textId(i.ownerId),t=task(tx,ownerId,textId(i.taskId));preconditions(tx,ownerId,t,{allowPaused:true});
  const r=revisions(tx,ownerId,t);
  if(t.document_basis_state!=='frozen'||r.memory_revision!==t.accepted_memory_revision||r.document_revision!==t.accepted_document_revision||r.current_publication_id!==t.accepted_publication_id)fail('document_publication_conflict');
  const stages=tx.all("SELECT kind,state FROM processing_step WHERE owner_id=? AND task_id=? AND kind IN ('document_scene','document_profile')",[ownerId,t.id]);
  const mode=laterStage(tx,ownerId,t),completed=stages.every(s=>s.state==='succeeded'||s.state==='not_applicable');
  if(!completed||(mode==='document_scene'?(stages.length!==1||stages[0]?.kind!=='document_scene'||stages[0]?.state!=='succeeded'):
   mode==='document_profile'?(stages.length!==1||stages[0]?.kind!=='document_profile'||stages[0]?.state!=='succeeded'):stages.length!==2))fail('document_stage_incomplete');
  const prior=members(tx,ownerId,t),created=tx.all(`SELECT v.*,d.kind,d.scope_kind,d.contact_id,d.state FROM memory_document_version v JOIN memory_document d ON d.owner_id=v.owner_id AND d.id=v.document_id JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE v.owner_id=? AND s.task_id=? AND s.kind IN ('document_scene','document_profile') AND s.state='succeeded' AND a.state='succeeded' AND v.content_state='present'`,[ownerId,t.id]);
  const replacements=tx.all(`SELECT r.old_document_id,r.old_version_no FROM document_replacement r JOIN memory_document_version v ON v.owner_id=r.owner_id AND v.document_id=r.document_id AND v.version_no=r.version_no JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE r.owner_id=? AND s.task_id=?`,[ownerId,t.id]);
  const all=[...prior.filter(v=>!replacements.some(x=>x.old_document_id===v.document_id&&x.old_version_no===v.version_no)),...created];
  if(new Set(all.map(v=>String(v.document_id))).size!==all.length||all.filter(v=>v.kind==='profile').length>1)fail('document_member_conflict');
  for(const m of all){if(m.scope_kind!==t.scope_kind||m.contact_id!==t.contact_id||m.state!=='active')fail('document_scope_stale');documentSources(tx,ownerId,String(m.document_id),m.version_no as bigint);}
  const publicationId=randomUUID(),number=tx.get('SELECT coalesce(max(publication_no),0)+1 AS n FROM document_publication WHERE owner_id=? AND scope_kind=? AND contact_id IS ?',[ownerId,t.scope_kind,t.contact_id])!.n;
  tx.run("INSERT INTO document_publication VALUES(?,?,?,?,?,?,'documents-v1',?,?,?,?,'available')",[ownerId,publicationId,t.scope_kind,t.contact_id,number,t.run_id,t.id,Date.now(),all.length,publicationDigest(all.map(v=>({documentId:String(v.document_id),versionNo:v.version_no as bigint})))]);
  for(const m of all)tx.run('INSERT INTO publication_member VALUES(?,?,?,?)',[ownerId,publicationId,m.document_id,m.version_no]);
  if(t.scope_kind==='self')tx.run('UPDATE owner SET current_publication_id=?,document_revision=document_revision+1 WHERE owner_id=? AND memory_revision=? AND document_revision=? AND current_publication_id IS ?',[publicationId,ownerId,t.accepted_memory_revision,t.accepted_document_revision,t.accepted_publication_id]);
  else tx.run('UPDATE contact SET current_publication_id=?,document_revision=document_revision+1 WHERE owner_id=? AND id=? AND memory_revision=? AND document_revision=? AND current_publication_id IS ?',[publicationId,ownerId,t.contact_id,t.accepted_memory_revision,t.accepted_document_revision,t.accepted_publication_id]);
  if(revisions(tx,ownerId,t).current_publication_id!==publicationId)fail('document_publication_conflict');
  finishLaterStagePublication(tx,ownerId,String(t.id),typeof i.now==='number'?i.now:Date.now());return taskView(tx,ownerId,String(t.id));
 }),
 act('settle','write',(tx,i)=>{
  const ownerId=textId(i.ownerId),runId=textId(i.runId),run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
  if(!run||run.pause_requested_at!==null||['revoked','failed','paused'].includes(String(run.state)))return false;
  const tasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId]);
  if(!tasks.length)return false;
  for(const t of tasks){
   preconditions(tx,ownerId,t);const view=taskView(tx,ownerId,String(t.id));if(view.outcome!=='completed')return false;
   const p=tx.get("SELECT * FROM document_publication WHERE owner_id=? AND basis_task_id=? AND availability='available'",[ownerId,t.id]);
   const r=revisions(tx,ownerId,t);if(!p||r.current_publication_id!==p.id)return false;
   publicationMembers(tx,ownerId,String(p.id),String(t.scope_kind),t.contact_id as string|null);
  }
  for(const target of tx.all("SELECT * FROM run_input WHERE owner_id=? AND run_id=? AND role='target'",[ownerId,runId])){
   const attempt=tx.get(`SELECT s.successful_attempt_id FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE i.owner_id=? AND i.run_id=? AND i.run_input_no=? AND s.kind='extraction_verification' AND s.state='succeeded' AND t.scope_kind='contact' AND t.contact_id=? LIMIT 1`,[ownerId,runId,target.input_no,target.source_contact_id]);
   const reused=attempt?null:tx.get(`SELECT a.id AS successful_attempt_id FROM document_extraction_reuse reuse JOIN step_attempt a ON a.owner_id=reuse.owner_id AND a.id=reuse.source_attempt_id AND a.state='succeeded'
    JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id AND s.kind='extraction_verification' AND s.state='succeeded' AND s.successful_attempt_id=a.id
    WHERE reuse.owner_id=? AND reuse.run_id=? AND reuse.input_no=?`,[ownerId,runId,target.input_no]);
   const completedAttempt=attempt?.successful_attempt_id??reused?.successful_attempt_id;if(!completedAttempt)fail('document_completion_input_missing');
   tx.run("UPDATE processing_item SET pipeline_state='completed',completion_attempt_id=? WHERE owner_id=? AND id=? AND extraction_state='succeeded' AND pipeline_state='pending'",[completedAttempt!,ownerId,target.item_id]);
  }
  tx.run("UPDATE processing_run SET state='completed' WHERE owner_id=? AND id=? AND state<>'revoked'",[ownerId,runId]);return true;
 }),
];
export {sceneVersions};
