/**
 * P01 修改前 `workSql` 的冻结快照，仅供基准脚本在同一合成数据集上复现“修改前”的
 * 耗时与查询计划；产品运行与测试断言只使用 src 中实际装配的 SQL。
 *
 * 来源：backend-ts/src/media/sqlite/image-sync-actions.ts（提交 517f430ad 之后、P01 修改之前）。
 * 保留原样，包括逐行相关子查询；不要为适配新语义修改本文件。
 */
import {imageRefreshIntervalMs,imageReconcilePrefix,imageRetryDelaysMs,imagePreparationVersion} from '../../../src/media/sqlite/image-refresh.ts';

export const legacyUnclassifiedImageSql="f.image_quality='unknown' AND coalesce(CASE WHEN json_valid(f.image_quality_evidence) THEN json_extract(f.image_quality_evidence,'$.sourceVariant') END,'') NOT IN ('main','thumbnail')";
const retryDelaySql=alias=>`CASE ${imageRetryDelaysMs.slice(0,-1).map((delay,index)=>`WHEN ${alias}.retry_count=${index+1} THEN ${delay}`).join(' ')} ELSE ${imageRetryDelaysMs.at(-1)} END`;

export const legacyImageSyncWorkSql=`WITH attempts AS (
 SELECT owner_id,message_id,accepted_media_generation,
  max(requested_at) last_attempt_at,
  count(CASE WHEN adapter_version<>'${imagePreparationVersion}' AND (request_key GLOB 'image_sync_v5_*' OR request_key GLOB '${imageReconcilePrefix}*') THEN 1 END) retry_count,
  max(CASE WHEN adapter_version<>'${imagePreparationVersion}' AND (request_key GLOB 'image_sync_v5_*' OR request_key GLOB '${imageReconcilePrefix}*') THEN requested_at END) last_retry_at
 FROM media_extraction_attempt WHERE owner_id=? AND contact_id=? AND goal='extract'
 GROUP BY owner_id,message_id,accepted_media_generation
), preparation AS (
 -- 普通提取建立尝试时已通过来源核验；图片内容失败不继续阻塞同联系人的其余图片。
 SELECT p.owner_id,p.contact_id,count(*) retry_count,max(p.requested_at) last_retry_at FROM media_extraction_attempt p
 JOIN message_media h ON h.owner_id=p.owner_id AND h.message_id=p.message_id AND h.state='active' AND h.media_generation=p.accepted_media_generation
 WHERE p.owner_id=? AND p.contact_id=? AND p.adapter_version='${imagePreparationVersion}'
 AND p.rowid>coalesce((SELECT max(s.rowid) FROM media_extraction_attempt s WHERE s.owner_id=p.owner_id AND s.contact_id=p.contact_id AND s.adapter_version<>'${imagePreparationVersion}' AND s.goal IN ('extract','original_upgrade')),0)
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
 AND (h.state IS NULL OR h.state='active') AND (f.id IS NULL OR f.image_quality='thumbnail' OR (${legacyUnclassifiedImageSql}))
 AND EXISTS(SELECT 1 FROM capture_record r WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND r.state='normalized' AND r.availability='available')
 AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
 AND EXISTS(SELECT 1 FROM source_proof f WHERE f.owner_id=m.owner_id AND f.contact_id=m.contact_id AND f.state='ok')
 AND NOT EXISTS(SELECT 1 FROM media_extraction_attempt a WHERE a.owner_id=m.owner_id AND a.message_id=m.id AND a.state IN ('pending','running'))
) `;
