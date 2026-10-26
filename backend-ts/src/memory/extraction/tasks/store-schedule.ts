/** 原097持久观察调度；业务身份来自已提交来源，通知正文不参与入队。 */
import type pg from 'pg';
import {ExtractionTaskError,lockExtractionScope,type ExtractionScope,type ExtractionTaskStore} from './store.ts';
import type {CompleteClaimRuntimeConfig} from '../policy-version.ts';
const pendingSource=`FROM memory_extraction_receipt r JOIN local_wechat_observation o ON o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id
 JOIN conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
 WHERE r.owner_id=$1 AND r.contact_id=$2 AND r.task_id IS NULL AND b.status='active'
 AND EXISTS(SELECT 1 FROM message_source_ref ref WHERE ref.message_id=r.message_id AND ref.observation_id=o.id)`;
async function count(c:pg.ClientBase,scope:ExtractionScope):Promise<number>{return(await c.query(`SELECT count(*)::int AS n ${pendingSource}`,[scope.ownerId,scope.contactId])).rows[0].n;}
export async function recordExtractionObservation(c:pg.ClientBase,scope:ExtractionScope,observationId:string,ids:readonly string[]):Promise<void>{
 if(!ids.length)return;await lockExtractionScope(c,scope);
 await c.query('INSERT INTO memory_extraction_schedule(owner_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[scope.ownerId,scope.contactId]);
 const inserted=(await c.query(`INSERT INTO memory_extraction_receipt(message_id,owner_id,contact_id,observation_id)
  SELECT DISTINCT m.id,m.owner_id,m.contact_id,o.id FROM message m JOIN message_source_ref ref
  ON ref.message_id=m.id AND ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id JOIN local_wechat_observation o
  ON o.id=ref.observation_id AND o.owner_id=m.owner_id AND o.contact_id=m.contact_id JOIN conversation_binding b
  ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id WHERE m.owner_id=$1 AND m.contact_id=$2
  AND o.id=$3 AND m.id=ANY($4::uuid[]) AND b.status='active' ON CONFLICT DO NOTHING RETURNING message_id`,[scope.ownerId,scope.contactId,observationId,ids])).rows;
 if(!inserted.length)return;
 const previous=(await c.query("SELECT id,status FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation' FOR UPDATE",[scope.ownerId,scope.contactId])).rows[0];
 if(previous?.status==='cancelled'){
  await c.query('UPDATE memory_extraction_receipt SET task_id=$3 WHERE owner_id=$1 AND contact_id=$2 AND task_id IS NULL AND NOT(message_id=ANY($4::uuid[]))',[scope.ownerId,scope.contactId,previous.id,inserted.map(r=>r.message_id)]);
  await c.query('DELETE FROM memory_processing_plan WHERE task_id=$1',[previous.id]);
  await c.query('UPDATE memory_extraction_schedule SET threshold=1,task_id=NULL WHERE owner_id=$1 AND contact_id=$2',[scope.ownerId,scope.contactId]);
 }
 const n=await count(c,scope);
 await c.query(`UPDATE memory_extraction_schedule SET pending_count=$3,last_input_at=now(),
  due_at=CASE WHEN $3>=threshold THEN now() ELSE now()+interval '600 seconds' END WHERE owner_id=$1 AND contact_id=$2`,[scope.ownerId,scope.contactId,n]);
}
async function observationTask(c:pg.ClientBase,scope:ExtractionScope,n:number,runtimeConfig:CompleteClaimRuntimeConfig|null):Promise<string>{
 if(!(await c.query("SELECT 1 FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active' LIMIT 1 FOR KEY SHARE",[scope.ownerId,scope.contactId])).rowCount)throw new ExtractionTaskError('source_unavailable');
 const existing=(await c.query("SELECT id,status FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation' FOR UPDATE",[scope.ownerId,scope.contactId])).rows[0];
 let taskId=existing?.id;
 if(!existing)taskId=(await c.query("INSERT INTO background_task(owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,extraction_runtime_config) VALUES($1,$2,NULL,'observation','queued','extract_memory',$3,$4::jsonb) RETURNING id",[scope.ownerId,scope.contactId,n,runtimeConfig?JSON.stringify(runtimeConfig):null])).rows[0].id;
 else if(['succeeded','failed','cancelled'].includes(existing.status)){
  await c.query("UPDATE background_task SET status='queued',current_step='extract_memory',message_count=$2,retry_count=0,last_error_code=NULL,started_at=NULL,finished_at=NULL,observation_pending=false,updated_at=now() WHERE id=$1",[taskId,n]);
  await c.query(`UPDATE background_task_step SET status='pending',attempt_count=0,processed_count=0,total_count=$2,worker_id=NULL,
   lease_expires_at=NULL,last_error_code=NULL,started_at=NULL,finished_at=NULL,updated_at=now() WHERE task_id=$1`,[taskId,n]);
 }else await c.query(`UPDATE background_task SET message_count=GREATEST(message_count,$2),
  observation_pending=CASE WHEN status IN ('running','verifying') THEN true ELSE observation_pending END,updated_at=now() WHERE id=$1`,[taskId,n]);
 for(const [index,name] of ['extract_memory','index','verify'].entries())await c.query('INSERT INTO background_task_step(task_id,step_name,step_order,total_count) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[taskId,name,index+1,n]);
 return taskId;
}
export async function claimExtractionSchedule(c:pg.ClientBase,scope:ExtractionScope,runtimeConfig:CompleteClaimRuntimeConfig|null=null):Promise<string|null>{
 await lockExtractionScope(c,scope);
 const state=(await c.query('SELECT *,due_at<=now() AS due,last_input_at+interval \'600 seconds\' AS idle_at FROM memory_extraction_schedule WHERE owner_id=$1 AND contact_id=$2 FOR UPDATE',[scope.ownerId,scope.contactId])).rows[0];
 if(!state?.due)return null;
 const previous=(await c.query("SELECT id,status FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation'",[scope.ownerId,scope.contactId])).rows[0];
 if(previous?.status==='cancelled'&&state.task_id)return null;
 if(previous&&['queued','running','verifying'].includes(previous.status)){
  const pending=(await c.query('SELECT count(*)::int AS n FROM memory_processing_target WHERE task_id=$1 AND completed_at IS NULL',[previous.id])).rows[0].n;
  if(pending>=2000){await c.query('UPDATE memory_extraction_schedule SET due_at=now() WHERE owner_id=$1 AND contact_id=$2',[scope.ownerId,scope.contactId]);return null;}
 }
 const rows=(await c.query(`SELECT r.message_id,r.observation_id ${pendingSource} ORDER BY o.created_at,o.id,r.message_id LIMIT 2000`,[scope.ownerId,scope.contactId])).rows;
 if(!rows.length||rows.length<state.threshold&&state.idle_at>new Date()){
  const n=await count(c,scope);await c.query('UPDATE memory_extraction_schedule SET pending_count=$3,due_at=$4 WHERE owner_id=$1 AND contact_id=$2',[scope.ownerId,scope.contactId,n,n?state.idle_at:null]);return null;
 }
 const taskId=await observationTask(c,scope,rows.length,runtimeConfig),observations=[...new Set(rows.map(r=>r.observation_id))];
 const inserted=await c.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id',[taskId,scope.ownerId,scope.contactId]);
 const legacy=Boolean(inserted.rowCount&&previous&&!['succeeded','cancelled'].includes(previous.status));
 await c.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
  SELECT DISTINCT $3::uuid,m.id,m.owner_id,m.contact_id FROM message m JOIN message_source_ref ref ON ref.message_id=m.id AND ref.owner_id=m.owner_id AND ref.contact_id=m.contact_id
  JOIN local_wechat_observation o ON o.id=ref.observation_id AND o.owner_id=m.owner_id AND o.contact_id=m.contact_id
  JOIN conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
  WHERE m.owner_id=$1 AND m.contact_id=$2 AND b.status='active' AND m.speaker IN ('user','contact')
  AND length(btrim(COALESCE(NULLIF(m.text_content,''),m.media_placeholder,'')))>0
  AND (o.id=ANY($4::uuid[]) OR ($5 AND o.memory_enqueued_at IS NOT NULL AND m.occurred_at IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM memory_extraction_watermark w JOIN message boundary ON boundary.id=w.last_message_id AND boundary.owner_id=w.owner_id AND boundary.contact_id=w.contact_id
   WHERE w.owner_id=m.owner_id AND w.contact_id=m.contact_id AND (m.occurred_at,m.created_at,m.id)<=(boundary.occurred_at,boundary.created_at,boundary.id))))
  AND NOT EXISTS(SELECT 1 FROM memory_processing_receipt r WHERE r.message_id=m.id AND r.owner_id=m.owner_id AND r.contact_id=m.contact_id) ON CONFLICT DO NOTHING`,[scope.ownerId,scope.contactId,taskId,observations,legacy]);
 await c.query('UPDATE memory_extraction_receipt SET task_id=$3 WHERE owner_id=$1 AND contact_id=$2 AND task_id IS NULL AND observation_id=ANY($4::uuid[])',[scope.ownerId,scope.contactId,taskId,observations]);
 await c.query('UPDATE local_wechat_observation SET memory_enqueued_at=now() WHERE id=ANY($1::uuid[])',[observations]);
 const remaining=await count(c,scope);
 await c.query(`UPDATE memory_extraction_schedule SET pending_count=$3,due_at=CASE WHEN $3>0 THEN now() ELSE NULL END,
  threshold=LEAST(threshold*2,5),generation=generation+1,task_id=$4 WHERE owner_id=$1 AND contact_id=$2`,[scope.ownerId,scope.contactId,remaining,taskId]);
 return taskId;
}
export async function enqueueExtractionObservation(store:ExtractionTaskStore,scope:ExtractionScope,ids:readonly string[]):Promise<string|null>{
 return store.transaction(scope,async c=>{
  // 事件只是提示：只能消耗原提交事务已经登记的回执，不能补造授权或来源。
  const source=await c.query(`SELECT o.memory_enqueued_at FROM message_source_ref r JOIN local_wechat_observation o ON o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id
   JOIN conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
   WHERE r.owner_id=$1 AND r.contact_id=$2 AND r.message_id=ANY($3::uuid[]) AND b.status='active' LIMIT 1`,[scope.ownerId,scope.contactId,ids]);
  if(!source.rowCount)return null;
  const claimed=await claimExtractionSchedule(c,scope,await store.newTaskSnapshot());if(claimed)return claimed;
  if(!source.rows[0].memory_enqueued_at)return null;
  return (await c.query("SELECT id FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation' AND status IN ('queued','running','verifying')",[scope.ownerId,scope.contactId])).rows[0]?.id??null;
 });
}
