import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';

/** 每次最多清理的目标数：在已有写事务内有界执行，不阻塞同步。 */
export const goalRetentionBatch=50;
/** 作废后至少保留一天，便于排查，也避开仍在收尾的操作。 */
export const goalRetentionGraceMs=86_400_000;
/** 被新快照取代、没有任何进展的目标没有排查价值，宽限期缩短；共用读取器轮转时每轮都会产生这类目标。 */
export const goalRetentionSupersededGraceMs=3_600_000;

// 嵌套 EXISTS 固定“先按目标找抓取页再找记录”的顺序：写成 JOIN 时优化器会先扫描全部 capture_record，真实库副本上单批慢到 29 秒。
/**
 * 在创建新读取目标的事务里，顺带清理同一联系人已无用的旧目标及其空抓取页。
 * 只清理同时满足下列条件的目标：已作废、有顺序号、不是该联系人最新的一个，
 * 也不是同类型或同来源／授权／代次范围内最新的一个；名下没有任何 capture_record；
 * 没有被重新认证、恢复操作或后继目标（handoff）引用。其余一律保留。
 * 返回删除的目标数。
 */
export function purgeStaleGoals(tx:StorageTransaction,ownerId:string,contactId:string,now:number=Date.now()):number{
 // 迁移 40／41 的索引齐备才清理：旧版本库缺少相关表，且没有索引时会退化成全表扫描。
 const ready=tx.get("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='index' AND name IN ('sync_capture_goal','capture_record_capture')");
 if(Number(ready?.n)!==2)return 0;
 const ids=tx.all(`SELECT g.id FROM read_goal g JOIN (
   SELECT id,
    row_number() OVER (ORDER BY creation_no DESC,created_at DESC,id DESC) r_contact,
    row_number() OVER (PARTITION BY kind ORDER BY creation_no DESC,created_at DESC,id DESC) r_kind,
    row_number() OVER (PARTITION BY binding_id,grant_id,accepted_data_generation,accepted_barrier_generation ORDER BY creation_no DESC,created_at DESC,id DESC) r_scope
   FROM read_goal WHERE owner_id=? AND contact_id=? AND creation_no IS NOT NULL) k ON k.id=g.id
  WHERE g.owner_id=? AND g.contact_id=? AND g.kind IN ('history','incremental') AND (
    (g.state='invalidated' AND g.created_at<CASE WHEN g.kind='incremental' AND g.failure_code='history_snapshot_replaced' AND g.pages_accepted=0 THEN ? ELSE ? END)
    -- 共用读取器轮转产生的无进展历史目标：开始后未结束的孤儿，或已被后继完成目标取代的空历史目标（含运行代次换代时作废的）。
    OR (g.kind='history' AND g.cursor IS NULL AND g.created_at<? AND (g.state IN ('running','complete') OR (g.state='invalidated' AND g.failure_code='history_runtime_revalidated'))
     AND EXISTS (SELECT 1 FROM read_goal n WHERE n.owner_id=g.owner_id AND n.contact_id=g.contact_id AND n.kind='history'
      AND n.creation_no>g.creation_no AND n.state='complete' AND n.failure_code IS NULL AND n.cursor IS NULL AND n.resume_cursor IS NOT NULL
      AND n.cursor_scope_digest IS NOT NULL AND n.binding_id=g.binding_id AND n.grant_id=g.grant_id
      AND n.accepted_data_generation=g.accepted_data_generation AND n.accepted_barrier_generation=g.accepted_barrier_generation)))
   AND k.r_contact>1 AND k.r_kind>1 AND k.r_scope>1
   AND NOT EXISTS (SELECT 1 FROM sync_capture c WHERE c.owner_id=g.owner_id AND c.goal_id=g.id
    AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=c.owner_id AND r.capture_id=c.id))
   AND g.id NOT IN (SELECT goal_id FROM history_source_recertification WHERE owner_id=? AND contact_id=? AND goal_id IS NOT NULL)
   AND g.id NOT IN (SELECT goal_id FROM history_restore WHERE owner_id=? AND contact_id=? AND goal_id IS NOT NULL)
   AND g.id NOT IN (SELECT handoff_from_goal_id FROM read_goal WHERE owner_id=? AND contact_id=? AND handoff_from_goal_id IS NOT NULL)
  ORDER BY g.creation_no LIMIT ${goalRetentionBatch}`,[ownerId,contactId,ownerId,contactId,BigInt(now-goalRetentionSupersededGraceMs),BigInt(now-goalRetentionGraceMs),BigInt(now-goalRetentionSupersededGraceMs),ownerId,contactId,ownerId,contactId,ownerId,contactId]);
 for(const row of ids){
  tx.run('DELETE FROM sync_capture WHERE owner_id=? AND goal_id=?',[ownerId,row.id as string]);
  tx.run('DELETE FROM read_goal WHERE owner_id=? AND id=?',[ownerId,row.id as string]);
 }
 return ids.length;
}
