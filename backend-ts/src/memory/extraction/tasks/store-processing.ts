/** 迁移原090/091处理计划；只返回有界文字消息身份，不读取模型输入。 */
import type pg from 'pg';
import {ExtractionTaskError,processingSourceAllowed,type ExtractionClaim,type ExtractionScope,type ExtractionTaskStore} from './store.ts';
export interface ExtractionTargets {targetIds:string[];contextIds:string[];leaseGeneration:number;}
function validMessage(taskType:string):string {
 return `EXISTS(SELECT 1 FROM message_source_ref r WHERE r.message_id=m.id AND r.owner_id=m.owner_id AND r.contact_id=m.contact_id
  AND ${taskType==='import'?`r.source_document_id=$3 AND EXISTS(SELECT 1 FROM source_document d WHERE d.id=r.source_document_id AND d.owner_id=r.owner_id AND d.contact_id=r.contact_id AND d.status='active')`:
  `EXISTS(SELECT 1 FROM local_wechat_observation o JOIN conversation_binding b ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
   WHERE o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id AND o.memory_enqueued_at IS NOT NULL AND b.status='active')`})`;
}
export async function extractionTargets(store:ExtractionTaskStore,claim:ExtractionClaim):Promise<ExtractionTargets>{
 return store.fenced(claim,async c=>{
  const active=(await c.query(`SELECT control.active_round_id,
    EXISTS(
      SELECT 1 FROM public.memory_processing_round_task membership
      WHERE membership.round_id=control.active_round_id
        AND membership.task_id=$3 AND membership.owner_id=$1
        AND membership.contact_id IS NOT DISTINCT FROM $2::uuid
        AND membership.active
    ) AS member,
    EXISTS(
      SELECT 1 FROM public.memory_processing_round_target snapshot
      JOIN public.memory_processing_round_task membership
        ON membership.round_id=snapshot.round_id AND membership.task_id=snapshot.task_id
      WHERE snapshot.round_id=control.active_round_id
        AND membership.task_id=$3 AND membership.owner_id=$1
        AND membership.contact_id IS NOT DISTINCT FROM $2::uuid
        AND membership.active
    ) AS frozen
   FROM public.memory_processing_scope control
   WHERE control.owner_id=$1 AND control.contact_id IS NOT DISTINCT FROM $2::uuid`,
  [claim.ownerId,claim.contactId,claim.taskId])).rows[0];
  if(active?.active_round_id&&!active.member)
   return {targetIds:[],contextIds:[],leaseGeneration:claim.leaseGeneration};
  const inserted=await c.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id',[claim.taskId,claim.ownerId,claim.contactId]);
  const params=claim.taskType==='import'?[claim.ownerId,claim.contactId,claim.sourceDocumentId]:[claim.ownerId,claim.contactId];
  const validity=validMessage(claim.taskType);
  const text=`m.speaker IN ('user','contact') AND length(btrim(COALESCE(NULLIF(m.text_content,''),m.media_placeholder,'')))>0`;
  const frozenRoundParameter=`$${params.length+2}`;
  const frozenTarget=active?.frozen
   ?`AND EXISTS(SELECT 1 FROM public.memory_processing_round_target snapshot
     WHERE snapshot.round_id=${frozenRoundParameter} AND snapshot.task_id=x.task_id
       AND snapshot.message_id=x.message_id)`
   :'';
  if(inserted.rowCount){
   // 观察的正常新批在入队时登记目标；仅旧计划首次恢复沿用原水位。
   const boundary=claim.taskType==='observation'?`AND NOT EXISTS(SELECT 1 FROM memory_extraction_watermark w JOIN message boundary
    ON boundary.id=w.last_message_id AND boundary.owner_id=w.owner_id AND boundary.contact_id=w.contact_id
    WHERE w.owner_id=m.owner_id AND w.contact_id=m.contact_id
    AND (m.occurred_at,m.created_at,m.id)<=(boundary.occurred_at,boundary.created_at,boundary.id))`:'';
   await c.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
    SELECT $${params.length+1},m.id,m.owner_id,m.contact_id FROM message m WHERE m.owner_id=$1 AND m.contact_id=$2
    AND (m.occurred_at IS NOT NULL OR EXISTS(SELECT 1 FROM memory_processing_target old WHERE old.task_id=$${params.length+1} AND old.message_id=m.id))
    AND ${text} AND ${validity} ${boundary}
    AND NOT EXISTS(SELECT 1 FROM memory_processing_receipt done WHERE done.message_id=m.id AND done.owner_id=m.owner_id AND done.contact_id=m.contact_id)
    ON CONFLICT DO NOTHING`,[...params,claim.taskId]);
  }
  await c.query(`UPDATE memory_processing_target x SET completed_at=r.completed_at,outcome=r.outcome
   FROM memory_processing_receipt r WHERE x.task_id=$1 AND x.message_id=r.message_id AND x.owner_id=r.owner_id
   AND x.contact_id=r.contact_id AND x.completed_at IS NULL`,[claim.taskId]);
  const targetRows=(await c.query(`SELECT m.id,m.occurred_at,m.created_at FROM memory_processing_target x JOIN message m
   ON m.id=x.message_id AND m.owner_id=x.owner_id AND m.contact_id=x.contact_id
   WHERE m.owner_id=$1 AND m.contact_id=$2 AND x.task_id=$${params.length+1} AND x.completed_at IS NULL AND ${validity}
   ${frozenTarget}
   ORDER BY m.occurred_at NULLS LAST,m.created_at,m.id LIMIT 200`,
  [...params,claim.taskId,...(active?.frozen?[active.active_round_id]:[])])).rows;
  const targetIds=targetRows.map(r=>r.id);let contextIds=targetIds;
  const first=targetRows[0],last=targetRows.at(-1);
  if(first?.occurred_at&&last?.occurred_at){
   const n=params.length;
   const lo=`($${n+1}::timestamptz,$${n+2}::timestamptz,$${n+3}::uuid)`,hi=`($${n+4}::timestamptz,$${n+5}::timestamptz,$${n+6}::uuid)`;
   const base=`SELECT m.id FROM message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND ${text} AND ${validity}`;
   const start=[first.occurred_at,first.created_at,first.id],end=[last.occurred_at,last.created_at,last.id];
   const span=(await c.query(`${base} AND (m.occurred_at,m.created_at,m.id)>=${lo} AND (m.occurred_at,m.created_at,m.id)<=${hi} ORDER BY m.occurred_at,m.created_at,m.id LIMIT 601`,[...params,...start,...end])).rows;
   if(span.length<=600){
    const before=(await c.query(`${base} AND (m.occurred_at,m.created_at,m.id)<${lo} ORDER BY m.occurred_at DESC,m.created_at DESC,m.id DESC LIMIT 20`,[...params,...start])).rows;
    const after=(await c.query(`${base} AND (m.occurred_at,m.created_at,m.id)>${lo} ORDER BY m.occurred_at,m.created_at,m.id LIMIT 20`,[...params,...end])).rows;
    contextIds=[...new Set([...before.reverse(),...span,...after].map(r=>r.id))];
   }
  }
  return {targetIds,contextIds,leaseGeneration:claim.leaseGeneration};
 });
}
export async function extractionCheckpoint(store:ExtractionTaskStore,c:pg.ClientBase,claim:ExtractionClaim,ids:readonly string[],outcome:'succeeded'|'skipped'|'unknown'):Promise<void>{
 await store.assertLease(c,claim);
 await c.query(`INSERT INTO memory_processing_receipt(message_id,owner_id,contact_id,outcome)
  SELECT m.id,m.owner_id,m.contact_id,$5 FROM memory_processing_target x JOIN message m
  ON m.id=x.message_id AND m.owner_id=x.owner_id AND m.contact_id=x.contact_id
  WHERE x.task_id=$1 AND m.owner_id=$2 AND m.contact_id=$3 AND m.id=ANY($4::uuid[]) ON CONFLICT DO NOTHING`,[claim.taskId,claim.ownerId,claim.contactId,ids,outcome]);
 await c.query(`UPDATE memory_processing_target x SET completed_at=r.completed_at,outcome=r.outcome FROM memory_processing_receipt r
  WHERE x.task_id=$1 AND x.owner_id=$2 AND x.contact_id=$3 AND x.message_id=ANY($4::uuid[])
  AND x.message_id=r.message_id AND x.owner_id=r.owner_id AND x.contact_id=r.contact_id AND x.completed_at IS NULL`,[claim.taskId,claim.ownerId,claim.contactId,ids]);
 await c.query('UPDATE memory_processing_plan SET updated_at=now() WHERE task_id=$1',[claim.taskId]);
}
async function extractionProgressFor(store:ExtractionTaskStore,ownerId:string,contactId:string|null,taskId?:string){
 const c=await store.pool.connect();try{
  await c.query('BEGIN READ ONLY');
  if(contactId!==null&&!(await c.query('SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2',[ownerId,contactId])).rowCount)throw new ExtractionTaskError('contact_not_found');
  if(contactId===null&&!(await c.query('SELECT 1 FROM owner WHERE id=$1',[ownerId])).rowCount)throw new ExtractionTaskError('owner_not_found');
  const rows=(await c.query(`SELECT t.*,p.task_id AS planned,p.updated_at AS progress_at,${processingSourceAllowed} AS source_allowed,
   (SELECT count(*)::int FROM memory_processing_target x WHERE x.task_id=t.id) AS total,
   (SELECT count(*)::int FROM memory_processing_target x WHERE x.task_id=t.id AND x.completed_at IS NOT NULL) AS processed,
   (SELECT count(*)::int FROM memory_processing_target x WHERE x.task_id=t.id AND x.outcome='skipped') AS skipped,
   (SELECT count(*)::int FROM memory_processing_target x WHERE x.task_id=t.id AND x.outcome='unknown') AS unknown,
   EXISTS(SELECT 1 FROM background_task_step s WHERE s.task_id=t.id AND s.status='running' AND s.lease_expires_at>clock_timestamp()) AS live
   FROM background_task t LEFT JOIN memory_processing_plan p ON p.task_id=t.id WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.contact_id=$2)
   AND ($3::uuid IS NULL OR t.id=$3) AND t.task_type IN ('import','observation')
   ORDER BY CASE WHEN t.status IN ('queued','running','verifying') THEN 0 ELSE 1 END,t.updated_at DESC,t.id LIMIT 101`,[ownerId,contactId,taskId??null])).rows;
  const pending=(await c.query(`SELECT count(*)::int AS n FROM memory_extraction_receipt r JOIN local_wechat_observation o
   ON o.id=r.observation_id AND o.owner_id=r.owner_id AND o.contact_id=r.contact_id JOIN conversation_binding b
   ON b.id=o.binding_id AND b.owner_id=o.owner_id AND b.contact_id=o.contact_id
   WHERE r.owner_id=$1 AND ($2::uuid IS NULL OR r.contact_id=$2) AND r.task_id IS NULL AND b.status='active'
   AND EXISTS(SELECT 1 FROM message_source_ref ref WHERE ref.message_id=r.message_id AND ref.observation_id=o.id)`,[ownerId,contactId])).rows[0].n;
  await c.query('COMMIT');
  return {scope:contactId===null?'owner':'contact',contact_id:contactId,pending_count:pending,has_more:rows.length>100,tasks:rows.slice(0,100).map(row=>{
   const scheduled=store.options.processingState?.({ownerId,contactId:row.contact_id},row.id);
   let status='interrupted',reason=row.last_error_code??'execution_interrupted',action:string|null='resume';
   if(row.status==='succeeded'){status='completed';action=null;reason=row.skipped?'batches_skipped':row.unknown?'processing_outcome_unknown':row.last_error_code;}
   else if(row.status==='cancelled'){status='stopped';action='restart';reason=row.last_error_code??'task_cancelled';}
   else if(row.status==='failed'){status='failed';reason=row.last_error_code;}
   else if(row.live||scheduled==='active'){status='extracting';reason=row.last_error_code;action=null;}
   else if(scheduled==='queued'){status='queued';reason=row.last_error_code;action=null;}
   if(!row.source_allowed){reason='source_unavailable';action=null;}
   return {task_id:row.id,contact_id:row.contact_id,task_type:row.task_type,status,phase:row.current_step,
    processed_count:row.planned?row.processed:null,total_count:row.planned?row.total:null,created_count:null,updated_count:null,
    updated_at:(row.progress_at??row.updated_at).toISOString(),reason_code:reason,action};
  })};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function extractionProgress(store:ExtractionTaskStore,scope:ExtractionScope,taskId?:string){
 return extractionProgressFor(store,scope.ownerId,scope.contactId,taskId);
}
/** owner 页面与联系人页面共享同一任务行；只按 owner 放宽查询，不重建任务或统计。 */
export async function ownerExtractionProgress(store:ExtractionTaskStore,ownerId:string,taskId?:string){
 return extractionProgressFor(store,ownerId,null,taskId);
}
