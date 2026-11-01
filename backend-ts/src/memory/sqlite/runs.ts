import {randomUUID} from 'node:crypto';
import type {StorageAction,StorageTransaction,StorageRow} from '../../storage/sqlite/contracts.ts';
import {assertContribution,assertInputs,assertTaskContributions,fail,inputRows,textId} from './qualification.ts';
import {assertSourceEligibility} from '../../history/sqlite/source.ts';
import {currentSourceScopeCTE,currentSourcePredicate} from '../../history/sqlite/current-scope.ts';
import {laterStagesState} from './documents/actions.ts';
import {projectControl} from './control.ts';
import {memoryIncrementalBaseline} from '../../storage/sqlite/message-order.ts';
const number=(v:unknown):number=>{if(typeof v!=='bigint'||v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))return fail('memory_extraction_count_invalid');return Number(v);};
const minute=60_000,hour=60*minute,quietThreshold=10*minute,volumeThreshold=50,ageThreshold=6*hour,startCooldown=30*minute;
const timeNumber=(v:unknown):number=>{if(typeof v!=='bigint'||v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))return fail('memory_extraction_time_invalid');return Number(v);};
const checkedNow=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<0)return fail('memory_extraction_input_invalid');return Number(v);};
function hasColumn(tx:StorageTransaction,table:'processing_run'|'sync_capture'|'read_goal',column:string):boolean{
 return tx.all(`PRAGMA table_info(${table})`).some(row=>row.name===column);
}
export function hasRunFollowupState(tx:StorageTransaction):boolean{return hasColumn(tx,'processing_run','followup_state');}
function tableExists(tx:StorageTransaction,table:'history_continuity_scope'|'history_message_quarantine'|'memory_document_later_schedule'|'memory_document_later_run_requirement'):boolean{
 return !!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",[table]);
}
/** 20 之前的结构没有不可变创建顺序，沿用 created_at／rowid 的历史排序。 */
function sourceScopeCTE(tx:StorageTransaction):string{
 if(hasColumn(tx,'read_goal','creation_no')&&tableExists(tx,'history_continuity_scope'))return currentSourceScopeCTE;
 const continuity=tableExists(tx,'history_continuity_scope')?` UNION ALL
 SELECT c.owner_id,c.contact_id,b.id,json_object('sourceGeneration',c.source_generation,'partitions',json_extract(c.tables_json,'$.partitions'),'tables',json((
  SELECT json_group_array(json_object('partition',json_extract(t.value,'$[0]'),'instance',json_extract(t.value,'$[1]'))) FROM json_each(c.tables_json,'$.tables') t)))
 FROM history_continuity_scope c JOIN history_scope_request q ON q.owner_id=c.owner_id
 JOIN conversation_binding b ON b.owner_id=c.owner_id AND b.contact_id=c.contact_id AND b.conversation_id=c.conversation_id AND b.state='verified'
 WHERE (q.contact_scope IS NULL OR c.contact_id=q.contact_id) AND c.tables_json<>'' AND json_valid(c.tables_json)
 AND NOT EXISTS (SELECT 1 FROM current_history_ranked h WHERE h.owner_id=c.owner_id AND h.contact_id=c.contact_id)` : '';
 return `history_scope_request AS MATERIALIZED (SELECT ? owner_id,? contact_scope,? contact_id),
 current_history_ranked AS MATERIALIZED (
  SELECT h.owner_id,h.contact_id,h.binding_id,h.target_json,row_number() OVER(PARTITION BY h.owner_id,h.contact_id ORDER BY h.created_at DESC,h.rowid DESC) position
  FROM read_goal h JOIN history_scope_request q ON q.owner_id=h.owner_id AND (q.contact_scope IS NULL OR h.contact_id=q.contact_id)
  WHERE h.kind='history'
 ), current_history_scope AS MATERIALIZED (
  SELECT owner_id,contact_id,binding_id,target_json FROM current_history_ranked WHERE position=1${continuity}
 ), current_source_members AS MATERIALIZED (
  SELECT h.owner_id,h.contact_id,h.binding_id,json_extract(h.target_json,'$.sourceGeneration') generation,
   json_extract(t.value,'$.partition') partition,json_extract(t.value,'$.instance') instance,
   json_array(json_extract(h.target_json,'$.sourceGeneration'),json_extract(t.value,'$.partition'),json_extract(t.value,'$.instance')) closed_prefix
  FROM current_history_scope h JOIN json_each(h.target_json,'$.tables') t
 ), current_source_ranges AS MATERIALIZED (
  SELECT *,substr(closed_prefix,1,length(closed_prefix)-1)||',' prefix FROM current_source_members
 )`;
}
function acceptedCaptureOrder(tx:StorageTransaction):string{
 return hasColumn(tx,'sync_capture','acceptance_no')
  ?'capture.acceptance_no,capture.captured_at,capture.rowid,source.item_no,source.id'
  :'capture.captured_at,capture.rowid,source.item_no,source.id';
}
/** 新轮只复用有原始成功提取证明且文档阶段受阻的目标，不重新发送提取。 */
function reusableExtraction(tx:StorageTransaction,ownerId:string,contactId:string,item:StorageRow):StorageRow|undefined{
 if(item.extraction_state!=='succeeded'||item.pipeline_state!=='pending'||!item.item_id)return;
 const proof=tx.get(`SELECT a.id AS attempt_id,s.id AS step_id,t.run_id,original.record_id,original.accepted_interpretation_revision FROM step_attempt a
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id AND s.kind='extraction_verification' AND s.state='succeeded' AND s.successful_attempt_id=a.id
  JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id AND t.scope_kind='contact' AND t.contact_id=? AND t.state IN ('succeeded','awaiting_decision')
  JOIN step_input si ON si.owner_id=s.owner_id AND si.step_id=s.id AND si.kind='run_message'
  JOIN run_input original ON original.owner_id=si.owner_id AND original.run_id=si.run_id AND original.input_no=si.run_input_no
  WHERE a.owner_id=? AND a.state='succeeded' AND original.role='target' AND original.item_id=? AND original.message_id=?
  AND (t.error_code LIKE 'document_%' OR EXISTS(SELECT 1 FROM processing_step d WHERE d.owner_id=t.owner_id AND d.task_id=t.id AND d.kind IN ('document_scene','document_profile') AND d.state IN ('failed','unknown'))
   OR (t.document_basis_state='pending' AND NOT EXISTS(SELECT 1 FROM processing_step d WHERE d.owner_id=t.owner_id AND d.task_id=t.id AND d.kind IN ('document_scene','document_profile'))))
  AND NOT EXISTS(SELECT 1 FROM execution_event e JOIN step_attempt oa ON oa.owner_id=e.owner_id AND oa.id=e.step_attempt_id
   JOIN processing_step os ON os.owner_id=oa.owner_id AND os.id=oa.step_id LEFT JOIN memory_candidate c ON c.owner_id=e.owner_id AND c.event_id=e.id
   WHERE e.owner_id=t.owner_id AND os.task_id=t.id AND e.kind='verified_output' AND (c.id IS NULL OR c.state='pending'))
  AND NOT EXISTS(SELECT 1 FROM memory_candidate c JOIN step_attempt ca ON ca.owner_id=c.owner_id AND ca.id=c.produced_attempt_id
   JOIN processing_step cs ON cs.owner_id=ca.owner_id AND cs.id=ca.step_id JOIN processing_task ct ON ct.owner_id=cs.owner_id AND ct.id=cs.task_id
   WHERE c.owner_id=t.owner_id AND ct.run_id=t.run_id AND c.state='pending' AND (ct.id=t.id OR ct.scope_kind='self'))
  ORDER BY a.started_at DESC LIMIT 1`,[contactId,ownerId,item.item_id,item.id]);
 if(!proof||proof.accepted_interpretation_revision!==item.interpretation_revision)return;
 try{
  assertSourceEligibility(tx,{owner_id:ownerId,contact_id:contactId,message_id:String(item.id),record_id:String(proof.record_id)});
  assertTaskContributions(tx,ownerId,String(proof.run_id),String(tx.get('SELECT task_id FROM processing_step WHERE owner_id=? AND id=?',[ownerId,proof.step_id])!.task_id));
  assertInputs(tx,ownerId,String(proof.run_id),inputRows(tx,ownerId,String(proof.step_id)));return proof;
 }catch{return;}
}
/** 每次使用复用证明都重验原 producer 的整窗和原授权，不以新轮代次刷新旧证明。 */
export function currentReuseAttempt(tx:StorageTransaction,ownerId:string,runId:string,inputNo:bigint):string|undefined{
 const proof=tx.get(`SELECT a.id,s.id AS step_id,t.id AS task_id,t.run_id AS original_run_id FROM document_extraction_reuse reuse
  JOIN step_attempt a ON a.owner_id=reuse.owner_id AND a.id=reuse.source_attempt_id AND a.state='succeeded'
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id AND s.kind='extraction_verification' AND s.state='succeeded' AND s.successful_attempt_id=a.id
  JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id AND t.state IN ('succeeded','awaiting_decision')
  WHERE reuse.owner_id=? AND reuse.run_id=? AND reuse.input_no=?`,[ownerId,runId,inputNo]);
 if(!proof)return;
 try{assertTaskContributions(tx,ownerId,String(proof.original_run_id),String(proof.task_id));assertInputs(tx,ownerId,String(proof.original_run_id),inputRows(tx,ownerId,String(proof.step_id)));return String(proof.id);}catch{return;}
}
export function snapshot(tx:StorageTransaction,ownerId:string,runId:string){
 const r=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);if(!r)fail('memory_extraction_not_found');
 const inputs=tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=? ORDER BY input_no',[ownerId,runId]);
 const targets=inputs.filter(i=>i.role==='target');
 const tasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[ownerId,runId]);
 const taskStates=new Map<string,string>();
 for(const task of tasks){let state=String(task.state);try{assertTaskContributions(tx,ownerId,runId,String(task.id));}catch{state='revoked';}taskStates.set(String(task.id),state);}
 const targetStates=new Map<string,Set<string>>();
 for(const row of tx.all(`SELECT si.run_input_no,s.state FROM step_input si JOIN processing_step s ON s.owner_id=si.owner_id AND s.id=si.step_id
 JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 WHERE si.owner_id=? AND si.run_id=? AND s.kind='extraction_verification' AND t.scope_kind='contact' AND t.contact_id=i.source_contact_id`,[ownerId,runId])){
  const key=String(row.run_input_no),states=targetStates.get(key)??new Set<string>();states.add(String(row.state));targetStates.set(key,states);
 }
 if(tx.get('SELECT 1 FROM schema_migration WHERE version=13'))for(const row of tx.all('SELECT input_no FROM document_extraction_reuse WHERE owner_id=? AND run_id=?',[ownerId,runId])){
  if(!currentReuseAttempt(tx,ownerId,runId,row.input_no as bigint))continue;
  const key=String(row.input_no),states=targetStates.get(key)??new Set<string>();states.add('succeeded');targetStates.set(key,states);
 }
 const targetHasState=(i:StorageRow,state:string)=>targetStates.get(String(i.input_no))?.has(state)??false;
 const targetSucceeded=(i:StorageRow)=>targetHasState(i,'succeeded');
 const succeeded=targets.filter(targetSucceeded).length;
 const runningDocument=tx.get(`SELECT s.kind FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND t.state<>'revoked' AND s.state='running' AND s.kind IN ('document_scene','document_profile') ORDER BY s.step_no LIMIT 1`,[ownerId,runId]);
 const candidates=tx.all(`SELECT e.*,t.id AS task_id,t.scope_kind,t.contact_id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? AND e.kind='verified_output' AND t.state<>'revoked' ORDER BY e.created_at,e.event_no`,[ownerId,runId]).flatMap(e=>{
  if(taskStates.get(String(e.task_id))==='revoked')return [];
  try{const deps=tx.all(`SELECT i.* FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no WHERE x.owner_id=? AND x.event_id=?`,[ownerId,e.id]);assertInputs(tx,ownerId,runId,deps);}catch{return [];}
  const p=JSON.parse(String(e.payload));return [{id:String(e.id),attemptId:String(e.step_attempt_id),outputNo:number(e.event_no),scopeKind:p.scopeKind,contactId:p.contactId,body:p.fact.text,fact:p.fact,state:'verified_pending_decision',origin:'auto'}];
 });
 const laterProjection=laterStagesState(tx,ownerId,runId),laterStages:('pending'|'completed')=laterProjection.state==='completed'?'completed':'pending';
 const stage=r!.state==='completed'||laterProjection.state==='completed'?'completed':runningDocument?String(runningDocument.kind):laterProjection.stage??'extraction_verification';
 const result={runId,state:String(r!.state),total:targets.length,succeeded,failed:targets.filter(i=>!targetSucceeded(i)&&targetHasState(i,'failed')).length,unknown:targets.filter(i=>!targetSucceeded(i)&&targetHasState(i,'unknown')).length,
  stage,laterStages,nextDueAt:laterProjection.nextDueAt,tasks:tasks.map(t=>({taskId:String(t.id),scopeKind:String(t.scope_kind),contactId:t.contact_id===null?null:String(t.contact_id),state:taskStates.get(String(t.id))!,
   total:t.scope_kind==='self'?0:targets.filter(i=>i.source_contact_id===t.contact_id).length,succeeded:t.scope_kind==='self'?0:targets.filter(i=>i.source_contact_id===t.contact_id&&targetSucceeded(i)).length,errorCode:t.error_code===null?null:String(t.error_code)})),
  inputs:inputs.map(i=>({inputNo:number(i.input_no),role:String(i.role),contactId:String(i.source_contact_id),messageId:String(i.message_id),recordId:String(i.record_id),itemId:i.item_id===null?null:String(i.item_id)})),candidates};
 return {...result,...projectControl(tx,ownerId,r!,{taskStates,laterStages:laterProjection.state})};
}

/** 同现有手动入口一样复验当前来源；另外记录首个被接受的目标类型和采集时间。 */
function currentMessageRows(tx:StorageTransaction,ownerId:string,contactId:string):StorageRow[]{
 const sourceOrder=acceptedCaptureOrder(tx),scopeCte=sourceScopeCTE(tx),quarantine=tableExists(tx,'history_message_quarantine')?`AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)`:'';
 return tx.all(`WITH ${scopeCte},current_records AS MATERIALIZED (
  SELECT source.message_id,min(source.id) record_id FROM capture_record source
  JOIN sync_capture capture ON capture.owner_id=source.owner_id AND capture.id=source.capture_id
  JOIN read_goal g ON g.owner_id=capture.owner_id AND g.id=capture.goal_id
  WHERE source.owner_id=? AND source.contact_id=? AND source.state='normalized' AND source.availability='available'
   AND ${currentSourcePredicate('source','g')} GROUP BY source.message_id
 ),ranked_first_source AS MATERIALIZED (
  SELECT source.message_id,g.kind AS first_goal_kind,capture.captured_at AS first_captured_at,
   row_number() OVER(PARTITION BY source.message_id ORDER BY ${sourceOrder}) position
  FROM capture_record source JOIN sync_capture capture ON capture.owner_id=source.owner_id AND capture.id=source.capture_id
  JOIN read_goal g ON g.owner_id=capture.owner_id AND g.id=capture.goal_id
  WHERE source.owner_id=? AND source.contact_id=? AND source.state='normalized' AND source.availability='available'
 ),first_source AS MATERIALIZED (
  SELECT message_id,first_goal_kind,first_captured_at FROM ranked_first_source WHERE position=1
 )
 SELECT m.*,r.record_id,p.id AS item_id,p.extraction_state,p.pipeline_state,f.first_goal_kind,f.first_captured_at,
  CASE WHEN p.id IS NOT NULL AND EXISTS(SELECT 1 FROM run_input assigned WHERE assigned.owner_id=p.owner_id AND assigned.item_id=p.id AND assigned.role='target') THEN 1 ELSE 0 END AS target_assigned
 FROM message m JOIN current_records r ON r.message_id=m.id JOIN first_source f ON f.message_id=m.id
 LEFT JOIN processing_item p ON p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.message_id=m.id AND p.purpose='memory_extraction'
 WHERE m.owner_id=? AND m.contact_id=? AND m.kind='text' AND length(trim(m.text_body))>0 AND m.availability='available'
  ${quarantine}
 ORDER BY m.display_no`,[ownerId,contactId,contactId,ownerId,contactId,ownerId,contactId,ownerId,contactId]);
}
function pendingIncrementalStats(tx:StorageTransaction,ownerId:string,contactId:string):{count:number;oldestAt:number|null;latestAt:number|null}{
 const sourceOrder=acceptedCaptureOrder(tx),scopeCte=sourceScopeCTE(tx),quarantine=tableExists(tx,'history_message_quarantine')?`AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)`:'';
 const row=tx.get(`WITH ${scopeCte},current_records AS MATERIALIZED (
  SELECT source.message_id,min(source.id) record_id FROM capture_record source
  JOIN sync_capture capture ON capture.owner_id=source.owner_id AND capture.id=source.capture_id
  JOIN read_goal g ON g.owner_id=capture.owner_id AND g.id=capture.goal_id
  WHERE source.owner_id=? AND source.contact_id=? AND source.state='normalized' AND source.availability='available'
   AND ${currentSourcePredicate('source','g')} GROUP BY source.message_id
 ),ranked_first_source AS MATERIALIZED (
  SELECT source.message_id,g.kind AS first_goal_kind,capture.captured_at AS first_captured_at,
   row_number() OVER(PARTITION BY source.message_id ORDER BY ${sourceOrder}) position
  FROM capture_record source JOIN sync_capture capture ON capture.owner_id=source.owner_id AND capture.id=source.capture_id
  JOIN read_goal g ON g.owner_id=capture.owner_id AND g.id=capture.goal_id
  WHERE source.owner_id=? AND source.contact_id=? AND source.state='normalized' AND source.availability='available'
 ),first_source AS MATERIALIZED (
  SELECT message_id,first_goal_kind,first_captured_at FROM ranked_first_source WHERE position=1
 )
 SELECT count(*) AS pending_count,min(f.first_captured_at) AS oldest_at,max(f.first_captured_at) AS latest_at
 FROM message m JOIN current_records r ON r.message_id=m.id JOIN first_source f ON f.message_id=m.id
 LEFT JOIN processing_item p ON p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.message_id=m.id AND p.purpose='memory_extraction'
 WHERE m.owner_id=? AND m.contact_id=? AND m.kind='text' AND length(trim(m.text_body))>0 AND m.availability='available'
  AND f.first_goal_kind='incremental' AND m.display_no>? AND (p.id IS NULL OR p.extraction_state='pending')
  ${quarantine}
  AND (p.id IS NULL OR NOT EXISTS(SELECT 1 FROM run_input assigned WHERE assigned.owner_id=p.owner_id AND assigned.item_id=p.id AND assigned.role='target'))`,
 [ownerId,contactId,contactId,ownerId,contactId,ownerId,contactId,ownerId,contactId,memoryIncrementalBaseline(tx)]);
 if(!row)return {count:0,oldestAt:null,latestAt:null};
 const count=number(row.pending_count);return {count,oldestAt:row.oldest_at===null?null:timeNumber(row.oldest_at),latestAt:row.latest_at===null?null:timeNumber(row.latest_at)};
}
function latestTargetRun(tx:StorageTransaction,ownerId:string,contactId:string):StorageRow|undefined{
 return tx.get(`SELECT r.* FROM processing_run r JOIN run_contact rc ON rc.owner_id=r.owner_id AND rc.run_id=r.id
  WHERE rc.owner_id=? AND rc.contact_id=? AND rc.state='active' AND coalesce(json_extract(r.policy_config,'$.intent'),'')<>'memory_document_later_stage'
   AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=r.owner_id AND i.run_id=r.id AND i.source_contact_id=rc.contact_id AND i.role='target')
  ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`,[ownerId,contactId]);
}
function taskHasPendingCandidate(tx:StorageTransaction,ownerId:string,taskId:string):boolean{
 return !!tx.get(`SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
  WHERE c.owner_id=? AND s.task_id=? AND c.state='pending' LIMIT 1`,[ownerId,taskId]);
}
function hasNewerSuccessfulL1Run(tx:StorageTransaction,ownerId:string,contactId:string,failedRun:StorageRow):boolean{
 const candidates=tx.all(`SELECT later.* FROM processing_run later JOIN run_contact rc ON rc.owner_id=later.owner_id AND rc.run_id=later.id
  WHERE rc.owner_id=? AND rc.contact_id=? AND rc.state='active' AND later.id<>? AND later.started_at>?
   AND later.state IN ('running','incomplete','completed') AND later.pause_requested_at IS NULL
   AND coalesce(json_extract(later.policy_config,'$.intent'),'')<>'memory_document_later_stage'
   AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=later.owner_id AND i.run_id=later.id AND i.source_contact_id=rc.contact_id AND i.role='target')
  ORDER BY later.started_at DESC,later.rowid DESC`,[ownerId,contactId,failedRun.id,failedRun.started_at]);
 return candidates.some(later=>{
  const runId=String(later.id);if(!extractionCompleteForRun(tx,ownerId,runId,contactId))return false;
  try{
   for(const task of tx.all('SELECT id FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId]))assertTaskContributions(tx,ownerId,runId,String(task.id));
   assertInputs(tx,ownerId,runId,tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=?',[ownerId,runId]));return true;
  }catch{return false;}
 });
}
function followupEligible(tx:StorageTransaction,ownerId:string,runId:string):boolean{
 if(!hasRunFollowupState(tx))return true;
 const run=tx.get(`SELECT * FROM processing_run WHERE owner_id=? AND id=? AND followup_state='pending'
  AND state IN ('running','incomplete') AND pause_requested_at IS NULL
  AND coalesce(json_extract(policy_config,'$.intent'),'')<>'memory_document_later_stage'`,[ownerId,runId]);
 if(!run)return false;
 const tasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId]);
 if(!tasks.length||tasks.some(task=>!['succeeded','awaiting_decision','incomplete'].includes(String(task.state))||task.state==='incomplete'&&(task.scope_kind!=='contact'||task.error_code!=='targets_completed_elsewhere')))return false;
 if(!tasks.some(task=>task.scope_kind==='contact'))return false;
 if(tx.get(`SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE s.owner_id=? AND t.run_id=? AND s.state IN ('failed','unknown','paused','pending','running') LIMIT 1`,[ownerId,runId]))return false;
 if(tx.get(`SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
  JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE c.owner_id=? AND t.run_id=? AND c.state IN ('unknown','sending','prepared') LIMIT 1`,[ownerId,runId]))return false;
 const targets=tx.all(`SELECT p.extraction_state FROM run_input i JOIN processing_item p ON p.owner_id=i.owner_id AND p.id=i.item_id
  WHERE i.owner_id=? AND i.run_id=? AND i.role='target'`,[ownerId,runId]);
 if(!targets.length||targets.some(row=>row.extraction_state!=='succeeded'))return false;
 for(const task of tasks){try{assertTaskContributions(tx,ownerId,runId,String(task.id));}catch{return false;}}
 try{assertInputs(tx,ownerId,runId,tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=?',[ownerId,runId]));}catch{return false;}
 return true;
}
function pendingFollowupIds(tx:StorageTransaction,ownerId:string,runId?:string):string[]{
 if(!hasRunFollowupState(tx))return [];
 const rows=tx.all(`SELECT id FROM processing_run WHERE owner_id=? AND followup_state='pending' AND state IN ('running','incomplete')${runId===undefined?'':' AND id=?'} ORDER BY started_at,rowid`,runId===undefined?[ownerId]:[ownerId,runId]);
 return rows.map(row=>String(row.id)).filter(id=>followupEligible(tx,ownerId,id));
}
function hasUnresolvedContactBlocker(tx:StorageTransaction,ownerId:string,contactId:string):boolean{
 if(tableExists(tx,'memory_document_later_schedule')&&tableExists(tx,'memory_document_later_run_requirement')&&tx.get(`SELECT 1 FROM memory_document_later_schedule s WHERE s.owner_id=? AND (s.scope_kind='self' OR s.contact_id=?)
  AND (s.state IN ('failed','unknown') OR EXISTS(SELECT 1 FROM memory_document_later_run_requirement q WHERE q.owner_id=s.owner_id AND q.scope_key=s.scope_key AND q.generation=s.generation AND q.outcome='pending' AND q.paused=1)) LIMIT 1`,[ownerId,contactId]))return true;
 const runs=tx.all(`SELECT r.* FROM processing_run r JOIN run_contact rc ON rc.owner_id=r.owner_id AND rc.run_id=r.id
  WHERE rc.owner_id=? AND rc.contact_id=? AND rc.state='active'`,[ownerId,contactId]);
 for(const run of runs){
  const runId=String(run.id),tasks=tx.all(`SELECT DISTINCT t.* FROM processing_task t JOIN task_contribution c ON c.owner_id=t.owner_id AND c.task_id=t.id
   WHERE t.owner_id=? AND t.run_id=? AND c.source_contact_id=?`,[ownerId,runId,contactId]);
  if(run.pause_requested_at!==null||run.state==='paused')return true;
  if(tasks.some(task=>task.state==='paused'||task.state==='unknown'))return true;
  if(tx.get(`SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
   JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   JOIN task_contribution tc ON tc.owner_id=t.owner_id AND tc.task_id=t.id
   WHERE c.owner_id=? AND c.state='unknown' AND t.run_id=? AND tc.source_contact_id=? LIMIT 1`,[ownerId,runId,contactId]))return true;
  if(tx.get(`SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   JOIN task_contribution tc ON tc.owner_id=t.owner_id AND tc.task_id=t.id
   WHERE s.owner_id=? AND s.state='unknown' AND t.run_id=? AND tc.source_contact_id=? LIMIT 1`,[ownerId,runId,contactId]))return true;
  if(tx.get(`SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
   JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   JOIN task_contribution tc ON tc.owner_id=t.owner_id AND tc.task_id=t.id
   WHERE c.owner_id=? AND c.state='pending' AND t.run_id=? AND tc.source_contact_id=? LIMIT 1`,[ownerId,runId,contactId]))return true;
  const failed=run.state==='failed'||tasks.some(task=>task.state==='failed')||!!tx.get(`SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
   JOIN task_contribution tc ON tc.owner_id=t.owner_id AND tc.task_id=t.id
   WHERE s.owner_id=? AND t.run_id=? AND tc.source_contact_id=? AND s.state='failed' LIMIT 1`,[ownerId,runId,contactId]);
  if(failed){
   const newer=hasNewerSuccessfulL1Run(tx,ownerId,contactId,run);
   if(run.state!=='completed'&&!newer)return true;
  }
 }
 return false;
}
function extractionCompleteForRun(tx:StorageTransaction,ownerId:string,runId:string,contactId:string):boolean{
 const targets=tx.all(`SELECT p.extraction_state FROM run_input i JOIN processing_item p ON p.owner_id=i.owner_id AND p.id=i.item_id
  WHERE i.owner_id=? AND i.run_id=? AND i.source_contact_id=? AND i.role='target'`,[ownerId,runId,contactId]);
 if(!targets.length||targets.some(row=>row.extraction_state!=='succeeded'))return false;
 const contactTask=tx.get("SELECT * FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,runId,contactId]);
 if(!contactTask||!(contactTask.state==='succeeded'||contactTask.state==='incomplete'&&contactTask.error_code==='targets_completed_elsewhere'))return false;
 const linkedTasks=tx.all(`SELECT DISTINCT t.* FROM processing_task t JOIN task_contribution c ON c.owner_id=t.owner_id AND c.task_id=t.id
  WHERE t.owner_id=? AND t.run_id=? AND c.source_contact_id=?`,[ownerId,runId,contactId]);
 if(linkedTasks.some(task=>task.scope_kind==='self'&&task.state!=='succeeded'&&!(task.state==='awaiting_decision'&&!taskHasPendingCandidate(tx,ownerId,String(task.id)))))return false;
 return true;
}
function hasOnlyLaterStageWaiting(tx:StorageTransaction,ownerId:string,contactId:string,run:StorageRow):boolean{
 if(run.state!=='incomplete'||run.pause_requested_at!==null||!extractionCompleteForRun(tx,ownerId,String(run.id),contactId))return false;
 const later=String(laterStagesState(tx,ownerId,String(run.id)).state);
 return later==='pending'||later==='scheduled';
}
interface ContactQueueState {contactId:string;pendingCount:number;oldestAt:number|null;latestAt:number|null;lastStartedAt:number|null;blocked:boolean}
function contactQueueState(tx:StorageTransaction,ownerId:string,contactId:string):ContactQueueState{
 const latest=latestTargetRun(tx,ownerId,contactId);
 let blocked=hasUnresolvedContactBlocker(tx,ownerId,contactId);
 if(latest&&latest.state!=='completed'&&latest.state!=='revoked'&&!hasOnlyLaterStageWaiting(tx,ownerId,contactId,latest))blocked=true;
 const last=tx.get(`SELECT max(r.started_at) AS started_at FROM processing_run r JOIN run_contact rc ON rc.owner_id=r.owner_id AND rc.run_id=r.id
  WHERE rc.owner_id=? AND rc.contact_id=? AND rc.state='active' AND coalesce(json_extract(r.policy_config,'$.intent'),'')<>'memory_document_later_stage'
   AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=r.owner_id AND i.run_id=r.id AND i.source_contact_id=rc.contact_id AND i.role='target')`,[ownerId,contactId]);
 const pending=pendingIncrementalStats(tx,ownerId,contactId);
 return {contactId,pendingCount:pending.count,oldestAt:pending.oldestAt,latestAt:pending.latestAt,lastStartedAt:last?.started_at===null||last?.started_at===undefined?null:timeNumber(last.started_at),blocked};
}
function validContacts(tx:StorageTransaction,ownerId:string,contactId?:string):StorageRow[]{
 return tx.all(`SELECT DISTINCT c.*,g.id AS grant_id,g.binding_id,b.identity_generation,a.scope_revision,a.source_generation FROM contact c JOIN read_grant g ON g.owner_id=c.owner_id AND g.contact_id=c.id AND g.revoked_at IS NULL
  JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id JOIN channel_conversation cv ON cv.owner_id=b.owner_id AND cv.id=b.conversation_id
  JOIN channel_account a ON a.owner_id=cv.owner_id AND a.id=cv.account_id
  WHERE c.owner_id=? AND c.state='active' AND b.state='verified' AND a.identity_state='verified'${contactId===undefined?'':' AND c.id=?'} ORDER BY c.id`,contactId===undefined?[ownerId]:[ownerId,contactId]);
}
function triggerAt(state:ContactQueueState,now:number):number|null{
 if(state.blocked||!state.pendingCount||state.oldestAt===null||state.latestAt===null)return null;
 const candidate=state.pendingCount>=volumeThreshold?now:Math.min(state.latestAt+quietThreshold,state.oldestAt+ageThreshold);
 const cooldown=state.lastStartedAt===null?0:state.lastStartedAt+startCooldown;
 return Math.max(candidate,cooldown);
}
function queueStates(tx:StorageTransaction,ownerId:string,now:number,contactId?:string):{state:ContactQueueState;dueAt:number|null}[]{
 const contacts=validContacts(tx,ownerId,contactId);
 return contacts.map(row=>{const state=contactQueueState(tx,ownerId,String(row.id));return {state,dueAt:triggerAt(state,now)};});
}
function scheduleSummary(tx:StorageTransaction,ownerId:string,now:number){
 const states=queueStates(tx,ownerId,now),pending=states.reduce((sum,row)=>sum+row.state.pendingCount,0),due=states.map(row=>row.dueAt).filter((value):value is number=>value!==null);
 return {pending,nextDueAt:due.length?due.reduce((earliest,value)=>Math.min(earliest,value)):null,blockedContacts:states.filter(row=>row.state.pendingCount>0&&row.state.blocked).length};
}
function startRun(tx:StorageTransaction,raw:unknown,scheduled=false){
 const i=raw as {ownerId:string;requestKey:string;policyConfig:unknown;followupStages?:boolean;contactId?:string;now?:number};
 const ownerId=textId(i.ownerId),requestKey=textId(i.requestKey),contactId=scheduled?textId(i.contactId):undefined,now=scheduled?checkedNow(i.now):Date.now();
 const existing=tx.get('SELECT id FROM processing_run WHERE owner_id=? AND start_request_key=?',[ownerId,requestKey]);if(existing)return snapshot(tx,ownerId,String(existing.id));
 const owner=tx.get("SELECT * FROM owner WHERE owner_id=? AND state='active'",[ownerId]);if(!owner)fail('memory_extraction_scope_stale');
 if(tx.get('SELECT 1 FROM request_tombstone WHERE owner_identity=? AND request_key=?',[ownerId,requestKey]))fail('memory_extraction_request_deleted');
 if(scheduled){
  const current=queueStates(tx,ownerId,now,contactId!)[0];if(!current||current.dueAt===null||current.dueAt>now)return null;
 }
 const runId=randomUUID();
 if(hasRunFollowupState(tx))tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config,followup_state) VALUES(?,?,?,'preparing',?,?,?,?)",[ownerId,runId,requestKey,now,owner!.feedback_revision,JSON.stringify(i.policyConfig),i.followupStages===true?'pending':'none']);
 else tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'preparing',?,?,?)",[ownerId,runId,requestKey,now,owner!.feedback_revision,JSON.stringify(i.policyConfig)]);
 const contacts=scheduled?validContacts(tx,ownerId,contactId):validContacts(tx,ownerId);
 let inputNo=0;const contributing:string[]=[];
 for(const c of contacts){
  const rows=currentMessageRows(tx,ownerId,String(c.id));
  // 只有接线了后续文档阶段的正常宿主才复用已有提取证明；仅提取入口保持“已成功目标不重做”。
  const canReuse=!scheduled&&i.followupStages===true&&!!tx.get('SELECT 1 FROM schema_migration WHERE version=13'),reused=new Map<string,StorageRow>();
  if(canReuse)for(const row of rows){const proof=reusableExtraction(tx,ownerId,String(c.id),row);if(proof)reused.set(String(row.id),proof);}
  const baseline=scheduled?memoryIncrementalBaseline(tx):0n;
  const targets=scheduled?rows.filter(r=>r.first_goal_kind==='incremental'&&(r.display_no as bigint)>baseline&&(r.item_id===null||r.extraction_state==='pending')&&r.target_assigned!==1n&&r.target_assigned!==1):
   rows.filter(r=>r.extraction_state!=='succeeded'||reused.has(String(r.id)));
  if(!targets.length)continue;
  const targetIds=new Set(targets.map(row=>String(row.id)));
  if(scheduled)for(const target of targets)assertSourceEligibility(tx,{owner_id:ownerId,contact_id:String(c.id),message_id:String(target.id),record_id:String(target.record_id)});
  tx.run('INSERT INTO run_contact VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[ownerId,runId,c.id,c.grant_id,c.binding_id,c.selection_generation,c.data_generation,c.identity_generation,c.scope_revision,c.source_generation,c.feedback_revision,'active']);
  assertContribution(tx,ownerId,runId,String(c.id));contributing.push(String(c.id));
  const context=rows.filter(r=>r.extraction_state==='succeeded'&&!reused.has(String(r.id))).slice(-8); // 有界前文也在点击事务内冻结。
  for(const m of [...context,...targets]){
   const proof=reused.get(String(m.id)),isTarget=targetIds.has(String(m.id));let itemId=isTarget?m.item_id:null;
   if(isTarget&&!itemId){itemId=randomUUID();tx.run("INSERT INTO processing_item VALUES(?,?,?,?,'memory_extraction','pending','pending',NULL)",[ownerId,itemId,c.id,m.id]);}
   tx.run("INSERT INTO run_input VALUES(?,?,?,?,'message',?,?,?,?,?)",[ownerId,runId,++inputNo,isTarget?'target':'context',c.id,itemId,m.id,proof?.record_id??m.record_id,m.interpretation_revision]);
   if(proof)tx.run('INSERT INTO document_extraction_reuse VALUES(?,?,?,?)',[ownerId,runId,inputNo,proof.attempt_id]);
  }
  const taskId=randomUUID();tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state) VALUES(?,?,?,'contact',?,'pending')",[ownerId,taskId,runId,c.id]);
  tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[ownerId,taskId,runId,c.id]);
 }
 if(!contributing.length&&scheduled){tx.run('DELETE FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);return null;}
 if(contributing.length){const self=randomUUID();tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,state) VALUES(?,?,?,'self','pending')",[ownerId,self,runId]);for(const c of contributing)tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[ownerId,self,runId,c]);}
 tx.run("UPDATE processing_run SET state='pending' WHERE owner_id=? AND id=?",[ownerId,runId]);return snapshot(tx,ownerId,runId);
}
export const scheduleActions:StorageAction[]=[
 {name:'memoryExtraction.dueContacts',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;now:number};const ownerId=textId(i.ownerId),now=checkedNow(i.now);return queueStates(tx,ownerId,now).filter(row=>row.dueAt!==null&&row.dueAt<=now).map(row=>row.state.contactId);}},
 {name:'memoryExtraction.nextDueAt',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;now:number};const ownerId=textId(i.ownerId),now=checkedNow(i.now);let earliest:number|null=null;for(const row of queueStates(tx,ownerId,now)){if(row.dueAt!==null&&(earliest===null||row.dueAt<earliest))earliest=row.dueAt;}return earliest;}},
 {name:'memoryExtraction.readSchedule',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;now:number};return scheduleSummary(tx,textId(i.ownerId),checkedNow(i.now));}},
];
export const runActions:StorageAction[]=[...scheduleActions,{name:'memoryExtraction.findRequest',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;requestKey:string};const r=tx.get('SELECT id FROM processing_run WHERE owner_id=? AND start_request_key=?',[textId(i.ownerId),textId(i.requestKey)]);return r?snapshot(tx,i.ownerId,String(r.id)):null;}},{name:'memoryExtraction.contactGeneration',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;contactId:string};const r=tx.get('SELECT data_generation FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId]);if(!r)fail('memory_extraction_scope_stale');return {generation:String(r!.data_generation)};}},{name:'memoryExtraction.start',mode:'write',retryBusy:true,execute(tx,raw){return startRun(tx,raw);}},{name:'memoryExtraction.startContact',mode:'write',retryBusy:true,execute(tx,raw){return startRun(tx,raw,true);}},{name:'memoryExtraction.read',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;runId?:string};const owner=textId(i.ownerId);if(i.runId)return snapshot(tx,owner,textId(i.runId));const r=tx.get(`SELECT id FROM processing_run WHERE owner_id=? AND coalesce(json_extract(policy_config,'$.intent'),'')<>'memory_document_later_stage'
 AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=processing_run.owner_id AND i.run_id=processing_run.id AND i.role='target')
 ORDER BY started_at DESC,rowid DESC LIMIT 1`,[owner]);return r?snapshot(tx,owner,String(r.id)):null;}},{name:'memoryExtraction.pendingFollowups',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string};return pendingFollowupIds(tx,textId(i.ownerId));}},{name:'memoryExtraction.followupEligible',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;runId:string};return pendingFollowupIds(tx,textId(i.ownerId),textId(i.runId)).length===1;}}];
