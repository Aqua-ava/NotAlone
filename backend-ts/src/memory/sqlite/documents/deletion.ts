import {sourceDeletionIds} from '../../../history/sqlite/source-deletion.ts';
import {createHash} from 'node:crypto';
import {StorageFailure,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {CheckResult,DeletionDomain,DeletionOperation,RowDeletionTarget} from '../../../storage/sqlite/deletion/contracts.ts';
import {identityDeletionAuthority} from '../../../contacts/sqlite/deletion.ts';
import {isMediaDeletionScope,mediaDeletionAuthority} from '../../../media/sqlite/deletion.ts';
import {memoryDeletionImpact} from '../deletion-impact.ts';
import {minimalModelReceipt} from '../execution.ts';

const domain='memory_documents';
const rowKinds:DeletionDomain['rowKinds']={
 processing_step:{keys:['owner_id','id'],ownerKey:'owner_id'},
 memory_document_version:{keys:['owner_id','document_id','version_no'],ownerKey:'owner_id'},
 memory_document:{keys:['owner_id','id'],ownerKey:'owner_id'},
 document_publication:{keys:['owner_id','id'],ownerKey:'owner_id'},
 memory_document_later_schedule:{keys:['owner_id','scope_key','generation'],ownerKey:'owner_id'},
 memory_document_later_run_requirement:{keys:['owner_id','run_id','scope_key'],ownerKey:'owner_id'},
 memory_document_later_cursor:{keys:['owner_id','scope_key'],ownerKey:'owner_id'},
};
const allowed=(op:DeletionOperation)=>isMediaDeletionScope(op.scope)||['source','contact_history','contact','account'].includes(op.scope.kind);
const verifyFence=(tx:StorageTransaction,op:DeletionOperation)=>isMediaDeletionScope(op.scope)?mediaDeletionAuthority.verify(tx,op):identityDeletionAuthority.verify(tx,op);
const eraseLedger=(op:DeletionOperation)=>op.scope.kind==='contact'||op.scope.kind==='account';
const installed=(tx:StorageTransaction)=>!!tx.get('SELECT 1 FROM schema_migration WHERE version=13');
const fail=(code:string):never=>{throw new StorageFailure(code);};
const identity=(kind:string,key:Record<string,string>)=>createHash('sha256').update(JSON.stringify([domain,kind,Object.entries(key).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
const pair=(id:unknown,version:unknown)=>JSON.stringify([String(id),String(version)]);
const json=(values:Iterable<string>)=>JSON.stringify([...values]);
interface Closure {steps:Set<string>;documents:Set<string>;versions:Map<string,{documentId:string;versionNo:bigint}>;publications:Set<string>;tasks:Set<string>}
function planned(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{return tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain=? AND target_payload IS NOT NULL",[op.operationId,domain]).map(r=>JSON.parse(String(r.target_payload)) as RowDeletionTarget);}
/** 固定实际输入、跨联系人贡献与后续文档版本闭包；不把同轮无关成功结果当作来源。 */
function closure(tx:StorageTransaction,op:DeletionOperation):Closure {
 const out:Closure={steps:new Set(),documents:new Set(),versions:new Map(),publications:new Set(),tasks:new Set()};
 if(!allowed(op)||!installed(tx))return out;
 const {ownerId,scope}=op;
 const addStep=(id:unknown)=>{if(id!==null&&id!==undefined)out.steps.add(String(id));};
 const addVersion=(id:unknown,v:unknown)=>{if(id!==null&&id!==undefined&&v!==null&&v!==undefined){const versionNo=BigInt(String(v));out.versions.set(pair(id,versionNo),{documentId:String(id),versionNo});}};
 const addPublication=(id:unknown)=>{if(id!==null&&id!==undefined)out.publications.add(String(id));};
 for(const target of planned(tx,op)){
  if(target.rowKind==='memory_document'&&tx.get('SELECT 1 FROM memory_document WHERE owner_id=? AND id=?',[ownerId,target.key.id]))out.documents.add(target.key.id);
  if(target.rowKind==='processing_step'&&tx.get('SELECT 1 FROM processing_step WHERE owner_id=? AND id=?',[ownerId,target.key.id]))addStep(target.key.id);
  if(target.rowKind==='memory_document_version'&&tx.get('SELECT 1 FROM memory_document_version WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,target.key.document_id,BigInt(target.key.version_no)]))addVersion(target.key.document_id,target.key.version_no);
  if(target.rowKind==='document_publication'&&tx.get('SELECT 1 FROM document_publication WHERE owner_id=? AND id=?',[ownerId,target.key.id]))addPublication(target.key.id);
 }
 if(scope.kind==='account'){
  for(const s of tx.all("SELECT id FROM processing_step WHERE owner_id=? AND kind IN ('document_scene','document_profile')",[ownerId]))addStep(s.id);
  for(const d of tx.all('SELECT id FROM memory_document WHERE owner_id=?',[ownerId]))out.documents.add(String(d.id));
  for(const v of tx.all('SELECT document_id,version_no FROM memory_document_version WHERE owner_id=?',[ownerId]))addVersion(v.document_id,v.version_no);
  for(const p of tx.all('SELECT id FROM document_publication WHERE owner_id=?',[ownerId]))addPublication(p.id);
 }else if('contactId' in scope&&!isMediaDeletionScope(scope)){
  const sourceWhere=scope.kind==='source'?'i.record_id IN (SELECT value FROM json_each(?))':'g.accepted_data_generation<?';
  const args=scope.kind==='source'?[ownerId,scope.contactId,JSON.stringify(sourceDeletionIds(tx,op))]:[ownerId,scope.contactId,op.acceptedGeneration];
  for(const s of tx.all(`SELECT DISTINCT s.id FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id
   JOIN capture_record r ON r.owner_id=i.owner_id AND r.contact_id=i.source_contact_id AND r.id=i.record_id AND r.message_id=i.message_id
   JOIN sync_capture sc ON sc.owner_id=r.owner_id AND sc.contact_id=r.contact_id AND sc.id=r.capture_id
   JOIN read_goal g ON g.owner_id=sc.owner_id AND g.contact_id=sc.contact_id AND g.id=sc.goal_id
   WHERE i.owner_id=? AND i.source_contact_id=? AND i.kind='message' AND ${sourceWhere} AND s.kind IN ('document_scene','document_profile')
   AND (s.state<>'succeeded' OR EXISTS(SELECT 1 FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id WHERE x.owner_id=i.owner_id AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no AND e.kind='document_input'))`,args))addStep(s.id);
  const runSource=scope.kind==='source'?'i.record_id IN (SELECT value FROM json_each(?))':'rc.accepted_data_generation<?';
  for(const s of tx.all(`SELECT DISTINCT s.id FROM run_input i JOIN run_contact rc ON rc.owner_id=i.owner_id AND rc.run_id=i.run_id AND rc.contact_id=i.source_contact_id
   JOIN task_contribution c ON c.owner_id=i.owner_id AND c.run_id=i.run_id AND c.source_contact_id=i.source_contact_id
   JOIN processing_step s ON s.owner_id=c.owner_id AND s.task_id=c.task_id
   WHERE i.owner_id=? AND i.source_contact_id=? AND ${runSource} AND s.kind IN ('document_scene','document_profile') AND s.state IN ('pending','running','failed','unknown','revoked','not_applicable')`,args))addStep(s.id);
  if(scope.kind==='contact'){
   for(const d of tx.all("SELECT id FROM memory_document WHERE owner_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,scope.contactId]))out.documents.add(String(d.id));
   for(const v of tx.all("SELECT v.document_id,v.version_no FROM memory_document_version v JOIN memory_document d ON d.owner_id=v.owner_id AND d.id=v.document_id WHERE d.owner_id=? AND d.scope_kind='contact' AND d.contact_id=?",[ownerId,scope.contactId]))addVersion(v.document_id,v.version_no);
   for(const p of tx.all("SELECT id FROM document_publication WHERE owner_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,scope.contactId]))addPublication(p.id);
   for(const s of tx.all("SELECT s.id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND t.scope_kind='contact' AND t.contact_id=? AND s.kind IN ('document_scene','document_profile')",[ownerId,scope.contactId]))addStep(s.id);
  }
 }
 // 图片清除只沿精确内容输入及派生版本传播，不使用联系人资料代次。
 const memoryImpact=memoryDeletionImpact(tx,op);
 if(isMediaDeletionScope(scope))for(const id of memoryImpact.steps)if(tx.get("SELECT 1 FROM processing_step WHERE owner_id=? AND id=? AND kind IN ('document_scene','document_profile')",[ownerId,id]))addStep(id);
 // 08 的版本祖先闭包还可能经合并或恢复传递来源。
 for(const v of memoryImpact.versions)for(const s of tx.all(`SELECT DISTINCT s.id FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id WHERE i.owner_id=? AND i.kind='memory' AND i.memory_id=? AND i.memory_version_no=? AND s.kind IN ('document_scene','document_profile') AND (s.state<>'succeeded' OR EXISTS(SELECT 1 FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id WHERE x.owner_id=i.owner_id AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no AND e.kind='document_input'))`,[ownerId,v.memoryId,v.versionNo]))addStep(s.id);
 let changed=true;
 while(changed){
  const before=out.steps.size+out.documents.size+out.versions.size+out.publications.size+out.tasks.size;
  for(const doc of [...out.documents])for(const v of tx.all('SELECT version_no FROM memory_document_version WHERE owner_id=? AND document_id=?',[ownerId,doc]))addVersion(doc,v.version_no);
  for(const stepId of [...out.steps]){
   const s=tx.get("SELECT task_id FROM processing_step WHERE owner_id=? AND id=? AND kind IN ('document_scene','document_profile')",[ownerId,stepId]);if(s)out.tasks.add(String(s.task_id));
   for(const v of tx.all(`SELECT v.document_id,v.version_no FROM memory_document_version v JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id WHERE a.owner_id=? AND a.step_id=?`,[ownerId,stepId]))addVersion(v.document_id,v.version_no);
   for(const v of tx.all(`SELECT DISTINCT b.document_id,b.version_no FROM document_basis b JOIN execution_event e ON e.owner_id=b.owner_id AND e.id=b.event_id JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id WHERE a.owner_id=? AND a.step_id=?`,[ownerId,stepId]))addVersion(v.document_id,v.version_no);
  }
  for(const {documentId,versionNo} of [...out.versions.values()]){
   for(const s of tx.all(`SELECT i.step_id FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id
    WHERE i.owner_id=? AND i.kind='document' AND i.document_id=? AND i.document_version_no=? AND (s.state<>'succeeded' OR EXISTS(
     SELECT 1 FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id
     WHERE x.owner_id=i.owner_id AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no AND e.kind='document_input'))`,[ownerId,documentId,versionNo]))addStep(s.step_id);
   for(const v of tx.all('SELECT document_id,version_no FROM memory_document_version WHERE owner_id=? AND document_id=? AND previous_version_no=?',[ownerId,documentId,versionNo]))addVersion(v.document_id,v.version_no);
   for(const v of tx.all('SELECT document_id,version_no FROM document_replacement WHERE owner_id=? AND old_document_id=? AND old_version_no=?',[ownerId,documentId,versionNo]))addVersion(v.document_id,v.version_no);
   for(const p of tx.all('SELECT publication_id FROM publication_member WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,documentId,versionNo]))addPublication(p.publication_id);
  }
  for(const taskId of [...out.tasks])for(const p of tx.all('SELECT p.id FROM document_publication p WHERE p.owner_id=? AND p.basis_task_id=? AND NOT EXISTS(SELECT 1 FROM publication_member m WHERE m.owner_id=p.owner_id AND m.publication_id=p.id)',[ownerId,taskId]))addPublication(p.id);
  for(const publicationId of [...out.publications]){
   for(const t of tx.all(`SELECT t.id FROM processing_task t WHERE t.owner_id=? AND t.accepted_publication_id=? AND NOT EXISTS(
    SELECT 1 FROM document_publication p WHERE p.owner_id=t.owner_id AND p.basis_task_id=t.id)`,[ownerId,publicationId])){
    out.tasks.add(String(t.id));
    for(const s of tx.all("SELECT id FROM processing_step WHERE owner_id=? AND task_id=? AND kind IN ('document_scene','document_profile')",[ownerId,t.id]))addStep(s.id);
    for(const p of tx.all('SELECT id FROM document_publication WHERE owner_id=? AND basis_task_id=?',[ownerId,t.id]))addPublication(p.id);
   }
  }
  changed=before!==out.steps.size+out.documents.size+out.versions.size+out.publications.size+out.tasks.size;
 }
 return out;
}
/** 回复删除读取同一版本闭包；已清除的行仍由本次固定计划保留身份。 */
export function collectMemoryDocumentDeletionReferences(tx:StorageTransaction,op:DeletionOperation):{versions:{documentId:string;versionNo:bigint}[];publications:string[]}{
 if(!allowed(op)||!installed(tx))return {versions:[],publications:[]};
 const affected=closure(tx,op),versions=new Map(affected.versions),publications=new Set(affected.publications);
 for(const target of planned(tx,op)){
  if(target.rowKind==='memory_document_version')versions.set(pair(target.key.document_id,target.key.version_no),{documentId:target.key.document_id,versionNo:BigInt(target.key.version_no)});
  if(target.rowKind==='document_publication')publications.add(target.key.id);
 }
 return {versions:[...versions.values()],publications:[...publications]};
}
function holderKeys(tx:StorageTransaction,ownerId:string,stepId:string):string[]{
 return tx.all(`SELECT a.id AS attempt_id,c.source_contact_id FROM processing_step selected JOIN processing_step s ON s.owner_id=selected.owner_id AND s.task_id=selected.task_id AND s.kind IN ('document_scene','document_profile') JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id JOIN task_contribution c ON c.owner_id=s.owner_id AND c.task_id=s.task_id WHERE selected.owner_id=? AND selected.id=? ORDER BY a.id,c.source_contact_id`,[ownerId,stepId]).map(r=>`memoryDocuments:${r.attempt_id}_${r.source_contact_id}`);
}
function target(rowKind:string,key:Record<string,string>,holders:string[]):RowDeletionTarget{return {kind:'row',domain,rowKind,key,identity:identity(rowKind,key),holderKeys:holders};}
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 if(!allowed(op)||!installed(tx))return [];
 const c=closure(tx,op),owner_id=op.ownerId,holders=[...new Set([...c.steps].flatMap(step=>holderKeys(tx,owner_id,step)))].sort(),result:RowDeletionTarget[]=[];
 for(const stepId of [...c.steps].sort())if(tx.get("SELECT 1 FROM processing_step WHERE owner_id=? AND id=? AND kind IN ('document_scene','document_profile')",[owner_id,stepId]))result.push(target('processing_step',{owner_id,id:stepId},holders));
 for(const v of [...c.versions.values()].sort((a,b)=>a.documentId.localeCompare(b.documentId)||(a.versionNo===b.versionNo?0:a.versionNo>b.versionNo?-1:1)))if(tx.get('SELECT 1 FROM memory_document_version WHERE owner_id=? AND document_id=? AND version_no=?',[owner_id,v.documentId,v.versionNo]))result.push(target('memory_document_version',{owner_id,document_id:v.documentId,version_no:String(v.versionNo)},holders));
 for(const documentId of [...c.documents].sort())if(tx.get('SELECT 1 FROM memory_document WHERE owner_id=? AND id=?',[owner_id,documentId]))result.push(target('memory_document',{owner_id,id:documentId},holders));
 for(const publicationId of [...c.publications].sort())if(tx.get('SELECT 1 FROM document_publication WHERE owner_id=? AND id=?',[owner_id,publicationId]))result.push(target('document_publication',{owner_id,id:publicationId},holders));
 if(tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_document_later_schedule'")){
  // 来源／历史删除只保留非正文队列元数据；management domain 会在同事务更新版本并排入重整。
  // 联系人删除清该联系人的队列，账号删除清该owner全部队列。
  if(op.scope.kind==='contact'||op.scope.kind==='account'){
   const contactOnly=op.scope.kind==='contact',where=contactOnly?' AND contact_id=?':'';
   const args=contactOnly?[owner_id,op.scope.kind==='contact'?op.scope.contactId:'']:[owner_id];
   for(const row of tx.all(`SELECT owner_id,scope_key,generation FROM memory_document_later_schedule WHERE owner_id=?${where}`,args))result.push(target('memory_document_later_schedule',{owner_id:String(row.owner_id),scope_key:String(row.scope_key),generation:String(row.generation)},holders));
   for(const row of tx.all(`SELECT owner_id,run_id,scope_key FROM memory_document_later_run_requirement WHERE owner_id=?${where}`,args))result.push(target('memory_document_later_run_requirement',{owner_id:String(row.owner_id),run_id:String(row.run_id),scope_key:String(row.scope_key)},holders));
   for(const row of tx.all(`SELECT owner_id,scope_key FROM memory_document_later_cursor WHERE owner_id=?${where}`,args))result.push(target('memory_document_later_cursor',{owner_id:String(row.owner_id),scope_key:String(row.scope_key)},holders));
  }
 }
 return result;
}
function clearGraph(tx:StorageTransaction,op:DeletionOperation):void {
 const targets=planned(tx,op),ownerId=op.ownerId;
 const steps=new Set(targets.filter(t=>t.rowKind==='processing_step').map(t=>t.key.id));
 const laterSchedules=targets.filter(t=>t.rowKind==='memory_document_later_schedule');
 const laterRequirements=targets.filter(t=>t.rowKind==='memory_document_later_run_requirement');
 const laterCursors=targets.filter(t=>t.rowKind==='memory_document_later_cursor');
 const versions=targets.filter(t=>t.rowKind==='memory_document_version').map(t=>({documentId:t.key.document_id,versionNo:BigInt(t.key.version_no)}));
 const publications=new Set(targets.filter(t=>t.rowKind==='document_publication').map(t=>t.key.id));
 const documents=new Set(targets.filter(t=>t.rowKind==='memory_document').map(t=>t.key.id));
 const stepIds=json(steps),taskIds=json(tx.all('SELECT DISTINCT task_id FROM processing_step WHERE owner_id=? AND id IN (SELECT value FROM json_each(?))',[ownerId,stepIds]).map(row=>String(row.task_id))),pubIds=json(publications);
 for(const target of laterRequirements)tx.run('DELETE FROM memory_document_later_run_requirement WHERE owner_id=? AND run_id=? AND scope_key=?',[ownerId,target.key.run_id,target.key.scope_key]);
 for(const target of laterSchedules)tx.run('DELETE FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND generation=?',[ownerId,target.key.scope_key,BigInt(target.key.generation)]);
 for(const target of laterCursors)tx.run('DELETE FROM memory_document_later_cursor WHERE owner_id=? AND scope_key=?',[ownerId,target.key.scope_key]);
 // 来源删除撤销的stage任务在删除门关闭后按新版本重排；unknown永远保持锁定。
 if((isMediaDeletionScope(op.scope)||op.scope.kind==='source'||op.scope.kind==='contact_history')&&tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_document_later_schedule'")){
  const now=Date.now();
  for(const row of tx.all("SELECT * FROM memory_document_later_schedule WHERE owner_id=? AND state='running' AND task_id IN (SELECT value FROM json_each(?))",[ownerId,taskIds])){
   const unknown=!!tx.get("SELECT 1 FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id LEFT JOIN model_call c ON c.owner_id=a.owner_id AND c.step_attempt_id=a.id WHERE s.owner_id=? AND s.task_id=? AND (s.state='unknown' OR a.state='unknown' OR c.state='unknown') LIMIT 1",[ownerId,row.task_id]);
   if(unknown){
    tx.run("UPDATE memory_document_later_schedule SET state='unknown',error_code='document_call_unknown' WHERE owner_id=? AND scope_key=? AND generation=?",[ownerId,row.scope_key,row.generation]);
    tx.run("UPDATE memory_document_later_run_requirement SET outcome='unknown',reason='document_call_unknown',updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[now,ownerId,row.scope_key,row.generation]);continue;
   }
   const base=row.scope_kind==='self'?tx.get("SELECT memory_revision FROM owner WHERE owner_id=? AND state='active'",[ownerId]):tx.get("SELECT memory_revision FROM contact WHERE owner_id=? AND id=? AND state='active'",[ownerId,row.contact_id]);
   if(!base)continue;
   const newer=tx.get("SELECT generation FROM memory_document_later_schedule WHERE owner_id=? AND scope_key=? AND stage='document_scene' AND state='scheduled' AND requested_memory_revision=? ORDER BY generation DESC LIMIT 1",[ownerId,row.scope_key,base.memory_revision]);
   if(newer){
    tx.run("UPDATE memory_document_later_schedule SET state='superseded',error_code='document_source_invalidated' WHERE owner_id=? AND scope_key=? AND generation=? AND state='running'",[ownerId,row.scope_key,row.generation]);
    tx.run("UPDATE memory_document_later_run_requirement SET generation=?,outcome='pending',reason=NULL,updated_at=? WHERE owner_id=? AND scope_key=? AND generation=? AND outcome='pending'",[newer.generation,now,ownerId,row.scope_key,row.generation]);
   }else tx.run("UPDATE memory_document_later_schedule SET state='scheduled',task_id=NULL,frozen_memory_revision=NULL,frozen_document_revision=NULL,frozen_publication_id=NULL,requested_memory_revision=?,due_at=min(due_at,?),error_code=NULL WHERE owner_id=? AND scope_key=? AND generation=? AND state='running'",[base.memory_revision,now,ownerId,row.scope_key,row.generation]);
  }
  for(const task of tx.all("SELECT DISTINCT t.scope_kind,t.contact_id FROM processing_task t WHERE t.owner_id=? AND t.id IN (SELECT value FROM json_each(?))",[ownerId,taskIds])){
   const scopeKey=task.scope_kind==='self'?'self':String(task.contact_id);
   // 删除只清除失效的正文基线；最近画像成功时间仍约束下一次L3，避免删除绕过24小时频率。
   tx.run('UPDATE memory_document_later_cursor SET scene_body_digest=NULL,profile_scene_body_digest=NULL WHERE owner_id=? AND scope_key=?',[ownerId,scopeKey]);
  }
 }
 // 基线只在该任务已撤销及当前删除仍未结束时释放，避免以改写旧基线恢复处理。
 for(const t of tx.all(`SELECT t.id,t.state FROM processing_task t WHERE t.owner_id=? AND t.state='revoked' AND t.accepted_publication_id IN (SELECT value FROM json_each(?))
  AND NOT EXISTS(SELECT 1 FROM document_publication p WHERE p.owner_id=t.owner_id AND p.basis_task_id=t.id AND p.availability='available')`,[ownerId,pubIds])){
  tx.run("UPDATE processing_task SET document_basis_state='not_applicable',accepted_memory_revision=NULL,accepted_document_revision=NULL,accepted_publication_id=NULL WHERE owner_id=? AND id=?",[ownerId,t.id]);
 }
 tx.run('UPDATE owner SET current_publication_id=NULL WHERE owner_id=? AND current_publication_id IN (SELECT value FROM json_each(?))',[ownerId,pubIds]);
 tx.run('UPDATE contact SET current_publication_id=NULL WHERE owner_id=? AND current_publication_id IN (SELECT value FROM json_each(?))',[ownerId,pubIds]);
 // 所有依赖必须已登记；先清陈述依据，再释放事件和冻结引用。
 for(const v of versions)tx.run('DELETE FROM document_basis WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,v.documentId,v.versionNo]);
 for(const s of steps){
  const events=tx.all('SELECT e.id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id WHERE a.owner_id=? AND a.step_id=?',[ownerId,s]);
  const ids=json(events.map(e=>String(e.id)));
  if(tx.get('SELECT 1 FROM document_basis WHERE owner_id=? AND event_id IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,ids]))fail('document_deletion_unplanned_basis');
  tx.run('DELETE FROM event_source WHERE owner_id=? AND event_id IN (SELECT value FROM json_each(?))',[ownerId,ids]);
  tx.run('DELETE FROM execution_input WHERE owner_id=? AND (planned_step_id=? OR event_id IN (SELECT value FROM json_each(?)))',[ownerId,s,ids]);
  tx.run('DELETE FROM execution_event WHERE owner_id=? AND id IN (SELECT value FROM json_each(?))',[ownerId,ids]);
  tx.run('DELETE FROM step_input WHERE owner_id=? AND step_id=?',[ownerId,s]);
 }
 const versionKeys=new Set(versions.map(v=>pair(v.documentId,v.versionNo)));
 for(const v of versions){
  // 未实际发送的冻结成员只需释放引用；成功产物不因此成为来源派生。
  tx.run(`DELETE FROM step_input WHERE owner_id=? AND kind='document' AND document_id=? AND document_version_no=? AND NOT EXISTS(
   SELECT 1 FROM execution_input x WHERE x.owner_id=step_input.owner_id AND x.planned_step_id=step_input.step_id AND x.planned_input_no=step_input.input_no)`,[ownerId,v.documentId,v.versionNo]);
  if(tx.get("SELECT 1 FROM step_input WHERE owner_id=? AND kind='document' AND document_id=? AND document_version_no=?",[ownerId,v.documentId,v.versionNo]))fail('document_deletion_unplanned_input');
  for(const child of tx.all('SELECT document_id,version_no FROM memory_document_version WHERE owner_id=? AND document_id=? AND previous_version_no=?',[ownerId,v.documentId,v.versionNo]))if(!versionKeys.has(pair(child.document_id,child.version_no)))fail('document_deletion_unplanned_version');
  for(const child of tx.all('SELECT document_id,version_no FROM document_replacement WHERE owner_id=? AND old_document_id=? AND old_version_no=?',[ownerId,v.documentId,v.versionNo]))if(!versionKeys.has(pair(child.document_id,child.version_no)))fail('document_deletion_unplanned_version');
  tx.run('DELETE FROM document_replacement WHERE owner_id=? AND ((document_id=? AND version_no=?) OR (old_document_id=? AND old_version_no=?))',[ownerId,v.documentId,v.versionNo,v.documentId,v.versionNo]);
 }
 for(const publicationId of publications){
  tx.run('DELETE FROM publication_member WHERE owner_id=? AND publication_id=?',[ownerId,publicationId]);
  tx.run('DELETE FROM document_publication WHERE owner_id=? AND id=?',[ownerId,publicationId]);
 }
 for(const v of versions.sort((a,b)=>a.documentId.localeCompare(b.documentId)||(a.versionNo===b.versionNo?0:a.versionNo>b.versionNo?-1:1))){
  if(tx.get('SELECT 1 FROM publication_member WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,v.documentId,v.versionNo]))fail('document_deletion_unplanned_publication');
  tx.run('DELETE FROM memory_document_version WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,v.documentId,v.versionNo]);
  tx.run('DELETE FROM memory_document WHERE owner_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM memory_document_version WHERE owner_id=? AND document_id=?)',[ownerId,v.documentId,ownerId,v.documentId]);
 }
 for(const documentId of documents){
  if(tx.get('SELECT 1 FROM memory_document_version WHERE owner_id=? AND document_id=?',[ownerId,documentId]))fail('document_deletion_unplanned_version');
  tx.run('DELETE FROM memory_document WHERE owner_id=? AND id=?',[ownerId,documentId]);
 }
 const attempts=tx.all('SELECT id FROM step_attempt WHERE owner_id=? AND step_id IN (SELECT value FROM json_each(?))',[ownerId,stepIds]).map(a=>String(a.id));
 const attemptIds=json(attempts);
 tx.run("UPDATE processing_item SET pipeline_state='pending',completion_attempt_id=NULL WHERE owner_id=? AND completion_attempt_id IN (SELECT value FROM json_each(?)) AND pipeline_state='completed'",[ownerId,attemptIds]);
 tx.run("UPDATE processing_item SET pipeline_state='pending',completion_attempt_id=NULL WHERE owner_id=? AND pipeline_state='completed' AND completion_attempt_id IN (SELECT json_extract(target_payload,'$.key.id') FROM deletion_target WHERE operation_id=? AND domain='memory_extraction' AND row_kind='step_attempt' AND target_payload IS NOT NULL)",[ownerId,op.operationId]);
 for(const s of steps){
  const operations=tx.all('SELECT id FROM model_operation WHERE owner_id=? AND memory_step_id=?',[ownerId,s]);
  for(const o of operations){
   if(eraseLedger(op)){
    tx.run('DELETE FROM model_call WHERE owner_id=? AND operation_id=?',[ownerId,o.id]);
    tx.run('DELETE FROM operation_item WHERE owner_id=? AND operation_id=?',[ownerId,o.id]);
    tx.run('DELETE FROM operation_scope WHERE owner_id=? AND operation_id=?',[ownerId,o.id]);
    tx.run('DELETE FROM model_operation WHERE owner_id=? AND id=?',[ownerId,o.id]);
   }else{
    for(const call of tx.all('SELECT id,receipt FROM model_call WHERE owner_id=? AND operation_id=?',[ownerId,o.id]))tx.run('UPDATE model_call SET step_attempt_id=NULL,receipt=? WHERE owner_id=? AND id=?',[minimalModelReceipt(call.receipt),ownerId,call.id]);
    tx.run("DELETE FROM operation_item WHERE owner_id=? AND operation_id=? AND state<>'unknown'",[ownerId,o.id]);
    tx.run("DELETE FROM document_effect_scope WHERE owner_id=? AND operation_id=? AND state<>'unknown'",[ownerId,o.id]);
    tx.run("UPDATE model_operation SET memory_step_id=NULL,state='sealed',input_seal='deleted' WHERE owner_id=? AND id=?",[ownerId,o.id]);
   }
  }
  tx.run('DELETE FROM step_attempt WHERE owner_id=? AND step_id=?',[ownerId,s]);
  tx.run('DELETE FROM processing_step WHERE owner_id=? AND id=?',[ownerId,s]);
 }
 tx.run(`DELETE FROM document_publication_identity WHERE owner_id=?
  AND NOT EXISTS(SELECT 1 FROM document_publication p WHERE p.owner_id=document_publication_identity.owner_id AND p.id=document_publication_identity.id)
  AND NOT EXISTS(SELECT 1 FROM processing_task t WHERE t.owner_id=document_publication_identity.owner_id AND t.accepted_publication_id=document_publication_identity.id)
  AND NOT EXISTS(SELECT 1 FROM step_input i WHERE i.owner_id=document_publication_identity.owner_id AND i.publication_id=document_publication_identity.id)`,[ownerId]);
}
export const memoryDocumentsDeletionDomain:DeletionDomain={id:domain,rowKinds,
 fence(tx,op){
  if(!allowed(op)||!installed(tx))return [];
  if(verifyFence(tx,op).result!=='passed')fail('document_deletion_not_fenced');
  const c=closure(tx,op),now=Date.now();
  for(const publicationId of c.publications){
   const p=tx.get('SELECT * FROM document_publication WHERE owner_id=? AND id=?',[op.ownerId,publicationId]);if(!p)continue;
   if(p.availability==='available'){
    tx.run("UPDATE document_publication SET availability='invalidated' WHERE owner_id=? AND id=?",[op.ownerId,publicationId]);
    if(p.scope_kind==='self')tx.run('UPDATE owner SET document_revision=document_revision+1 WHERE owner_id=? AND current_publication_id=?',[op.ownerId,publicationId]);
    else tx.run('UPDATE contact SET document_revision=document_revision+1 WHERE owner_id=? AND id=? AND current_publication_id=?',[op.ownerId,p.contact_id,publicationId]);
   }
  }
  for(const taskId of c.tasks)tx.run("UPDATE processing_task SET state='revoked',control_revision=control_revision+1,error_code='source_deleted' WHERE owner_id=? AND id=? AND state<>'revoked'",[op.ownerId,taskId]);
  for(const stepId of c.steps){
   tx.run("UPDATE processing_step SET state='revoked',successful_attempt_id=NULL,not_applicable_reason=NULL WHERE owner_id=? AND id=?",[op.ownerId,stepId]);
   tx.run("UPDATE step_attempt SET state='aborted',finished_at=?,error_code='source_deleted' WHERE owner_id=? AND step_id=? AND state='running'",[now,op.ownerId,stepId]);
   tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id IN (SELECT id FROM step_attempt WHERE owner_id=? AND step_id=?) AND state='sending'",[op.ownerId,op.ownerId,stepId]);
   tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id IN (SELECT id FROM step_attempt WHERE owner_id=? AND step_id=?) AND state='prepared'",[op.ownerId,op.ownerId,stepId]);
   tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=COALESCE(commit_forbidden_at,?),input_seal='deleted' WHERE owner_id=? AND memory_step_id=?",[now,op.ownerId,stepId]);
   if(!eraseLedger(op))tx.run("UPDATE operation_item SET state='unknown' WHERE owner_id=? AND operation_id IN (SELECT o.id FROM model_operation o JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE o.owner_id=? AND o.memory_step_id=? AND c.state='unknown')",[op.ownerId,op.ownerId,stepId]);
   tx.run("UPDATE document_effect_scope SET state=CASE WHEN EXISTS(SELECT 1 FROM model_call c WHERE c.owner_id=document_effect_scope.owner_id AND c.operation_id=document_effect_scope.operation_id AND c.state='unknown') THEN 'unknown' ELSE 'released' END WHERE owner_id=? AND operation_id IN (SELECT id FROM model_operation WHERE owner_id=? AND memory_step_id=?)",[op.ownerId,op.ownerId,stepId]);
  }
  return [];
 },collect,
 clearRow(tx,op,t){
  if(!allowed(op)||t.domain!==domain||!Object.hasOwn(rowKinds,t.rowKind)||t.key.owner_id!==op.ownerId||Object.keys(t.key).sort().join()!==[...rowKinds[t.rowKind].keys].sort().join()||t.identity!==identity(t.rowKind,t.key))fail('document_deletion_target_invalid');
  if(verifyFence(tx,op).result!=='passed'||!tx.get('SELECT 1 FROM deletion_target WHERE operation_id=? AND domain=? AND row_kind=? AND expected_identity=? AND target_payload IS NOT NULL',[op.operationId,domain,t.rowKind,JSON.stringify(t.identity)]))fail('document_deletion_not_fenced');
  clearGraph(tx,op);
 },
 authorizeFile(){fail('document_deletion_has_no_files');},fileCleared(){fail('document_deletion_has_no_files');},
 verify(tx,op){
  const result:CheckResult=!allowed(op)?{result:'not_applicable',proof:'document_scope_not_owned'}:!installed(tx)?{result:'not_applicable',proof:'document_schema_not_installed'}:{result:collect(tx,op).length===0?'passed':'blocked',proof:'document_actual_inputs_and_publications_cleared'};
  return {database_rows:result,derived_eligibility:result,trace_payloads:result,request_replay:result,scope_suppression:result};
 },
};
