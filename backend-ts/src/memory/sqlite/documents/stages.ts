import {createHash,randomUUID} from 'node:crypto';
import type {StorageAction,StorageLease,StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {ModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import {validateModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import type {ModelTaskClaim} from '../../../platform/models/model-permit-server.ts';
import type {L2ScenarioMemory} from '../../scenarios/workspace.ts';
import {actualInputSources,memoryBasis,frozenMemories,eligiblePriorMembers,publicationMembers,publicationDigest,renderDocuments,sourceStillValid} from './basis.ts';
import {documentActualInputs} from './inputs.ts';
import {preconditions,revisions,task,taskView} from './actions.ts';
import {fail,textId} from '../qualification.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';

export interface DocumentClaim {attemptId:string;stepId:string;taskId:string;runId:string;kind:'document_scene'|'document_profile';scopeKind:'self'|'contact';contactId:string|null;claim:ModelTaskClaim;memories:L2ScenarioMemory[];scenarios:any[];profile:any;}
const act=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:any,lease:StorageLease)=>unknown):StorageAction=>({name:`memoryDocuments.${name}`,mode,retryBusy:false,execute} as StorageAction);
/** 普通暂停后不再启动新的文档小批；正在执行的批次允许收尾。 */
function runPaused(tx:StorageTransaction,ownerId:string,runId:string):boolean {
 const run=tx.get('SELECT pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 return !run||run.pause_requested_at!==null;
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function eligible(tx:StorageTransaction,ownerId:string,t:StorageRow){
 const contributions=new Set(tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[ownerId,t.id]).map(c=>String(c.source_contact_id)));
 const selected:{row:StorageRow;version:StorageRow;memory:L2ScenarioMemory;sources:ReplySource[]}[]=[];
 for(const m of tx.all("SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state='active' ORDER BY id",[ownerId,t.scope_kind,t.contact_id])){
  const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);if(!v)fail('document_memory_missing');
  try {const value=memoryBasis(tx,ownerId,m,v!);if(value.sources.some(s=>!contributions.has(s.contactId)))continue;selected.push({row:m,version:v!,...value});}
  catch(error){if(!(error instanceof StorageFailure)||error.code!=='document_memory_stale')throw error;}
 }
 return selected;
}
function createStep(tx:StorageTransaction,ownerId:string,t:StorageRow,kind:DocumentClaim['kind'],lease:StorageLease):DocumentClaim {
 const selected=eligible(tx,ownerId,t),members=eligiblePriorMembers(tx,ownerId,t);
 if(!selected.length)fail('document_no_eligible_memories');
 if(kind==='document_profile'){
  const prior=tx.all(`SELECT i.memory_id,i.memory_version_no,i.accepted_head_revision FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id
   WHERE s.owner_id=? AND s.task_id=? AND s.kind='document_scene' AND s.state='succeeded' AND i.kind='memory' ORDER BY i.memory_id`,[ownerId,t.id]);
  if(prior.length!==selected.length||prior.some((item,index)=>item.memory_id!==selected[index]?.row.id||item.memory_version_no!==selected[index]?.version.version_no||item.accepted_head_revision!==selected[index]?.row.head_revision))fail('document_memory_stale');
 }
 const stepId=randomUUID(),attemptId=randomUUID(),now=Date.now(),stepNo=tx.get('SELECT coalesce(max(step_no),0)+1 AS n FROM processing_step WHERE owner_id=? AND task_id=?',[ownerId,t.id])!.n;
 tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,accepted_memory_revision) VALUES(?,?,?,?,?,'running','frozen',?)",[ownerId,stepId,t.id,stepNo,kind,t.accepted_memory_revision]);
 let inputNo=0;
 for(const item of selected)tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,memory_id,memory_version_no,accepted_head_revision) VALUES(?,?,?,'memory',?,?,?)",[ownerId,stepId,++inputNo,item.row.id,item.version.version_no,item.row.head_revision]);
 const sources=[...new Map(selected.flatMap(item=>item.sources).map(s=>[JSON.stringify([s.contactId,s.messageId,s.recordId]),s])).values()];
 for(const source of sources)tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,source_contact_id,message_id,record_id,accepted_revision) VALUES(?,?,?,'message',?,?,?,?)",[ownerId,stepId,++inputNo,source.contactId,source.messageId,source.recordId,source.acceptedRevision]);
 for(const member of members.filter(member=>kind==='document_profile'||member.kind==='scene'))tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,document_id,document_version_no,publication_id) VALUES(?,?,?,'document',?,?,?)",[ownerId,stepId,++inputNo,member.document_id,member.version_no,t.accepted_publication_id]);
 if(kind==='document_profile')for(const v of tx.all(`SELECT v.* FROM memory_document_version v JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE v.owner_id=? AND s.task_id=? AND s.kind='document_scene' AND s.state='succeeded' AND a.state='succeeded' AND v.content_state='present' ORDER BY v.document_id`,[ownerId,t.id]))
  tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,document_id,document_version_no,publication_id) VALUES(?,?,?,'document',?,?,NULL)",[ownerId,stepId,++inputNo,v.document_id,v.version_no]);
 tx.run("INSERT INTO step_attempt VALUES(?,?,?,1,?,?,?,?,?,'running',?,NULL,NULL)",[ownerId,attemptId,stepId,t.resume_no,randomUUID(),now+300_000,t.control_revision,lease.runtimeId,now]);
  let renderMembers=members;
  if(kind==='document_profile'){
   // 继续暂停前的任务时，主题版本可能已保存但尚未发布；画像输入必须使用本轮真实场景版本。
   const staged=tx.all(`SELECT v.*,d.kind,d.scope_kind,d.contact_id,d.state FROM memory_document_version v JOIN memory_document d ON d.owner_id=v.owner_id AND d.id=v.document_id
    JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
    WHERE v.owner_id=? AND s.task_id=? AND s.kind='document_scene' AND s.state='succeeded' AND a.state='succeeded' AND v.content_state='present' ORDER BY d.id`,[ownerId,t.id]);
   const stagedIds=new Set(staged.map(row=>String(row.document_id)));
   renderMembers=[...members.filter(member=>!stagedIds.has(String(member.document_id))),...staged];
  }
  const rendered=renderDocuments(tx,ownerId,renderMembers,selected.map(x=>x.memory));
 return {attemptId,stepId,taskId:String(t.id),runId:String(t.run_id),kind,scopeKind:t.scope_kind as 'self'|'contact',contactId:t.contact_id as string|null,claim:{task_id:String(t.id),step_id:stepId,step_name:kind,worker_id:lease.runtimeId,lease_generation:Number(t.resume_no)},memories:selected.map(x=>x.memory),scenarios:rendered.scenarios,profile:rendered.profile};
}
export function current(tx:StorageTransaction,ownerId:string,attemptId:string,lease:StorageLease):{attempt:StorageRow;t:StorageRow} {
 const a=tx.get(`SELECT a.*,s.kind,s.state AS step_state,t.id AS task_id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE a.owner_id=? AND a.id=?`,[ownerId,attemptId]);
 if(!a||a.state!=='running'||a.step_state!=='running'||a.runtime_token!==lease.runtimeId||BigInt(Date.now())>(a.lease_expires_at as bigint))fail('document_attempt_stale');
 const t=task(tx,ownerId,String(a!.task_id));if(a!.accepted_control_revision!==t.control_revision)fail('document_attempt_stale');
 preconditions(tx,ownerId,t,{allowPaused:true});const r=revisions(tx,ownerId,t);
 if(t.document_basis_state!=='frozen'||r.memory_revision!==t.accepted_memory_revision||r.document_revision!==t.accepted_document_revision||r.current_publication_id!==t.accepted_publication_id)fail('document_publication_conflict');
 frozenMemories(tx,ownerId,String(a!.step_id));
 for(const i of tx.all("SELECT * FROM step_input WHERE owner_id=? AND step_id=? AND kind='message'",[ownerId,a!.step_id]))sourceStillValid(tx,ownerId,{contactId:String(i.source_contact_id),messageId:String(i.message_id),recordId:String(i.record_id),acceptedRevision:i.accepted_revision as bigint});
 if(t.accepted_publication_id!==null)eligiblePriorMembers(tx,ownerId,t);
 return {attempt:a!,t};
}
function appendEvent(tx:StorageTransaction,ownerId:string,attempt:StorageRow,kind:string,payload:unknown,callId:string):string {
 const input=kind==='document_input'?payload:tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='document_input' AND originated_call_id=?",[ownerId,attempt.id,callId])?.payload;
 if(!input)fail('document_input_incomplete');
 const request=kind==='document_input'?input:JSON.parse(String(input)),actual=documentActualInputs(tx,ownerId,String(attempt.step_id),request);
 if(kind==='document_output'){
  const existing=tx.all(`SELECT x.* FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id
   WHERE e.owner_id=? AND e.step_attempt_id=? AND e.kind='document_input' AND e.originated_call_id=? ORDER BY x.presentation_no`,[ownerId,attempt.id,callId]);
  if(existing.length!==actual.length||existing.some((x,index)=>x.planned_step_id!==attempt.step_id||x.planned_input_no!==actual[index]?.row.input_no||x.role!==actual[index]?.role||x.presentation_no!==BigInt(index+1)))fail('document_input_incomplete');
 }
 const eventId=randomUUID(),n=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attempt.id])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)',[ownerId,eventId,attempt.id,n,kind,callId,JSON.stringify(payload),Date.now()]);
 for(const [index,item] of actual.entries())tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,index+1,item.role,index+1,attempt.step_id,item.row.input_no]);
 for(const source of actualInputSources(tx,ownerId,actual))tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[ownerId,eventId,source.contactId,source.recordId]);
 return eventId;
}
function unchangedContributions(tx:StorageTransaction,ownerId:string,oldTaskId:string,newTaskId:string):boolean {
 const rows=(taskId:string)=>tx.all(`SELECT c.source_contact_id,r.grant_id,r.binding_id,r.accepted_selection_generation,r.accepted_data_generation,
  r.accepted_identity_generation,r.accepted_account_revision,r.accepted_source_generation,r.accepted_feedback_revision
  FROM task_contribution c JOIN run_contact r ON r.owner_id=c.owner_id AND r.run_id=c.run_id AND r.contact_id=c.source_contact_id
  WHERE c.owner_id=? AND c.task_id=? ORDER BY c.source_contact_id`,[ownerId,taskId]);
 const old=rows(oldTaskId),current=rows(newTaskId),keys=['source_contact_id','grant_id','binding_id','accepted_selection_generation','accepted_data_generation','accepted_identity_generation','accepted_account_revision','accepted_source_generation','accepted_feedback_revision'];
 return old.length>0&&old.length===current.length&&old.every((row,index)=>keys.every(key=>row[key]===current[index]?.[key]));
}
function unchangedMembers(tx:StorageTransaction,ownerId:string,t:StorageRow,base:StorageRow):StorageRow[]|null {
 if(base.current_publication_id===null)return null;
 const prior=tx.get(`SELECT p.*,previous.accepted_memory_revision AS prior_memory_revision,previous.document_basis_state AS prior_basis_state
  FROM document_publication p JOIN processing_task previous ON previous.owner_id=p.owner_id AND previous.id=p.basis_task_id
  WHERE p.owner_id=? AND p.id=? AND p.scope_kind=? AND p.contact_id IS ?`,[ownerId,base.current_publication_id,t.scope_kind,t.contact_id]);
 if(!prior||prior.availability!=='available'||prior.prior_basis_state!=='frozen'||prior.prior_memory_revision!==base.memory_revision||!unchangedContributions(tx,ownerId,String(prior.basis_task_id),String(t.id)))return null;
 const members=eligiblePriorMembers(tx,ownerId,t);
 if(!members.length||BigInt(members.length)!==prior.member_count)return null;
 publicationMembers(tx,ownerId,String(prior.id),String(t.scope_kind),t.contact_id as string|null);
 return members;
}
function fixedPublication(tx:StorageTransaction,ownerId:string,t:StorageRow,base:StorageRow,members:StorageRow[],reason:string){
 const next=tx.get('SELECT coalesce(max(step_no),0) AS n FROM processing_step WHERE owner_id=? AND task_id=?',[ownerId,t.id])!.n as bigint;
 for(const [index,kind] of ['document_scene','document_profile'].entries())tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,not_applicable_reason,accepted_memory_revision) VALUES(?,?,?,?,?,'not_applicable','frozen',?,?)",[ownerId,randomUUID(),t.id,next+BigInt(index+1),kind,reason,base.memory_revision]);
 const p=randomUUID(),number=tx.get('SELECT coalesce(max(publication_no),0)+1 AS n FROM document_publication WHERE owner_id=? AND scope_kind=? AND contact_id IS ?',[ownerId,t.scope_kind,t.contact_id])!.n;
 tx.run("INSERT INTO document_publication VALUES(?,?,?,?,?,?,'documents-v1',?,?,?,?,'available')",[ownerId,p,t.scope_kind,t.contact_id,number,t.run_id,t.id,Date.now(),members.length,publicationDigest(members.map(member=>({documentId:String(member.document_id),versionNo:member.version_no as bigint})))]);
 for(const member of members)tx.run('INSERT INTO publication_member VALUES(?,?,?,?)',[ownerId,p,member.document_id,member.version_no]);
 if(t.scope_kind==='self')tx.run('UPDATE owner SET current_publication_id=?,document_revision=document_revision+1 WHERE owner_id=? AND memory_revision=? AND document_revision=? AND current_publication_id IS ?',[p,ownerId,base.memory_revision,base.document_revision,base.current_publication_id]);
 else tx.run('UPDATE contact SET current_publication_id=?,document_revision=document_revision+1 WHERE owner_id=? AND id=? AND memory_revision=? AND document_revision=? AND current_publication_id IS ?',[p,ownerId,t.contact_id,base.memory_revision,base.document_revision,base.current_publication_id]);
 if(revisions(tx,ownerId,t).current_publication_id!==p)fail('document_publication_conflict');
}
export const memoryDocumentsStageActions:StorageAction[]=[
 act('noteFailure','write',(tx,i)=>{const t=task(tx,textId(i.ownerId),textId(i.taskId));if(t.state!=='revoked')tx.run('UPDATE processing_task SET error_code=? WHERE owner_id=? AND id=?',[textId(i.code),i.ownerId,i.taskId]);return true;}),
 act('runPaused','read',(tx,i)=>runPaused(tx,textId(i.ownerId),textId(i.runId))),
 act('recover','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId);
  const attempts=tx.all(`SELECT a.id,a.step_id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
   WHERE a.owner_id=? AND s.kind IN ('document_scene','document_profile') AND a.state='running' AND a.runtime_token<>?`,[ownerId,lease.runtimeId]);
  for(const a of attempts){
   tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=? AND state='sending'",[ownerId,a.id]);
   tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id=? AND state='prepared'",[ownerId,a.id]);
   const unknown=!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='unknown'",[ownerId,a.id]);
   for(const o of tx.all('SELECT operation_id,state FROM model_call WHERE owner_id=? AND step_attempt_id=?',[ownerId,a.id])){
    tx.run("UPDATE model_operation SET state=? WHERE owner_id=? AND id=? AND state<>'sealed'",[o.state==='unknown'?'unknown':'failed',ownerId,o.operation_id]);
    for(const table of ['operation_item','operation_scope','document_effect_scope'])tx.run(`UPDATE ${table} SET state=? WHERE owner_id=? AND operation_id=?`,[o.state==='unknown'?'unknown':'released',ownerId,o.operation_id]);
   }
   tx.run('UPDATE step_attempt SET state=?,finished_at=?,error_code=? WHERE owner_id=? AND id=?',[unknown?'unknown':'failed',Date.now(),'runtime_interrupted',ownerId,a.id]);
   tx.run("UPDATE processing_step SET state=? WHERE owner_id=? AND id=? AND state='running'",[unknown?'unknown':'failed',ownerId,a.step_id]);
  }
  return attempts.length;
 }),
 act('claimScene','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId),t=task(tx,ownerId,textId(i.taskId));
  // 普通暂停只阻止新小批；已完成的提取核验与正在执行的场景批次可收尾，继续后再领取主题。
  if(runPaused(tx,ownerId,String(t.run_id)))return null;
  if(t.document_basis_state!=='pending')return null;
  preconditions(tx,ownerId,t);const base=revisions(tx,ownerId,t),selected=eligible(tx,ownerId,t);
  tx.run("UPDATE processing_task SET document_basis_state='frozen',accepted_memory_revision=?,accepted_document_revision=?,accepted_publication_id=? WHERE owner_id=? AND id=? AND document_basis_state='pending'",[base.memory_revision,base.document_revision,base.current_publication_id,ownerId,t.id]);
  const frozen=task(tx,ownerId,String(t.id));
  if(!selected.length){if(base.current_publication_id!==null&&eligiblePriorMembers(tx,ownerId,frozen).length)fail('document_existing_collection_requires_review');fixedPublication(tx,ownerId,frozen,base,[],'no_eligible_memories');return null;}
  const unchanged=unchangedMembers(tx,ownerId,frozen,base);
  if(unchanged){fixedPublication(tx,ownerId,frozen,base,unchanged,'unchanged_memories');return null;}
  return createStep(tx,ownerId,frozen,'document_scene',lease);
 }),
 act('claimProfile','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId),t=task(tx,ownerId,textId(i.taskId));
  if(tx.get("SELECT 1 FROM processing_step WHERE owner_id=? AND task_id=? AND kind='document_profile'",[ownerId,t.id]))return null;
  if(runPaused(tx,ownerId,String(t.run_id)))return null;
  const scene=tx.get("SELECT successful_attempt_id FROM processing_step WHERE owner_id=? AND task_id=? AND kind='document_scene' AND state='succeeded'",[ownerId,t.id]);
  if(!scene)fail('document_scene_incomplete');
  preconditions(tx,ownerId,t);const r=revisions(tx,ownerId,t);
  if(r.memory_revision!==t.accepted_memory_revision||r.document_revision!==t.accepted_document_revision||r.current_publication_id!==t.accepted_publication_id)fail('document_publication_conflict');
  return createStep(tx,ownerId,t,'document_profile',lease);
 }),
 act('current','read',(tx,i,lease)=>{current(tx,textId(i.ownerId),textId(i.attemptId),lease);return true;}),
 act('holders','read',(tx,i,lease)=>{const {t}=current(tx,textId(i.ownerId),textId(i.attemptId),lease);return tx.all('SELECT c.id AS contact_id,c.data_generation FROM task_contribution tc JOIN contact c ON c.owner_id=tc.owner_id AND c.id=tc.source_contact_id WHERE tc.owner_id=? AND tc.task_id=?',[i.ownerId,t.id]).map(r=>({contactId:String(r.contact_id),generation:String(r.data_generation)}));}),
 act('prepareCall','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId),{attempt,t}=current(tx,ownerId,textId(i.attemptId),lease);
  if(!Number.isSafeInteger(i.inputCap)||i.inputCap<1||!Number.isSafeInteger(i.outputCap)||i.outputCap<1)fail('document_model_configuration_invalid');
  if(tx.get("SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE o.owner_id=? AND o.memory_step_id=? AND c.state IN ('sending','unknown','prepared')",[ownerId,attempt.step_id]))fail('document_model_unknown');
  const occupied=tx.get("SELECT state FROM document_effect_scope WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND effect_kind=? AND state IN ('reserved','sent','unknown')",[ownerId,t.scope_kind,t.contact_id,attempt.kind]);
  if(occupied)fail(occupied.state==='unknown'?'document_model_unknown':'document_model_in_progress');
  const operationId=randomUUID(),callId=randomUUID(),requestId=randomUUID(),slot=tx.get('SELECT coalesce(max(slot),-1)+1 AS n FROM model_operation WHERE owner_id=? AND memory_step_id=?',[ownerId,attempt.step_id])!.n;
  tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,?,?,?,?,'prepared')",[ownerId,operationId,attempt.kind,attempt.step_id,slot,digest(i.request)]);
  tx.run("INSERT INTO document_effect_scope(owner_id,operation_id,scope_kind,contact_id,effect_kind,state) VALUES(?,?,?,?,?,'reserved')",[ownerId,operationId,t.scope_kind,t.contact_id,attempt.kind]);
  for(const item of tx.all("SELECT DISTINCT i.item_id FROM task_contribution c JOIN run_input i ON i.owner_id=c.owner_id AND i.run_id=c.run_id AND i.source_contact_id=c.source_contact_id WHERE c.owner_id=? AND c.task_id=? AND i.role='target'",[ownerId,t.id]))tx.run("INSERT INTO operation_item VALUES(?,?,?,?,'reserved')",[ownerId,operationId,item.item_id,attempt.kind]);
  for(const c of tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[ownerId,t.id]))tx.run("INSERT INTO operation_scope VALUES(?,?,?,?,'reserved')",[ownerId,operationId,c.source_contact_id,attempt.kind]);
  tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,step_attempt_id,provider,request_key,state,reserved_budget_units,settlement_state,model,configuration_id,input_cap,output_cap) VALUES(?,?,?,1,?,?,?,'prepared',0,'reserved',?,?,?,?)",[ownerId,callId,operationId,attempt.id,textId(i.provider),requestId,textId(i.model),textId(i.configurationId),i.inputCap,i.outputCap]);
  appendEvent(tx,ownerId,attempt,'document_input',i.request,callId);return {callId,requestId};
 }),
 act('reserve','write',(tx,i,lease)=>{
  const r=i.receipt as ModelLedgerReceipt,claim=i.claim as ModelTaskClaim;validateModelLedgerReceipt(r);
  const c=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=? AND request_key=?',[r.owner_id,r.attempt_id,r.request_id]);if(!c?.step_attempt_id)fail('document_reservation_missing');
  const {attempt,t}=current(tx,r.owner_id,String(c!.step_attempt_id),lease);
  if(!claim||claim.task_id!==t.id||claim.step_id!==attempt.step_id||claim.step_name!==attempt.kind||claim.worker_id!==lease.runtimeId||BigInt(claim.lease_generation)!==t.resume_no||r.contact_id!==t.contact_id||r.provider!==c!.provider||r.model!==c!.model)fail('document_model_scope_invalid');
  const b=r.input_budget;if(!b||b.input_tokens>Number(c!.input_cap)||b.max_output_tokens!==Number(c!.output_cap)||c!.state!=='prepared')fail('document_model_budget_invalid');
  tx.run("UPDATE model_call SET state='sending',sent_at=?,reserved_budget_units=?,receipt=? WHERE owner_id=? AND id=?",[Date.now(),b!.input_tokens+b!.max_output_tokens,JSON.stringify(r),r.owner_id,c!.id]);
  tx.run("UPDATE model_operation SET state='in_flight' WHERE owner_id=? AND id=?",[r.owner_id,c!.operation_id]);
  for(const table of ['operation_item','operation_scope','document_effect_scope'])tx.run(`UPDATE ${table} SET state='sent' WHERE owner_id=? AND operation_id=?`,[r.owner_id,c!.operation_id]);return true;
 }),
 act('output','write',(tx,i,lease)=>{
  const ownerId=textId(i.ownerId),{attempt}=current(tx,ownerId,textId(i.attemptId),lease);
  if(!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND id=? AND step_attempt_id=? AND state='succeeded'",[ownerId,i.callId,attempt.id]))fail('document_output_unbound');
  const eventId=appendEvent(tx,ownerId,attempt,'document_output',{blocks:i.blocks},textId(i.callId));
  for(const table of ['operation_item','operation_scope','document_effect_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id=(SELECT operation_id FROM model_call WHERE owner_id=? AND id=?)`,[ownerId,ownerId,i.callId]);
  return eventId;
 }),
 act('fail','write',(tx,i)=>{
  const ownerId=textId(i.ownerId),a=tx.get("SELECT * FROM step_attempt WHERE owner_id=? AND id=? AND state='running'",[ownerId,textId(i.attemptId)]);if(!a)return false;
  tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=? AND state='sending'",[ownerId,a.id]);
  tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id=? AND state='prepared'",[ownerId,a.id]);
  const unknown=!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='unknown'",[ownerId,a.id]);
  for(const o of tx.all('SELECT operation_id,state FROM model_call WHERE owner_id=? AND step_attempt_id=?',[ownerId,a.id])){
   tx.run("UPDATE model_operation SET state=? WHERE owner_id=? AND id=? AND state<>'sealed'",[o.state==='unknown'?'unknown':'failed',ownerId,o.operation_id]);
   for(const table of ['operation_item','operation_scope','document_effect_scope'])tx.run(`UPDATE ${table} SET state=? WHERE owner_id=? AND operation_id=?`,[o.state==='unknown'?'unknown':'released',ownerId,o.operation_id]);
  }
  const state=unknown?'unknown':'failed';tx.run('UPDATE step_attempt SET state=?,finished_at=?,error_code=? WHERE owner_id=? AND id=?',[state,Date.now(),textId(i.code),ownerId,a.id]);
  tx.run("UPDATE processing_step SET state=? WHERE owner_id=? AND id=? AND state='running'",[state,ownerId,a.step_id]);return true;
 }),
];
