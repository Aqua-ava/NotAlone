import {randomUUID} from 'node:crypto';
import type {StorageAction,StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {assertInputs,assertTaskContributions,fail,textId} from '../qualification.ts';
import {available,scope as readScope} from '../management/qualification.ts';
import {memoryBasis,publicationMembers,renderDocuments} from './basis.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';

export function task(tx:StorageTransaction,ownerId:string,taskId:string):StorageRow {
 const row=tx.get('SELECT * FROM processing_task WHERE owner_id=? AND id=?',[ownerId,taskId]);
 if(!row)fail('document_task_not_found');return row!;
}
export function revisions(tx:StorageTransaction,ownerId:string,t:StorageRow):StorageRow {
 const row=t.scope_kind==='self'?tx.get('SELECT memory_revision,document_revision,current_publication_id FROM owner WHERE owner_id=?',[ownerId]):
  tx.get('SELECT memory_revision,document_revision,current_publication_id FROM contact WHERE owner_id=? AND id=?',[ownerId,t.contact_id]);
 if(!row)fail('document_scope_stale');return row!;
}
export function preconditions(tx:StorageTransaction,ownerId:string,t:StorageRow):void {
 available(tx,ownerId,{scopeKind:t.scope_kind as 'self'|'contact',contactId:t.contact_id as string|null},true);
 if(!['succeeded','awaiting_decision'].includes(String(t.state)))fail('document_preceding_stage_incomplete');
 const run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,t.run_id]);
 if(!run||run.pause_requested_at!==null||['revoked','failed','paused'].includes(String(run.state)))fail('document_preceding_stage_incomplete');
 assertTaskContributions(tx,ownerId,String(t.run_id),String(t.id));
 const inputs=tx.all(`SELECT i.* FROM run_input i JOIN task_contribution c ON c.owner_id=i.owner_id AND c.run_id=i.run_id AND c.source_contact_id=i.source_contact_id
  WHERE c.owner_id=? AND c.task_id=? ORDER BY i.input_no`,[ownerId,t.id]);
 assertInputs(tx,ownerId,String(t.run_id),inputs);
 if(tx.get(`SELECT 1 FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
  LEFT JOIN memory_candidate c ON c.owner_id=e.owner_id AND c.event_id=e.id
  WHERE e.owner_id=? AND s.task_id=? AND e.kind='verified_output' AND (c.id IS NULL OR c.state='pending') LIMIT 1`,[ownerId,t.id]))fail('document_preceding_stage_incomplete');
}
export function stages(tx:StorageTransaction,ownerId:string,taskId:string){
 return tx.all("SELECT s.kind,s.state,s.not_applicable_reason,(SELECT a.error_code FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id ORDER BY a.attempt_no DESC LIMIT 1) AS error_code FROM processing_step s WHERE s.owner_id=? AND s.task_id=? AND s.kind IN ('document_scene','document_profile') ORDER BY s.step_no",[ownerId,taskId]).map(s=>({kind:s.kind==='document_scene'?'scene':'profile',status:String(s.state),reason:s.not_applicable_reason===null?null:String(s.not_applicable_reason),errorCode:s.error_code===null?null:String(s.error_code)}));
}
export function taskView(tx:StorageTransaction,ownerId:string,taskId:string){
 const t=task(tx,ownerId,taskId),steps=stages(tx,ownerId,taskId);
 const publication=tx.get('SELECT id FROM document_publication WHERE owner_id=? AND basis_task_id=? AND availability=\'available\'',[ownerId,taskId]);
 return {taskId,basis:{state:String(t.document_basis_state),memoryRevision:t.accepted_memory_revision===null?null:String(t.accepted_memory_revision),documentRevision:t.accepted_document_revision===null?null:String(t.accepted_document_revision),publicationId:t.accepted_publication_id===null?null:String(t.accepted_publication_id)},stages:steps,errorCode:t.error_code===null?null:String(t.error_code),outcome:publication&&steps.length===2&&steps.every(s=>['succeeded','not_applicable'].includes(s.status))?'completed':'incomplete'};
}
const action=(name:string,mode:'read'|'write',fn:(tx:StorageTransaction,input:any)=>unknown):StorageAction=>({name:`memoryDocuments.${name}`,mode,retryBusy:false,execute:fn});
export const memoryDocumentsActions:StorageAction[]=[
 action('tasks','read',(tx,i)=>tx.all('SELECT id FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[textId(i.ownerId),textId(i.runId)]).map(row=>String(row.id))),
 action('readTask','read',(tx,i)=>taskView(tx,textId(i.ownerId),textId(i.taskId))),
 action('read','read',(tx,i)=>{
  const ownerId=textId(i.ownerId),s=readScope(i.scope);available(tx,ownerId,s);
  const scope={scopeKind:s.scopeKind,contactId:s.contactId};
  if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))return {scope,publication:null,documents:[],status:'needs_revalidation'};
  const latest=tx.get(`SELECT t.id,t.state,t.document_basis_state FROM processing_task t JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id WHERE t.owner_id=? AND t.scope_kind=? AND t.contact_id IS ? ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`,[ownerId,s.scopeKind,s.contactId]);
  const view=latest?taskView(tx,ownerId,String(latest.id)):null;
  const failed=view?.stages.find(step=>['failed','unknown','revoked'].includes(step.status));
  const code=failed?.errorCode??view?.errorCode??null;
  const conflict=code!==null&&['document_publication_conflict','document_memory_stale','document_attempt_stale'].includes(code);
  const status=!latest?'idle':conflict?'conflict':failed||code?'needs_revalidation':view?.outcome==='completed'?'completed':'processing';
  const base=revisions(tx,ownerId,{scope_kind:s.scopeKind,contact_id:s.contactId});
  const p=base.current_publication_id&&tx.get("SELECT * FROM document_publication WHERE owner_id=? AND id=? AND scope_kind=? AND contact_id IS ? AND availability='available'",[ownerId,base.current_publication_id,s.scopeKind,s.contactId]);
  if(!p)return {scope,publication:null,documents:[],status:base.current_publication_id||((base.document_revision as bigint)>0n&&['idle','completed'].includes(status))?'needs_revalidation':status};
  try {
   const rows=publicationMembers(tx,ownerId,String(p.id),s.scopeKind,s.contactId);
   const memories=tx.all("SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state='active' ORDER BY id",[ownerId,s.scopeKind,s.contactId]).flatMap(m=>{
    const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,m.id,m.current_version_no]);
    if(!v)return [];try{return [memoryBasis(tx,ownerId,m,v).memory];}catch(error){if(error instanceof StorageFailure)return [];throw error;}
   });
   const rendered=renderDocuments(tx,ownerId,rows,memories);
   const members=rows.map(m=>({documentId:String(m.document_id),versionNo:String(m.version_no)}));
   // 共享任务的其他裁决可能因来源删除而撤销；仍须按文档自己的完整依据判断当前发布。
   const publishedStatus=!conflict&&view?.outcome==='completed'&&p.basis_task_id===latest?.id?'completed':status;
   return {scope,publication:{id:String(p.id),members},documents:rendered.documents,status:publishedStatus};
  }catch(error){if(error instanceof StorageFailure)return {scope,publication:null,documents:[],status:'needs_revalidation'};throw error;}
 }),
];
