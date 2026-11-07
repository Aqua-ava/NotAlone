import {randomUUID} from 'node:crypto';
import type {StorageAction,StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {assertInputs,assertTaskContributions,fail,textId} from '../qualification.ts';
import {available,scope as readScope} from '../management/qualification.ts';
import {memoryBasis,publicationMembers,renderDocuments,withSourceMemo} from './basis.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import {laterStagesState as scheduledLaterStagesState,type LaterStagesProjection} from './later-schedule.ts';

export function task(tx:StorageTransaction,ownerId:string,taskId:string):StorageRow {
 const row=tx.get('SELECT * FROM processing_task WHERE owner_id=? AND id=?',[ownerId,taskId]);
 if(!row)fail('document_task_not_found');return row!;
}
function laterStageForTask(tx:StorageTransaction,ownerId:string,t:StorageRow):string|null {
 const run=tx.get('SELECT policy_config FROM processing_run WHERE owner_id=? AND id=?',[ownerId,t.run_id]);
 if(!run)return null;
 try{const policy=JSON.parse(String(run.policy_config));return policy?.intent==='memory_document_later_stage'&&['document_scene','document_profile'].includes(policy.stage)?String(policy.stage):null;}catch{return null;}
}
export function revisions(tx:StorageTransaction,ownerId:string,t:StorageRow):StorageRow {
 const row=t.scope_kind==='self'?tx.get('SELECT memory_revision,document_revision,current_publication_id FROM owner WHERE owner_id=?',[ownerId]):
  tx.get('SELECT memory_revision,document_revision,current_publication_id FROM contact WHERE owner_id=? AND id=?',[ownerId,t.contact_id]);
 if(!row)fail('document_scope_stale');return row!;
}
export function preconditions(tx:StorageTransaction,ownerId:string,t:StorageRow,options:{allowPaused?:boolean}={}):void {
 available(tx,ownerId,{scopeKind:t.scope_kind as 'self'|'contact',contactId:t.contact_id as string|null},true);
 if(!['succeeded','awaiting_decision'].includes(String(t.state)))fail('document_preceding_stage_incomplete');
 const run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,t.run_id]);
 if(!run||run.state==='revoked')fail('document_preceding_stage_incomplete');
 // 普通暂停只阻止新小批；已启动的步骤允许收尾，继续后再处理后续阶段。
 if(!options.allowPaused&&(run!.pause_requested_at!==null||run!.state==='paused'))fail('document_preceding_stage_incomplete');
 if(run!.state==='failed'){
  // 仅放行其他联系人的局部提取失败；公共模型故障仍由整轮暂停保护。
  const failedContact=tx.get("SELECT 1 FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact' AND id<>? AND state='failed'",[ownerId,t.run_id,t.id]);
  const commonFailure=tx.get(`SELECT 1 FROM processing_task failed JOIN processing_step s ON s.owner_id=failed.owner_id AND s.task_id=failed.id AND s.kind='extraction_verification' AND s.state='failed'
   JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id AND a.state='failed' AND a.attempt_no=(SELECT max(latest.attempt_no) FROM step_attempt latest WHERE latest.owner_id=s.owner_id AND latest.step_id=s.id)
   WHERE failed.owner_id=? AND failed.run_id=? AND failed.state='failed' AND a.error_code IN ('extraction_model_unconfigured','extraction_model_configuration_invalid','extraction_model_credentials_unavailable','extraction_model_authentication_failed','extraction_model_provider_unavailable') LIMIT 1`,[ownerId,t.run_id]);
  if(t.scope_kind!=='contact'||!failedContact||commonFailure)fail('document_preceding_stage_incomplete');
 }
 const contributions=tx.get('SELECT 1 FROM task_contribution WHERE owner_id=? AND task_id=? LIMIT 1',[ownerId,t.id]);
 if(contributions||!laterStageForTask(tx,ownerId,t))assertTaskContributions(tx,ownerId,String(t.run_id),String(t.id));
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
 const mode=laterStageForTask(tx,ownerId,t),complete=publication&&steps.every(s=>['succeeded','not_applicable'].includes(s.status))&&
  (mode?steps.some(s=>s.kind===(mode==='document_scene'?'scene':'profile')):steps.length===2);
 const run=tx.get('SELECT started_at FROM processing_run WHERE owner_id=? AND id=?',[ownerId,t.run_id]);
 return {taskId,laterStage:mode,scheduleNow:mode&&run?Number(run.started_at):null,publicationId:publication?String(publication.id):null,basis:{state:String(t.document_basis_state),memoryRevision:t.accepted_memory_revision===null?null:String(t.accepted_memory_revision),documentRevision:t.accepted_document_revision===null?null:String(t.accepted_document_revision),publicationId:t.accepted_publication_id===null?null:String(t.accepted_publication_id)},stages:steps,errorCode:t.error_code===null?null:String(t.error_code),outcome:complete?'completed':'incomplete'};
}
export interface LaterStagesState extends LaterStagesProjection {}
/** 整轮后置阶段投影：completed 仅在全部任务适用阶段结束、完整发布集合仍可用且无未解未知文档调用时成立。 */
export function laterStagesState(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string):LaterStagesState {
 const scheduled=scheduledLaterStagesState(tx,ownerId,runId,contactId);if(scheduled)return scheduled;
 const run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 if(!run)return {state:'pending',reasons:['document_run_missing'],nextDueAt:null,stage:null};
 if(run.state==='revoked')return {state:'revoked',reasons:['document_run_revoked'],nextDueAt:null,stage:null};
 // 12 及更早结构没有文档表；迁移前的轮次视图不能据此宣称后置阶段完成。
 if(!tx.get('SELECT 1 FROM schema_migration WHERE version=13'))return {state:run.state==='completed'?'completed':run.state==='failed'?'failed':'pending',reasons:['document_schema_unavailable'],nextDueAt:null,stage:null};
 const reasons:string[]=[];
 const tasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[ownerId,runId]).filter(task=>contactId===undefined||task.scope_kind==='contact'&&task.contact_id===contactId);
 if(!tasks.length)reasons.push('document_run_without_tasks');
 for(const t of tasks){
  const view=taskView(tx,ownerId,String(t.id));
  if(view.outcome!=='completed'){reasons.push(`document_task_${String(t.id)}_${view.errorCode??'incomplete'}`);continue;}
  const p=tx.get("SELECT * FROM document_publication WHERE owner_id=? AND basis_task_id=? AND availability='available'",[ownerId,t.id]);
  const current=revisions(tx,ownerId,t);
  if(!p||current.current_publication_id!==p.id){reasons.push(`document_publication_${String(t.id)}_unavailable`);continue;}
  try{publicationMembers(tx,ownerId,String(p.id),String(t.scope_kind),t.contact_id as string|null);}
  catch{reasons.push(`document_publication_${String(t.id)}_incomplete`);}
 }
 // 未解 unknown 仍可能出现在租约或调用回执上；不能以缺记录或任务态冒充完成。
 const unresolved=tx.get(`SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND s.kind IN ('document_scene','document_profile')
  ${contactId===undefined?'':" AND t.scope_kind='contact' AND t.contact_id=?"}
  AND (s.state='unknown' OR EXISTS(SELECT 1 FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id AND a.state='unknown')
   OR EXISTS(SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE o.owner_id=s.owner_id AND o.memory_step_id=s.id AND c.state='unknown')) LIMIT 1`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
 if(unresolved)reasons.push('document_call_unknown');
 if(reasons.length)return {state:(contactId===undefined?run.state==='failed':tasks.some(task=>task.state==='failed'))?'failed':'pending',reasons,nextDueAt:null,stage:null};
 return contactId!==undefined||run.state==='completed'?{state:'completed',reasons:[],nextDueAt:null,stage:null}:{state:'pending',reasons:[`document_run_${String(run.state)}`],nextDueAt:null,stage:null};
}
function noFormalChangeStatus(tx:StorageTransaction,ownerId:string,s:{scopeKind:'self'|'contact';contactId:string|null},latest:StorageRow):'idle'|'processing'|'needs_revalidation'|null {
 if(latest.state!=='succeeded'&&!(s.scopeKind==='self'&&latest.state==='awaiting_decision'))return null;
 if(tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('memory_document_later_schedule','memory_document_later_run_requirement')").length!==2)return null;
 const scopeKey=s.scopeKind==='self'?'self':s.contactId;
 // 空内容和缺少文档步骤都不是完成证明；这里只采用 L1 已登记的同范围无正式变化事实。
 if(!tx.get("SELECT 1 FROM memory_document_later_run_requirement WHERE owner_id=? AND run_id=? AND scope_kind=? AND scope_key=? AND contact_id IS ? AND outcome='no_formal_change' AND reason='no_formal_memory_change' AND generation IS NULL",[ownerId,latest.run_id,s.scopeKind,scopeKey,s.contactId]))return null;
 if(tx.get(`SELECT 1 FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id
  WHERE s.owner_id=? AND s.task_id=? AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown') LIMIT 1`,[ownerId,latest.id]))return 'needs_revalidation';
 const schedule=tx.all("SELECT state FROM memory_document_later_schedule WHERE owner_id=? AND scope_kind=? AND scope_key=? AND contact_id IS ? AND state IN ('scheduled','running','failed','unknown')",[ownerId,s.scopeKind,scopeKey,s.contactId]);
 const requirements=tx.all("SELECT outcome FROM memory_document_later_run_requirement WHERE owner_id=? AND scope_kind=? AND scope_key=? AND contact_id IS ? AND outcome IN ('pending','failed','unknown','revoked')",[ownerId,s.scopeKind,scopeKey,s.contactId]);
 if(schedule.some(row=>['failed','unknown'].includes(String(row.state)))||requirements.some(row=>['failed','unknown','revoked'].includes(String(row.outcome))))return 'needs_revalidation';
 if(tx.get(`SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
  WHERE s.owner_id=? AND s.task_id=? AND c.state='pending' LIMIT 1`,[ownerId,latest.id]))return 'processing';
 return schedule.length||requirements.length?'processing':'idle';
}
const action=(name:string,mode:'read'|'write',fn:(tx:StorageTransaction,input:any)=>unknown):StorageAction=>({name:`memoryDocuments.${name}`,mode,retryBusy:false,execute:fn});
export const memoryDocumentsActions:StorageAction[]=[
 action('tasks','read',(tx,i)=>tx.all('SELECT id FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[textId(i.ownerId),textId(i.runId)]).map(row=>String(row.id))),
 action('readTask','read',(tx,i)=>taskView(tx,textId(i.ownerId),textId(i.taskId))),
 action('read','read',(tx,i)=>withSourceMemo(()=>{
  const ownerId=textId(i.ownerId),s=readScope(i.scope);available(tx,ownerId,s);
  const scope={scopeKind:s.scopeKind,contactId:s.contactId};
  if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND scope_kind<>'superseded_history'",[ownerId]))return {scope,publication:null,documents:[],status:'needs_revalidation'};
  const latest=tx.get(`SELECT t.id,t.run_id,t.state,t.document_basis_state FROM processing_task t JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id WHERE t.owner_id=? AND t.scope_kind=? AND t.contact_id IS ? ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`,[ownerId,s.scopeKind,s.contactId]);
  const view=latest?taskView(tx,ownerId,String(latest.id)):null;
  const failed=view?.stages.find(step=>['failed','unknown','revoked'].includes(step.status));
  const code=failed?.errorCode??view?.errorCode??null;
  const conflict=code!==null&&['document_publication_conflict','document_memory_stale','document_attempt_stale'].includes(code);
  const unchanged=latest?noFormalChangeStatus(tx,ownerId,s,latest):null;
  const status=!latest?'idle':conflict?'conflict':failed||code?'needs_revalidation':view?.outcome==='completed'?'completed':unchanged??'processing';
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
   const publishedStatus=(unchanged==='idle'&&status==='idle')||(!conflict&&view?.outcome==='completed'&&p.basis_task_id===latest?.id)?'completed':status;
   return {scope,publication:{id:String(p.id),members},documents:rendered.documents,status:publishedStatus};
  }catch(error){if(error instanceof StorageFailure)return {scope,publication:null,documents:[],status:'needs_revalidation'};throw error;}
 })),
];
