import type {StorageAction,StorageRow} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {imageReconcileRequestKey,imageReconcilePrefix,imageRetryDelaysMs,imagePreparationVersion} from './image-refresh.ts';

const retryDelaySql=(alias:string)=>`CASE ${imageRetryDelaysMs.slice(0,-1).map((delay,index)=>`WHEN ${alias}.retry_count=${index+1} THEN ${delay}`).join(' ')} ELSE ${imageRetryDelaysMs.at(-1)} END`;
// 只枚举待办消息身份；旧运行时守卫由媒体服务先合法重验，实际读取与发布仍逐条核验来源。
// legacy cutoff 只需按联系人计算一次；相关子查询会被 SQLite 按 preparation 的每一行重算，
// 因此提升为一次性 CTE。导出仅用于回归测试与基准脚本读取实际查询计划，不参与产品装配。
export const imageSyncWorkSql=`WITH legacy AS (
 SELECT coalesce(max(s.rowid),0) cutoff FROM media_extraction_attempt s
 WHERE s.owner_id=? AND s.contact_id=? AND s.adapter_version<>'${imagePreparationVersion}' AND s.goal='extract'
), attempts AS (
 -- 只数已得出结果（完成或失败）的自动尝试；被中断或撤销的不算，仍属“尚未试过”。
 SELECT owner_id,message_id,accepted_media_generation,
  max(requested_at) last_attempt_at,
  count(CASE WHEN adapter_version<>'${imagePreparationVersion}' AND state IN ('completed','failed') AND (request_key GLOB 'image_sync_v5_*' OR request_key GLOB '${imageReconcilePrefix}*') THEN 1 END) retry_count
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
 SELECT m.id,m.display_no,coalesce(h.media_generation,0) media_generation,
  coalesce(a.retry_count,0) retry_count,a.last_attempt_at,
  coalesce(p.last_retry_at+${retryDelaySql('p')},0) prep_due,
  -- 定时自动尝试只做首次：已有结果的图片不再按时间排队，之后只在用户打开聊天看到它时再试（见 media.imageViewTargets）。
  -- 首次尝试仅受联系人级准备失败的退避限制。
  CASE WHEN coalesce(a.retry_count,0)=0 THEN coalesce(p.last_retry_at+${retryDelaySql('p')},0) ELSE 9223372036854775807 END next_due
 FROM message m JOIN contact c ON c.owner_id=m.owner_id AND c.id=m.contact_id AND c.state='active'
 JOIN owner o ON o.owner_id=m.owner_id AND o.state='active'
 LEFT JOIN message_media h ON h.owner_id=m.owner_id AND h.message_id=m.id
 LEFT JOIN attempts a ON a.owner_id=m.owner_id AND a.message_id=m.id AND a.accepted_media_generation=coalesce(h.media_generation,0)
 LEFT JOIN preparation p ON p.owner_id=m.owner_id AND p.contact_id=m.contact_id
 WHERE m.owner_id=? AND m.contact_id=? AND m.kind='image' AND m.availability='available'
 AND EXISTS(SELECT 1 FROM read_grant g JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
  WHERE g.owner_id=m.owner_id AND g.contact_id=m.contact_id AND g.binding_id=m.binding_id AND g.revoked_at IS NULL AND g.selection_generation=c.selection_generation AND b.state='verified')
 AND (h.state IS NULL OR h.state='active')
 AND NOT EXISTS(SELECT 1 FROM media_file f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.message_id=m.id
  AND f.role='image_display' AND f.publish_state='current' AND f.content_state='present' AND f.container_valid=1 AND f.viewable=1)
 AND EXISTS(SELECT 1 FROM capture_record r WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND r.state='normalized' AND r.availability='available')
 AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
 AND EXISTS(SELECT 1 FROM source_proof f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.state='ok')
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
  return rows.map((row:StorageRow)=>({messageId:String(row.id),displayNo:String(row.display_no),requestKey:row.last_attempt_at===null
   ?`image_sync_v5_${row.id}_${row.media_generation}`
   :imageReconcileRequestKey(String(row.id),String(row.media_generation),now)}));
 }},
 // 还有尚未试过、只是被准备退避挡住的图片时，才需要定时再醒。已有结果的图片不再排队。
 {name:'media.imageRefreshPending',mode:'read',retryBusy:false,execute:(tx,input:any)=>!!tx.get(imageSyncWorkSql+'SELECT 1 FROM work WHERE retry_count=0 LIMIT 1',scope(input))},
 // 用户打开聊天、看到这些尚未保存的图片时，各再试一次；资格与来源核验沿用同一份待办定义。
 {name:'media.imageViewTargets',mode:'read',retryBusy:false,execute:(tx,input:any)=>{
  const parameters=scope(input),now=input.now??Date.now();
  if(!Array.isArray(input.messageIds)||input.messageIds.length<1||input.messageIds.length>100
   ||input.messageIds.some((id:unknown)=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))||!Number.isSafeInteger(now)||now<0)throw new StorageFailure('media_request_invalid');
  const rows=tx.all(imageSyncWorkSql+'SELECT * FROM work WHERE id IN (SELECT value FROM json_each(?)) ORDER BY display_no LIMIT 100',[...parameters,JSON.stringify(input.messageIds)]);
  return rows.map((row:StorageRow)=>({messageId:String(row.id),displayNo:String(row.display_no),requestKey:imageReconcileRequestKey(String(row.id),String(row.media_generation),now)}));
 }},
 ];}
