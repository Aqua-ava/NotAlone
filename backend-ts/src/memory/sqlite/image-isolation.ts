/** 图片隔离沿冻结输入保存元数据；显式重试只恢复原轮图片，不建立新的联系人运行入口。 */
import {randomUUID} from 'node:crypto';
import type {StorageLease,StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {MODEL_IMAGE_LIMITS} from '../../platform/models/image-normalization.ts';
import {assertInputs,assertTaskContributions,currentAttempt,fail,textId} from './qualification.ts';
import {readFrozenContent} from './content.ts';
import {resumeRunSchedule,setRunSchedulePaused} from './documents/later-schedule.ts';

export interface IsolatedImageInput {inputNo:number;itemId:string;fileId:string;sha256:string;attemptId:string;eventId:string;contactId:string}
const reason='media_model_input_unavailable';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function number(value:unknown):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('memory_extraction_count_invalid');return n;}
function append(tx:StorageTransaction,ownerId:string,attemptId:string,kind:string,payload:unknown):string{
 const eventId=randomUUID(),eventNo=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[ownerId,attemptId])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,attemptId,eventNo!,kind,JSON.stringify(payload),Date.now()]);return eventId;
}
function consecutive(tx:StorageTransaction,ownerId:string,runId:string):number{
 const events=tx.all(`SELECT e.kind FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND e.kind IN ('media_input_isolated','image_input_recovered','image_retry_requested')
  ORDER BY e.created_at DESC,e.rowid DESC LIMIT 3`,[ownerId,runId]);
 let count=0;for(const event of events){if(event.kind!=='media_input_isolated')break;count++;}return count;
}
/** 只认最新的隔离/重试事实及当前有效原图；旧隔离不能给之后的其他失败冒领原因。 */
export function isolatedInputs(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string):IsolatedImageInput[]{
 if(!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_content_input'"))return [];
 if(!tx.get("SELECT 1 FROM run_content_input WHERE owner_id=? AND run_id=? AND content_kind='image' LIMIT 1",[ownerId,runId]))return [];
 const rows=tx.all(`WITH latest AS (
  SELECT i.*,e.id AS event_id,e.kind AS event_kind,e.payload,e.step_attempt_id,
   row_number() OVER(PARTITION BY i.input_no ORDER BY e.created_at DESC,e.rowid DESC) position
  FROM run_input i JOIN processing_item p ON p.owner_id=i.owner_id AND p.id=i.item_id AND p.contact_id=i.source_contact_id
  JOIN run_content_input f ON f.owner_id=i.owner_id AND f.run_id=i.run_id AND f.input_no=i.input_no
  JOIN step_input si ON si.owner_id=i.owner_id AND si.run_id=i.run_id AND si.run_input_no=i.input_no
  JOIN execution_input x ON x.owner_id=si.owner_id AND x.planned_step_id=si.step_id AND x.planned_input_no=si.input_no
  JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id
  WHERE i.owner_id=? AND i.run_id=? AND i.role='target' AND p.extraction_state='failed' AND f.content_kind='image'
   AND e.kind IN ('media_input_isolated','image_retry_requested')${contactId===undefined?'':' AND i.source_contact_id=?'}
 ) SELECT * FROM latest WHERE position=1 AND event_kind='media_input_isolated' ORDER BY input_no`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
 const result:IsolatedImageInput[]=[];
 for(const row of rows){
  try{
   assertInputs(tx,ownerId,runId,[row]);const frozen=readFrozenContent(tx,ownerId,row),payload=JSON.parse(String(row.payload));
   if(frozen?.kind!=='image'||payload.reason!==reason||payload.file_id!==frozen.identity.fileId||payload.sha256!==frozen.identity.sha256)continue;
   result.push({inputNo:number(row.input_no),itemId:String(row.item_id),fileId:String(payload.file_id),sha256:String(payload.sha256),attemptId:String(row.step_attempt_id),eventId:String(row.event_id),contactId:String(row.source_contact_id)});
  }catch{/* 已删除、替换或撤销的历史隔离不再具有当前重试资格。 */}
 }
 return result;
}
/** 联系人汇总与新轮准入共用当前隔离身份；只读取事件/文件元数据，不载入聊天正文。 */
export function isolatedContactItemIds(tx:StorageTransaction,ownerId:string,contactId:string):ReadonlySet<string>{
 const rows=tx.all(`WITH isolated_contact_events AS (
  SELECT p.id,e.kind,e.payload,row_number() OVER(PARTITION BY p.id ORDER BY e.created_at DESC,e.rowid DESC) position
  FROM processing_item p JOIN run_input i ON i.owner_id=p.owner_id AND i.item_id=p.id AND i.source_contact_id=p.contact_id
  JOIN step_input si ON si.owner_id=i.owner_id AND si.run_id=i.run_id AND si.run_input_no=i.input_no
  JOIN execution_input x ON x.owner_id=si.owner_id AND x.planned_step_id=si.step_id AND x.planned_input_no=si.input_no
  JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.event_id AND e.kind IN ('media_input_isolated','image_retry_requested')
  WHERE p.owner_id=? AND p.contact_id=? AND p.extraction_state='failed'
 ) SELECT DISTINCT e.id FROM isolated_contact_events e JOIN processing_item p ON p.id=e.id AND p.owner_id=? AND p.contact_id=?
 JOIN media_file file ON file.owner_id=p.owner_id AND file.contact_id=p.contact_id AND file.message_id=p.message_id
  AND file.id=json_extract(e.payload,'$.file_id') AND file.content_digest=json_extract(e.payload,'$.sha256')
 WHERE e.position=1 AND e.kind='media_input_isolated' AND json_extract(e.payload,'$.reason')='media_model_input_unavailable'
  AND file.content_state='present' AND file.publish_state='current'`,[ownerId,contactId,ownerId,contactId]);
 return new Set(rows.map(row=>String(row.id)));
}
export function recordImageIsolation(tx:StorageTransaction,input:{ownerId:string;attemptId:string;inputNo:number},lease:StorageLease):{paused:boolean;count:number}{
 const {ownerId,attemptId}=input,{attempt,task,rows}=currentAttempt(tx,ownerId,attemptId,lease);
 if(!Number.isSafeInteger(input.inputNo)||input.inputNo<1)fail('memory_extraction_input_not_frozen');
 const row=rows.find(row=>number(row.input_no)===input.inputNo&&row.role==='target'),frozen=row?readFrozenContent(tx,ownerId,row):null;
 if(!row||frozen?.kind!=='image')fail('memory_extraction_input_not_frozen');
 const item=tx.get('SELECT extraction_state FROM processing_item WHERE owner_id=? AND id=?',[ownerId,row!.item_id]);
 if(!item||!['pending','running','failed'].includes(String(item.extraction_state)))fail('memory_extraction_targets_completed_elsewhere');
 // 继续同一步骤只复用已隔离叶；显式重试建立新步骤，才能登记新的失败。
 const exists=tx.get(`SELECT 1 FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  WHERE e.owner_id=? AND a.step_id=? AND e.kind='media_input_isolated' AND json_extract(e.payload,'$.input_no')=?
   AND json_extract(e.payload,'$.file_id')=? AND json_extract(e.payload,'$.sha256')=? LIMIT 1`,
  [ownerId,attempt.step_id,input.inputNo,String(frozen!.identity.fileId),String(frozen!.identity.sha256)]);
 if(!exists){
  const eventId=append(tx,ownerId,attemptId,'media_input_isolated',{reason,input_no:input.inputNo,file_id:String(frozen!.identity.fileId),sha256:String(frozen!.identity.sha256)});
  tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,1,?,1,?,?)',[ownerId,eventId,row!.role,attempt.step_id,row!.planned_input_no]);
  tx.run('INSERT INTO event_source(owner_id,event_id,source_contact_id,record_id) VALUES(?,?,?,?)',[ownerId,eventId,row!.source_contact_id,row!.record_id]);
  tx.run("UPDATE processing_item SET extraction_state='failed' WHERE owner_id=? AND id=?",[ownerId,row!.item_id]);
 }
 const count=consecutive(tx,ownerId,String(task.run_id));
 if(count>=3){
  tx.run("UPDATE processing_run SET pause_requested_at=coalesce(pause_requested_at,?),state='paused',intent_revision=intent_revision+CASE WHEN pause_requested_at IS NULL THEN 1 ELSE 0 END WHERE owner_id=? AND id=?",[Date.now(),ownerId,task.run_id]);
  setRunSchedulePaused(tx,ownerId,String(task.run_id),true);
 }
 const paused=tx.get('SELECT pause_requested_at FROM processing_run WHERE owner_id=? AND id=?',[ownerId,task.run_id])?.pause_requested_at!==null;
 return {paused,count};
}
function eligible(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string,requireAutomatic=true):{run:StorageRow;items:IsolatedImageInput[]}{
 const run=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);if(!run)fail('memory_extraction_not_found');
 if(['revoked','preparing'].includes(String(run!.state)))fail('memory_extraction_scope_stale');
 const items=isolatedInputs(tx,ownerId,runId,contactId);if(!items.length)fail('memory_extraction_no_isolated_images');
 if(requireAutomatic&&Number(tx.get('SELECT memory_auto_processing FROM database_instance WHERE slot=1')?.memory_auto_processing)!==1)fail('memory_auto_processing_disabled');
 const contacts=JSON.stringify([...new Set(items.map(item=>item.contactId))]);
 const scope=`(t.run_id=? OR EXISTS(SELECT 1 FROM task_contribution tc WHERE tc.owner_id=t.owner_id AND tc.task_id=t.id AND tc.source_contact_id IN (SELECT value FROM json_each(?))))`;
 const values=[ownerId,runId,contacts];
 if(tx.get(`SELECT 1 FROM processing_task t WHERE t.owner_id=? AND ${scope} AND (t.state='unknown'
  OR EXISTS(SELECT 1 FROM processing_step s WHERE s.owner_id=t.owner_id AND s.task_id=t.id AND (s.state='unknown'
   OR EXISTS(SELECT 1 FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id AND a.state='unknown')
   OR EXISTS(SELECT 1 FROM model_operation o LEFT JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE o.owner_id=s.owner_id AND o.memory_step_id=s.id AND (o.state='unknown' OR c.state='unknown' OR c.settlement_state='unknown'))))) LIMIT 1`,values))fail('memory_extraction_receipt_unknown');
 if(tx.get(`SELECT 1 FROM processing_task t WHERE t.owner_id=? AND ${scope} AND EXISTS(
  SELECT 1 FROM processing_step s WHERE s.owner_id=t.owner_id AND s.task_id=t.id AND (
   EXISTS(SELECT 1 FROM step_attempt a WHERE a.owner_id=s.owner_id AND a.step_id=s.id AND a.state='running' AND a.lease_expires_at>=?)
   OR EXISTS(SELECT 1 FROM model_operation o LEFT JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE o.owner_id=s.owner_id AND o.memory_step_id=s.id AND (o.state IN ('prepared','in_flight') OR c.state IN ('prepared','sending') OR c.settlement_state='reserved')))) LIMIT 1`,[...values,Date.now()]))fail('memory_extraction_contact_busy');
 if(tx.get(`SELECT 1 FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN task_contribution tc ON tc.owner_id=s.owner_id AND tc.task_id=s.task_id
  WHERE c.owner_id=? AND c.state='pending' AND tc.source_contact_id IN (SELECT value FROM json_each(?)) LIMIT 1`,[ownerId,contacts]))fail('memory_extraction_history_blocked');
 if(tx.get("SELECT 1 FROM operation_item WHERE owner_id=? AND item_id IN (SELECT value FROM json_each(?)) AND state IN ('reserved','sent','unknown') LIMIT 1",[ownerId,JSON.stringify(items.map(item=>item.itemId))]))fail('memory_extraction_contact_busy');
 for(const contact of new Set(items.map(item=>item.contactId))){
  const task=tx.get("SELECT id FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,runId,contact]);
  if(!task)fail('memory_extraction_scope_stale');assertTaskContributions(tx,ownerId,runId,String(task!.id));
 }
 return {run:run!,items};
}
export function canRetryIsolatedImages(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string):boolean{try{eligible(tx,ownerId,runId,contactId,false);return true;}catch{return false;}}
export function retryIsolatedImages(tx:StorageTransaction,input:{ownerId:string;runId:string;actionVersion:number;operationId:string}):{ownerId:string;runId:string;replayed:boolean}{
 const ownerId=textId(input.ownerId),runId=textId(input.runId);
 if(!Number.isSafeInteger(input.actionVersion)||input.actionVersion<0||!uuid.test(input.operationId))fail('memory_extraction_input_invalid');
 if(Number(tx.get('SELECT memory_auto_processing FROM database_instance WHERE slot=1')?.memory_auto_processing)!==1)fail('memory_auto_processing_disabled');
 const replay=tx.get(`SELECT e.payload FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND e.kind='image_retry_requested' AND json_extract(e.payload,'$.operation_id')=? LIMIT 1`,[ownerId,runId,input.operationId]);
 if(replay){
  if(JSON.parse(String(replay.payload)).expected_version!==input.actionVersion)fail('memory_extraction_control_conflict');
  const proof=tx.all(`SELECT DISTINCT i.* FROM execution_event e JOIN execution_input x ON x.owner_id=e.owner_id AND x.event_id=e.id
   JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no
   JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
   WHERE i.owner_id=? AND i.run_id=? AND e.kind='image_retry_requested' AND json_extract(e.payload,'$.operation_id')=?`,[ownerId,runId,input.operationId]);
  if(!proof.length)fail('memory_extraction_scope_stale');assertInputs(tx,ownerId,runId,proof);
  return {ownerId,runId,replayed:true};
 }
 const current=tx.get('SELECT intent_revision FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 if(!current)fail('memory_extraction_not_found');
 if(BigInt(input.actionVersion)!==current!.intent_revision)fail('memory_extraction_control_conflict');
 const {items}=eligible(tx,ownerId,runId);
 tx.run("UPDATE processing_run SET state='pending',pause_requested_at=NULL,intent_revision=intent_revision+1 WHERE owner_id=? AND id=? AND intent_revision=?",[ownerId,runId,input.actionVersion]);
 if(Number(tx.get('SELECT changes() AS n')?.n)!==1)fail('memory_extraction_control_conflict');
 for(const item of items){
  const eventId=append(tx,ownerId,item.attemptId,'image_retry_requested',{operation_id:input.operationId,expected_version:input.actionVersion,input_no:item.inputNo,file_id:item.fileId,sha256:item.sha256});
  for(const row of tx.all('SELECT * FROM execution_input WHERE owner_id=? AND event_id=? ORDER BY input_no',[ownerId,item.eventId]))tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,row.input_no,row.role,row.presentation_no,row.planned_step_id,row.planned_input_no]);
  for(const row of tx.all('SELECT * FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,item.eventId]))tx.run('INSERT INTO event_source(owner_id,event_id,source_contact_id,record_id) VALUES(?,?,?,?)',[ownerId,eventId,row.source_contact_id,row.record_id]);
  tx.run("UPDATE processing_item SET extraction_state='pending' WHERE owner_id=? AND id=? AND extraction_state='failed'",[ownerId,item.itemId]);
 }
 for(const contactId of new Set(items.map(item=>item.contactId))){
  const task=tx.get("SELECT id FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact' AND contact_id=?",[ownerId,runId,contactId])!;
  const selected=items.filter(item=>item.contactId===contactId),inputNos=JSON.stringify(selected.map(item=>item.inputNo));
  tx.run("UPDATE step_attempt SET state='aborted',finished_at=?,error_code='image_retry_requested' WHERE owner_id=? AND state='running' AND lease_expires_at<? AND step_id IN (SELECT id FROM processing_step WHERE owner_id=? AND task_id=?)",[Date.now(),ownerId,Date.now(),ownerId,task.id]);
  tx.run("UPDATE processing_step SET state='revoked' WHERE owner_id=? AND task_id=? AND state IN ('pending','failed','running') AND id IN (SELECT step_id FROM step_input WHERE owner_id=? AND run_id=? AND run_input_no IN (SELECT value FROM json_each(?)))",[ownerId,task.id,ownerId,runId,inputNos]);
  for(let offset=0;offset<selected.length;offset+=MODEL_IMAGE_LIMITS.maxImagesPerMessage){
   const stepId=randomUUID(),stepNo=tx.get('SELECT coalesce(max(step_no),0)+1 AS n FROM processing_step WHERE owner_id=? AND task_id=?',[ownerId,task.id])!.n;
   tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id) VALUES(?,?,?,?,'extraction_verification','pending','frozen',NULL)",[ownerId,stepId,task.id,stepNo]);
   for(const [index,item]of selected.slice(offset,offset+MODEL_IMAGE_LIMITS.maxImagesPerMessage).entries())tx.run('INSERT INTO step_input(owner_id,step_id,input_no,run_id,run_input_no) VALUES(?,?,?,?,?)',[ownerId,stepId,index+1,runId,item.inputNo]);
  }
  tx.run("UPDATE processing_task SET state='pending',error_code=NULL,control_revision=control_revision+1,resume_no=resume_no+1 WHERE owner_id=? AND id=?",[ownerId,task.id]);
 }
 setRunSchedulePaused(tx,ownerId,runId,false);resumeRunSchedule(tx,ownerId,runId);
 return {ownerId,runId,replayed:false};
}
