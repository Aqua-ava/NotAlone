import type {StorageAction,StorageRow} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {imageRefreshIntervalMs,imageRefreshRequestKey,imageReconcileRequestKey,imageReconcilePrefix,imageRetryDelaysMs,imagePreparationVersion} from './image-refresh.ts';

/** 缺少角色依据才补查；原图资格 unknown 且已知 main 的图片不重复读取。 */
export const unclassifiedImageSql="f.image_quality='unknown' AND coalesce(CASE WHEN json_valid(f.image_quality_evidence) THEN json_extract(f.image_quality_evidence,'$.sourceVariant') END,'') NOT IN ('main','thumbnail')";
const retryDelaySql=(alias:string)=>`CASE ${imageRetryDelaysMs.slice(0,-1).map((delay,index)=>`WHEN ${alias}.retry_count=${index+1} THEN ${delay}`).join(' ')} ELSE ${imageRetryDelaysMs.at(-1)} END`;
// 只枚举待办消息身份；旧运行时守卫由媒体服务先合法重验，实际读取与发布仍逐条核验来源。
// legacy cutoff 只需按联系人计算一次；相关子查询会被 SQLite 按 preparation 的每一行重算，
// 因此提升为一次性 CTE。导出仅用于回归测试与基准脚本读取实际查询计划，不参与产品装配。
export const imageSyncWorkSql=`WITH legacy AS (
 SELECT coalesce(max(s.rowid),0) cutoff FROM media_extraction_attempt s
 WHERE s.owner_id=? AND s.contact_id=? AND s.adapter_version<>'${imagePreparationVersion}' AND s.goal IN ('extract','original_upgrade')
), attempts AS (
 SELECT owner_id,message_id,accepted_media_generation,
  max(requested_at) last_attempt_at,
  count(CASE WHEN adapter_version<>'${imagePreparationVersion}' AND (request_key GLOB 'image_sync_v5_*' OR request_key GLOB '${imageReconcilePrefix}*') THEN 1 END) retry_count,
  max(CASE WHEN adapter_version<>'${imagePreparationVersion}' AND (request_key GLOB 'image_sync_v5_*' OR request_key GLOB '${imageReconcilePrefix}*') THEN requested_at END) last_retry_at
 FROM media_extraction_attempt WHERE owner_id=? AND contact_id=? AND goal='extract'
 GROUP BY owner_id,message_id,accepted_media_generation
), preparation AS (
 -- 普通提取建立尝试时已通过来源核验；图片内容失败不继续阻塞同联系人的其余图片。
 SELECT p.owner_id,p.contact_id,count(*) retry_count,max(p.requested_at) last_retry_at FROM media_extraction_attempt p
 CROSS JOIN legacy l
 JOIN message_media h ON h.owner_id=p.owner_id AND h.message_id=p.message_id AND h.state='active' AND h.media_generation=p.accepted_media_generation
 WHERE p.owner_id=? AND p.contact_id=? AND p.adapter_version='${imagePreparationVersion}'
 AND p.rowid>l.cutoff
 GROUP BY p.owner_id,p.contact_id
), work AS (
 SELECT m.id,m.display_no,coalesce(h.media_generation,0) media_generation,f.id file_id,f.image_quality,
  coalesce(a.retry_count,0) retry_count,a.last_attempt_at,
  max(CASE WHEN f.image_quality='thumbnail' THEN coalesce((a.last_attempt_at/${imageRefreshIntervalMs}+1)*${imageRefreshIntervalMs},0)
   WHEN coalesce(a.retry_count,0)=0 THEN 0 ELSE a.last_retry_at+${retryDelaySql('a')} END,
   coalesce(p.last_retry_at+${retryDelaySql('p')},0)) next_due
 FROM message m JOIN contact c ON c.owner_id=m.owner_id AND c.id=m.contact_id AND c.state='active'
 JOIN owner o ON o.owner_id=m.owner_id AND o.state='active'
 LEFT JOIN message_media h ON h.owner_id=m.owner_id AND h.message_id=m.id
 LEFT JOIN media_file f ON f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.message_id=m.id
  AND f.role='image_display' AND f.publish_state='current' AND f.content_state='present' AND f.container_valid=1 AND f.viewable=1
 LEFT JOIN attempts a ON a.owner_id=m.owner_id AND a.message_id=m.id AND a.accepted_media_generation=coalesce(h.media_generation,0)
 LEFT JOIN preparation p ON p.owner_id=m.owner_id AND p.contact_id=m.contact_id
 WHERE m.owner_id=? AND m.contact_id=? AND m.kind='image' AND m.availability='available'
 AND EXISTS(SELECT 1 FROM read_grant g JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
  WHERE g.owner_id=m.owner_id AND g.contact_id=m.contact_id AND g.binding_id=m.binding_id AND g.revoked_at IS NULL AND g.selection_generation=c.selection_generation AND b.state='verified')
 AND (h.state IS NULL OR h.state='active') AND (f.id IS NULL OR f.image_quality='thumbnail' OR (${unclassifiedImageSql}))
 AND EXISTS(SELECT 1 FROM capture_record r WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND r.state='normalized' AND r.availability='available')
 AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
 AND NOT EXISTS(SELECT 1 FROM history_continuity_fence f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id)
 AND NOT EXISTS(SELECT 1 FROM media_extraction_attempt a WHERE a.owner_id=m.owner_id AND a.message_id=m.id AND a.state IN ('pending','running'))
) `;
/** 参数顺序必须与 imageSyncWorkSql 的占位符顺序一致：legacy→attempts→preparation→work。 */
function scope(input:any):string[]{
 if(![input.ownerId,input.contactId].every(value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)))throw new StorageFailure('media_request_invalid');
 return [input.ownerId,input.contactId,input.ownerId,input.contactId,input.ownerId,input.contactId,input.ownerId,input.contactId];
}
export function createImageSyncActions():StorageAction[]{return [
 {name:'media.imageSyncTargets',mode:'read',retryBusy:false,execute:(tx,input:any)=>{
  const parameters=scope(input),now=input.now??Date.now();
  if(typeof input.after!=='string'||!/^\d{1,20}$/.test(input.after)||!Number.isSafeInteger(now)||now<0)throw new StorageFailure('media_request_invalid');
  const rows=tx.all(imageSyncWorkSql+'SELECT * FROM work WHERE display_no>? AND next_due<=? ORDER BY display_no LIMIT 64',[...parameters,BigInt(input.after),BigInt(now)]);
  return rows.map((row:StorageRow)=>({messageId:String(row.id),displayNo:String(row.display_no),requestKey:row.image_quality==='thumbnail'
   ?imageRefreshRequestKey(String(row.id),String(row.media_generation),now)
   :row.file_id===null&&row.last_attempt_at===null?`image_sync_v5_${row.id}_${row.media_generation}`
   :imageReconcileRequestKey(String(row.id),String(row.media_generation),now)}));
 }},
 {name:'media.imageRefreshPending',mode:'read',retryBusy:false,execute:(tx,input:any)=>!!tx.get(imageSyncWorkSql+'SELECT 1 FROM work LIMIT 1',scope(input))},
 ];}
