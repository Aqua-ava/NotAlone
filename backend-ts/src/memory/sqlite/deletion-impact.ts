import {sourceDeletionIds} from '../../history/sqlite/source-deletion.ts';
import {isMediaDeletionScope,mediaDeletionFileIds} from '../../media/sqlite/deletion.ts';
import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {DeletionOperation,RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';

type Kind='event'|'input'|'task'|'candidate'|'version'|'memory'|'decision';
interface Identity {kind:Kind;id:string;slot:string|null}
export interface MemoryDeletionImpact {
 steps:string[];events:string[];stepInputs:{stepId:string;inputNo:bigint}[];tasks:string[];candidates:string[];
 versions:{memoryId:string;versionNo:bigint}[];memories:string[];decisions:string[];inputs:StorageRow[];planned:RowDeletionTarget[];
}
export const deletionIds=(values:readonly unknown[])=>JSON.stringify(values,(_key,value)=>typeof value==='bigint'?String(value):value);
/** JSON仅传递本次查询的身份集合；行始终沿真实复合FK及索引反查。 */
export function deletionRows(tx:StorageTransaction,ownerId:string,table:string,key:string,ids:readonly string[]):StorageRow[]{
 if(!ids.length)return [];
 return tx.all(`SELECT * FROM ${table} WHERE owner_id=? AND ${key} IN (SELECT value FROM json_each(?)) ORDER BY rowid`,[ownerId,deletionIds(ids)]);
}
/** 实际event/input是来源依赖；task只撤销待执行writer，不扩散到独立成功历史。 */
export function memoryDeletionImpact(tx:StorageTransaction,op:DeletionOperation):MemoryDeletionImpact{
 const sourceIds=JSON.stringify(sourceDeletionIds(tx,op));
 const {ownerId,scope}=op,seeds:Identity[]=[],touchedSteps=new Set<string>();
 const add=(kind:Kind,id:unknown,slot:unknown=null)=>{if(id!==null&&id!==undefined)seeds.push({kind,id:String(id),slot:slot===null?null:String(slot)});};
 const planned=tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain IN ('memory_management','memory_extraction') AND target_payload IS NOT NULL",[op.operationId]).map(r=>JSON.parse(String(r.target_payload)) as RowDeletionTarget);
 const typed=!!tx.get("SELECT 1 FROM pragma_table_info('step_input') WHERE name='kind'");
 let inputs:StorageRow[]=[];
 if(isMediaDeletionScope(scope)){
  if(tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_content_input'")){
   const files=mediaDeletionFileIds(tx,op);
   inputs=tx.all(`SELECT i.* FROM run_input i JOIN run_content_input content
    ON content.owner_id=i.owner_id AND content.run_id=i.run_id AND content.input_no=i.input_no
    WHERE i.owner_id=? AND i.source_contact_id=? AND i.message_id=? AND content.content_kind='image'
    AND json_extract(content.identity_json,'$.fileId') IN (SELECT value FROM json_each(?))`,[ownerId,scope.contactId,scope.messageId,deletionIds(files)]);
   for(const input of inputs){
    for(const row of tx.all('SELECT step_id,input_no FROM step_input WHERE owner_id=? AND run_id=? AND run_input_no=?',[ownerId,input.run_id,input.input_no]))add('input',row.step_id,row.input_no);
    // 尚未创建步骤的冻结输入也必须停止；同轮独立成功步骤不因此扩散。
    for(const task of tx.all(`SELECT t.id FROM processing_task t JOIN task_contribution c ON c.owner_id=t.owner_id AND c.task_id=t.id
     WHERE t.owner_id=? AND t.run_id=? AND c.source_contact_id=? AND t.state IN ('pending','running','paused','failed','unknown','incomplete')`,[ownerId,input.run_id,input.source_contact_id]))add('task',task.id);
   }
  }
 }else if(scope.kind==='account'){
  inputs=tx.all('SELECT * FROM run_input WHERE owner_id=?',[ownerId]);
  for(const t of tx.all('SELECT id FROM processing_task WHERE owner_id=?',[ownerId]))add('task',t.id);
  for(const s of tx.all('SELECT id FROM processing_step WHERE owner_id=?',[ownerId]))touchedSteps.add(String(s.id));
  for(const e of tx.all('SELECT id FROM execution_event WHERE owner_id=? AND step_attempt_id IS NOT NULL',[ownerId]))add('event',e.id);
  for(const i of tx.all('SELECT step_id,input_no FROM step_input WHERE owner_id=?',[ownerId]))add('input',i.step_id,i.input_no);
  for(const c of tx.all('SELECT id FROM memory_candidate WHERE owner_id=?',[ownerId]))add('candidate',c.id);
  for(const m of tx.all('SELECT id FROM memory WHERE owner_id=?',[ownerId]))add('memory',m.id);
  for(const d of tx.all('SELECT id FROM memory_decision WHERE owner_id=?',[ownerId]))add('decision',d.id);
 }else if('contactId'in scope){
  const values=scope.kind==='source'?[ownerId,scope.contactId,sourceIds]:[ownerId,scope.contactId,op.acceptedGeneration];
  inputs=tx.all(`SELECT i.* FROM run_input i INDEXED BY run_inputs_source JOIN run_contact rc ON rc.owner_id=i.owner_id AND rc.run_id=i.run_id AND rc.contact_id=i.source_contact_id WHERE i.owner_id=? AND i.source_contact_id=? AND ${scope.kind==='source'?'i.record_id IN (SELECT value FROM json_each(?))':'rc.accepted_data_generation<?'}`,values);
  const tasks=new Set<string>(),sourceRuns=new Set(inputs.map(i=>String(i.run_id)));
  if(scope.kind==='contact')for(const c of tx.all('SELECT run_id FROM run_contact WHERE owner_id=? AND contact_id=?',[ownerId,scope.contactId]))sourceRuns.add(String(c.run_id));
  for(const runId of sourceRuns){
   for(const t of tx.all("SELECT id FROM processing_task INDEXED BY task_contact_scope WHERE owner_id=? AND run_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,runId,scope.contactId]))tasks.add(String(t.id));
   for(const t of tx.all("SELECT t.id FROM processing_task t INDEXED BY task_self_scope JOIN task_contribution c ON c.owner_id=t.owner_id AND c.task_id=t.id AND c.source_contact_id=? WHERE t.owner_id=? AND t.run_id=? AND t.scope_kind='self'",[scope.contactId,ownerId,runId]))tasks.add(String(t.id));
  }
  for(const taskId of tasks){
   add('task',taskId);
   for(const i of tx.all(`SELECT i.step_id,i.input_no FROM processing_step s JOIN step_input i ON i.owner_id=s.owner_id AND i.step_id=s.id JOIN run_input r ON r.owner_id=i.owner_id AND r.run_id=i.run_id AND r.input_no=i.run_input_no WHERE s.owner_id=? AND s.task_id=? AND r.source_contact_id=? ${scope.kind==='source'?'AND r.record_id IN (SELECT value FROM json_each(?))':''}`,scope.kind==='source'?[ownerId,taskId,scope.contactId,sourceIds]:[ownerId,taskId,scope.contactId]))add('input',i.step_id,i.input_no);
  }
  for(const e of tx.all(`SELECT event_id FROM event_source INDEXED BY event_sources_record WHERE owner_id=? AND source_contact_id=? ${scope.kind==='source'?'AND record_id IN (SELECT value FROM json_each(?))':''}`,scope.kind==='source'?[ownerId,scope.contactId,sourceIds]:[ownerId,scope.contactId]))add('event',e.event_id);
  for(const c of tx.all(`SELECT candidate_id,memory_id,version_no FROM memory_citation INDEXED BY memory_citation_source WHERE owner_id=? AND source_contact_id=? ${scope.kind==='source'?'AND record_id IN (SELECT value FROM json_each(?))':''}`,scope.kind==='source'?[ownerId,scope.contactId,sourceIds]:[ownerId,scope.contactId])){add('candidate',c.candidate_id);add('version',c.memory_id,c.version_no);}
  if(typed)for(const i of tx.all(`SELECT i.step_id,i.input_no FROM step_input i INDEXED BY step_inputs_source JOIN capture_record r ON r.owner_id=i.owner_id AND r.contact_id=i.source_contact_id AND r.id=i.record_id AND r.message_id=i.message_id JOIN sync_capture sc ON sc.owner_id=r.owner_id AND sc.contact_id=r.contact_id AND sc.id=r.capture_id JOIN read_goal g ON g.owner_id=sc.owner_id AND g.contact_id=sc.contact_id AND g.id=sc.goal_id WHERE i.owner_id=? AND i.source_contact_id=? AND i.record_id IS NOT NULL AND i.kind='message' ${scope.kind==='source'?'AND i.record_id IN (SELECT value FROM json_each(?))':'AND g.accepted_data_generation<?'}`,values))add('input',i.step_id,i.input_no);
  if(scope.kind==='contact'){
   for(const c of tx.all("SELECT id FROM memory_candidate INDEXED BY candidate_scope WHERE owner_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,scope.contactId]))add('candidate',c.id);
   for(const m of tx.all("SELECT id FROM memory INDEXED BY memory_scope WHERE owner_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,scope.contactId]))add('memory',m.id);
  }
 }
 for(const t of planned){
  const kind:Kind|undefined=t.rowKind==='execution_event'?'event':t.rowKind==='step_input'?'input':t.rowKind==='processing_task'?'task':t.rowKind==='memory_candidate'?'candidate':t.rowKind==='memory_version'?'version':t.rowKind==='memory'?'memory':t.rowKind==='memory_decision'?'decision':undefined;
  if(kind)add(kind,t.key.id??t.key.memory_id??t.key.step_id,t.key.version_no??t.key.input_no??null);
  if(t.rowKind==='processing_step'){
   touchedSteps.add(t.key.id);
   for(const i of tx.all('SELECT input_no FROM step_input WHERE owner_id=? AND step_id=?',[ownerId,t.key.id]))add('input',t.key.id,i.input_no);
   for(const e of tx.all('SELECT e.id FROM step_attempt a JOIN execution_event e ON e.owner_id=a.owner_id AND e.step_attempt_id=a.id WHERE a.owner_id=? AND a.step_id=?',[ownerId,t.key.id]))add('event',e.id);
  }
  if(t.domain==='memory_extraction')for(const key of t.holderKeys)if(key.startsWith('memory:'))add('task',key.slice(7));
  if(t.domain==='memory_extraction'&&t.rowKind==='run_input'){
   const row=tx.get('SELECT * FROM run_input WHERE owner_id=? AND run_id=? AND input_no=?',[ownerId,t.key.run_id,BigInt(t.key.input_no)]);if(row&&!inputs.some(i=>i.run_id===row.run_id&&i.input_no===row.input_no))inputs.push(row);
  }
 }
 const typedEdges=typed?`UNION SELECT 'input',i.step_id,i.input_no FROM affected a CROSS JOIN request x CROSS JOIN processing_step s CROSS JOIN step_input i WHERE a.kind='task' AND s.owner_id=x.owner_id AND s.task_id=a.id AND s.kind IN ('adjudication','relation_verification','merge_verification') AND s.state IN ('pending','running','unknown','failed','revoked') AND i.owner_id=s.owner_id AND i.step_id=s.id
 UNION SELECT 'event',e.id,NULL FROM affected a CROSS JOIN request x CROSS JOIN processing_step s CROSS JOIN step_attempt sa CROSS JOIN execution_event e WHERE a.kind='task' AND s.owner_id=x.owner_id AND s.task_id=a.id AND s.kind IN ('adjudication','relation_verification','merge_verification') AND s.state IN ('pending','running','unknown','failed','revoked') AND sa.owner_id=s.owner_id AND sa.step_id=s.id AND e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id
 UNION SELECT 'input',i.step_id,i.input_no FROM affected a CROSS JOIN request x CROSS JOIN step_input i INDEXED BY step_inputs_candidate WHERE a.kind='candidate' AND i.owner_id=x.owner_id AND i.candidate_id=a.id
 UNION SELECT 'input',i.step_id,i.input_no FROM affected a CROSS JOIN request x CROSS JOIN step_input i INDEXED BY step_inputs_memory
 JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id
 WHERE a.kind='version' AND i.owner_id=x.owner_id AND i.memory_id=a.id AND i.memory_version_no=a.slot
 AND (s.kind NOT IN ('document_scene','document_profile') OR s.state<>'succeeded' OR EXISTS(
  SELECT 1 FROM execution_input used JOIN execution_event e ON e.owner_id=used.owner_id AND e.id=used.event_id
  WHERE used.owner_id=i.owner_id AND used.planned_step_id=i.step_id AND used.planned_input_no=i.input_no AND e.kind='document_input'))`:'';
 const rows=tx.all(`WITH RECURSIVE request(owner_id) AS (VALUES(?)), affected(kind,id,slot) AS (
 SELECT json_extract(value,'$.kind'),json_extract(value,'$.id'),CAST(json_extract(value,'$.slot') AS INTEGER) FROM json_each(?)
 UNION SELECT 'event',e.id,NULL FROM affected a CROSS JOIN request x CROSS JOIN processing_step s CROSS JOIN step_attempt sa CROSS JOIN execution_event e WHERE a.kind='task' AND s.owner_id=x.owner_id AND s.task_id=a.id AND sa.owner_id=s.owner_id AND sa.step_id=s.id AND e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id AND e.kind='stage_result' AND NOT EXISTS(SELECT 1 FROM step_attempt other JOIN execution_event used ON used.owner_id=other.owner_id AND used.step_attempt_id=other.id WHERE other.owner_id=s.owner_id AND other.step_id=s.id AND used.kind<>'stage_result')
 UNION SELECT 'task',s.task_id,NULL FROM affected a CROSS JOIN request x CROSS JOIN processing_step s WHERE a.kind='input' AND s.owner_id=x.owner_id AND s.id=a.id
 UNION SELECT 'event',e.id,NULL FROM affected a CROSS JOIN request x CROSS JOIN step_attempt sa CROSS JOIN execution_event e CROSS JOIN execution_input i WHERE a.kind='input' AND sa.owner_id=x.owner_id AND sa.step_id=a.id AND e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id AND i.owner_id=e.owner_id AND i.event_id=e.id AND i.planned_step_id=a.id AND i.planned_input_no=a.slot
 UNION SELECT 'task',s.task_id,NULL FROM affected a CROSS JOIN request x CROSS JOIN execution_event e CROSS JOIN step_attempt sa CROSS JOIN processing_step s WHERE a.kind='event' AND e.owner_id=x.owner_id AND e.id=a.id AND sa.owner_id=e.owner_id AND sa.id=e.step_attempt_id AND s.owner_id=sa.owner_id AND s.id=sa.step_id
 UNION SELECT 'candidate',c.id,NULL FROM affected a CROSS JOIN request x CROSS JOIN memory_candidate c WHERE a.kind='event' AND c.owner_id=x.owner_id AND c.event_id=a.id
 UNION SELECT 'decision',d.id,NULL FROM affected a CROSS JOIN request x CROSS JOIN execution_event e CROSS JOIN step_attempt sa CROSS JOIN processing_step s CROSS JOIN memory_decision d INDEXED BY memory_decision_execution WHERE a.kind='event' AND e.owner_id=x.owner_id AND e.id=a.id AND sa.owner_id=e.owner_id AND sa.id=e.step_attempt_id AND s.owner_id=sa.owner_id AND s.id=sa.step_id AND s.kind IN ('adjudication','relation_verification','merge_verification') AND d.owner_id=sa.owner_id AND d.execution_id=sa.id
 UNION SELECT 'event',i.event_id,NULL FROM affected a CROSS JOIN request x CROSS JOIN execution_input i INDEXED BY execution_input_producer WHERE a.kind='event' AND i.owner_id=x.owner_id AND i.producer_event_id=a.id AND i.producer_event_id IS NOT NULL
 UNION SELECT 'version',v.memory_id,v.version_no FROM affected a CROSS JOIN request x CROSS JOIN decision_candidate c INDEXED BY decision_candidate_reverse CROSS JOIN memory_version v WHERE a.kind='candidate' AND c.owner_id=x.owner_id AND c.candidate_id=a.id AND v.owner_id=c.owner_id AND v.decision_id=c.decision_id
 UNION SELECT 'version',v.memory_id,v.version_no FROM affected a CROSS JOIN request x CROSS JOIN memory_version v WHERE a.kind='decision' AND v.owner_id=x.owner_id AND v.decision_id=a.id
 UNION SELECT 'version',v.memory_id,v.version_no FROM affected a CROSS JOIN request x CROSS JOIN memory_version v WHERE a.kind='memory' AND v.owner_id=x.owner_id AND v.memory_id=a.id
 UNION SELECT 'version',v.memory_id,v.version_no FROM affected a CROSS JOIN request x CROSS JOIN memory_version v INDEXED BY memory_version_previous WHERE a.kind='version' AND v.owner_id=x.owner_id AND v.memory_id=a.id AND v.previous_version_no=a.slot
 UNION SELECT 'version',v.memory_id,v.version_no FROM affected a CROSS JOIN request x CROSS JOIN memory_version v INDEXED BY memory_version_restored WHERE a.kind='version' AND v.owner_id=x.owner_id AND v.memory_id=a.id AND v.restored_from_version_no=a.slot
 ${typedEdges}) SELECT kind,id,slot FROM affected ORDER BY kind,id,slot`,[ownerId,deletionIds(seeds)]);
 const ids=(kind:Kind)=>rows.filter(r=>r.kind===kind).map(r=>String(r.id)),events=ids('event'),stepInputs=rows.filter(r=>r.kind==='input').map(r=>({stepId:String(r.id),inputNo:r.slot as bigint}));
 for(const taskId of ids('task'))for(const s of tx.all('SELECT s.id FROM processing_step s WHERE s.owner_id=? AND s.task_id=? AND NOT EXISTS(SELECT 1 FROM step_attempt a JOIN execution_event e ON e.owner_id=a.owner_id AND e.step_attempt_id=a.id WHERE a.owner_id=s.owner_id AND a.step_id=s.id)',[ownerId,taskId]))touchedSteps.add(String(s.id));
 for(const i of stepInputs)touchedSteps.add(i.stepId);
 if(events.length)for(const s of tx.all('SELECT DISTINCT a.step_id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id WHERE e.owner_id=? AND e.id IN (SELECT value FROM json_each(?))',[ownerId,deletionIds(events)]))touchedSteps.add(String(s.step_id));
 return {steps:[...touchedSteps],events,stepInputs,tasks:ids('task'),candidates:ids('candidate'),versions:rows.filter(r=>r.kind==='version').map(r=>({memoryId:String(r.id),versionNo:r.slot as bigint})),memories:ids('memory'),decisions:ids('decision'),inputs,planned};
}
