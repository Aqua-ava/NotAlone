import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySupportReport,HistoryTarget} from './contracts.ts';
import {assertSourceContinuity,type ResumedCheckpoint} from './continuity.ts';
import {historyCursorScopeDigest} from './cursor.ts';
import {historyTargetTransition} from '../partition-growth.ts';
import {serializeSupport} from './goal-reuse.ts';

/** 仅本轮真实恢复链可立即退役空节点；新持久恢复点和读者关闭均已成功后调用。 */
export function retireResumedEmptyGoals(tx:StorageTransaction,token:ReadEligibility,replacementGoalId:string,checkpoint:ResumedCheckpoint):number{
 const old=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND id=?',[token.owner_id,token.contact_id,checkpoint?.goalId]);
 const replacement=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND id=?',[token.owner_id,token.contact_id,replacementGoalId]);
 if(!old||!replacement||old.creation_no===null||replacement.creation_no===null||old.kind!=='incremental'||old.state!=='invalidated'||old.failure_code!=='history_snapshot_replaced'||!['ready','caught_up'].includes(String(old.coverage_state))
  ||old.cursor!==checkpoint.cursor||old.target_json!==JSON.stringify(checkpoint.target)||replacement.kind!=='history'
  ||typeof replacement.resume_cursor!=='string'||BigInt(String(replacement.creation_no))<=BigInt(String(old.creation_no)))return 0;
 let report:HistorySupportReport,target:HistoryTarget;
 try{report=JSON.parse(String(replacement.support_json));target=JSON.parse(String(replacement.target_json));}catch{return 0;}
 assertSourceContinuity(tx,token,target,report.accountKey);
 if(report.capabilities?.durableIncremental!=='supported'||!historyTargetTransition(checkpoint.target,target,false))return 0;
 for(const row of [old,replacement]){
  const expectedTarget=row===old?checkpoint.target:target;
  if(row.binding_id!==token.binding_id||row.grant_id!==token.grant_id||row.eligibility_json!==JSON.stringify(token)
   ||row.accepted_data_generation!==BigInt(token.data_generation)||row.accepted_barrier_generation!==BigInt(token.barrier_generation)
   ||row.support_json!==serializeSupport(report)||row.cursor_scope_digest!==historyCursorScopeDigest(token,report,expectedTarget))return 0;
 }
 if(replacement.cursor!==null){
  if(report.capabilities?.durableHistory!=='supported'||!['running','incomplete'].includes(String(replacement.state)))return 0;
 }else{
  try{const completed=JSON.parse(String(replacement.completed_partitions));if(!['complete','incomplete'].includes(String(replacement.state))||!Array.isArray(completed)||!target.partitions.every(partition=>completed.includes(partition)))return 0;}catch{return 0;}
 }
 const parent=typeof old.handoff_from_goal_id==='string'?tx.get('SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND id=?',[token.owner_id,token.contact_id,old.handoff_from_goal_id]):undefined;
 const remove=(id:string):number=>{
  const candidate=tx.get(`SELECT id FROM read_goal g WHERE owner_id=? AND contact_id=? AND id=?
   AND NOT EXISTS (SELECT 1 FROM sync_capture c WHERE c.owner_id=g.owner_id AND c.goal_id=g.id
    AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=c.owner_id AND r.capture_id=c.id))
   AND NOT EXISTS (SELECT 1 FROM history_restore r WHERE r.owner_id=g.owner_id AND r.contact_id=g.contact_id AND r.goal_id=g.id)
   AND NOT EXISTS (SELECT 1 FROM read_goal n WHERE n.owner_id=g.owner_id AND n.contact_id=g.contact_id AND n.handoff_from_goal_id=g.id)`,[token.owner_id,token.contact_id,id]);
  if(!candidate)return 0;
  tx.run('DELETE FROM sync_capture WHERE owner_id=? AND goal_id=?',[token.owner_id,id]);
  tx.run('DELETE FROM read_goal WHERE owner_id=? AND id=?',[token.owner_id,id]);return 1;
 };
 let removed=remove(String(old.id));
 // 未知或未完历史仍表达独立覆盖事实；不因空节点清理改写它。
 if(removed&&parent?.kind==='history'&&parent.state==='complete'&&parent.failure_code===null
  &&parent.eligibility_json===JSON.stringify(token)&&parent.target_json===old.target_json&&parent.support_json===old.support_json
  &&parent.cursor_scope_digest===old.cursor_scope_digest)removed+=remove(String(parent.id));
 return removed;
}

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
 * 没有被恢复操作引用，不是当前续读基线，也没有被保留集合内的后继目标（handoff）引用。其余一律保留。
 * 返回删除的目标数。
 */
export function purgeStaleGoals(tx:StorageTransaction,ownerId:string,contactId:string,now:number=Date.now()):number{
 const ids=staleGoalIds(tx,ownerId,contactId,now,goalRetentionBatch);
 deleteGoals(tx,ownerId,ids);
 return ids.length;
}

/** 迁移 40／41 的索引齐备才清理：旧版本库缺少相关表，且没有索引时会退化成全表扫描。 */
export function goalRetentionReady(tx:StorageTransaction):boolean{
 const ready=tx.get("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='index' AND name IN ('sync_capture_goal','capture_record_capture')");
 return Number(ready?.n)===2;
}

/** 按创建顺序返回至多 limit 个可清理的目标（只读）；规则同 purgeStaleGoals，供离线排空复用同一保留集合。 */
export function staleGoalIds(tx:StorageTransaction,ownerId:string,contactId:string,now:number,limit:number):string[]{
 if(!goalRetentionReady(tx))return [];
 if(!Number.isInteger(limit)||limit<1)return [];
 // 恢复基线：与 history.beginIncremental 的 resumable 同一判据的最新一行，续读依赖它，不得清理。
 const ids=tx.all(`WITH ranked AS MATERIALIZED (
   SELECT id,
    row_number() OVER (ORDER BY creation_no DESC,created_at DESC,id DESC) r_contact,
    row_number() OVER (PARTITION BY kind ORDER BY creation_no DESC,created_at DESC,id DESC) r_kind,
    row_number() OVER (PARTITION BY binding_id,grant_id,accepted_data_generation,accepted_barrier_generation ORDER BY creation_no DESC,created_at DESC,id DESC) r_scope
   FROM read_goal WHERE owner_id=? AND contact_id=? AND creation_no IS NOT NULL),
  -- 预先一次性求出受保护的交接来源集合（只扫该联系人的目标）；写成逐候选相关子查询时 handoff_from_goal_id 无索引，会退化为平方级。
  protected_handoff AS MATERIALIZED (
   SELECT n.handoff_from_goal_id id FROM read_goal n LEFT JOIN ranked kn ON kn.id=n.id
   WHERE n.owner_id=? AND n.contact_id=? AND n.handoff_from_goal_id IS NOT NULL
    AND (kn.id IS NULL OR kn.r_contact=1 OR kn.r_kind=1 OR kn.r_scope=1 OR n.state IN ('running','incomplete')
     OR n.created_at>=CASE WHEN n.kind='incremental' AND n.failure_code='history_snapshot_replaced' AND n.pages_accepted=0 THEN ? ELSE ? END
     OR EXISTS (SELECT 1 FROM sync_capture nc WHERE nc.owner_id=n.owner_id AND nc.goal_id=n.id
      AND EXISTS (SELECT 1 FROM capture_record nr WHERE nr.owner_id=nc.owner_id AND nr.capture_id=nc.id))))
  SELECT g.id FROM read_goal g JOIN ranked k ON k.id=g.id
  WHERE g.owner_id=? AND g.contact_id=? AND g.kind IN ('history','incremental') AND (
    (g.state='invalidated' AND g.created_at<CASE WHEN g.kind='incremental' AND g.failure_code='history_snapshot_replaced' AND g.pages_accepted=0 THEN ? ELSE ? END)
    -- 共用读取器轮转产生的无进展历史目标：开始后未结束的孤儿，或已被后继完成目标取代的空历史目标（含运行代次换代作废的）。
    OR (g.kind='history' AND g.cursor IS NULL AND g.created_at<? AND (g.state IN ('running','complete') OR (g.state='invalidated' AND g.failure_code='history_runtime_revalidated'))
     AND EXISTS (SELECT 1 FROM read_goal n WHERE n.owner_id=g.owner_id AND n.contact_id=g.contact_id AND n.kind='history'
      AND n.creation_no>g.creation_no AND n.state='complete' AND n.failure_code IS NULL AND n.cursor IS NULL AND n.resume_cursor IS NOT NULL
      AND n.cursor_scope_digest IS NOT NULL AND n.binding_id=g.binding_id AND n.grant_id=g.grant_id
      AND n.accepted_data_generation=g.accepted_data_generation AND n.accepted_barrier_generation=g.accepted_barrier_generation)))
   AND k.r_contact>1 AND k.r_kind>1 AND k.r_scope>1
   AND NOT EXISTS (SELECT 1 FROM sync_capture c WHERE c.owner_id=g.owner_id AND c.goal_id=g.id
    AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=c.owner_id AND r.capture_id=c.id))
   AND g.id NOT IN (SELECT goal_id FROM history_restore WHERE owner_id=? AND contact_id=? AND goal_id IS NOT NULL)
   AND g.id IS NOT (SELECT b.id FROM read_goal b WHERE b.owner_id=? AND b.contact_id=? AND b.creation_no IS NOT NULL AND b.cursor_scope_digest IS NOT NULL
    AND ((b.kind='incremental' AND b.cursor IS NOT NULL AND (b.failure_code IS NULL OR b.failure_code<>'history_snapshot_replaced')) OR (b.kind='history' AND b.resume_cursor IS NOT NULL AND b.state='complete'))
    ORDER BY b.creation_no DESC,b.created_at DESC,b.id DESC LIMIT 1)
   -- 交接来源只被“保留集合”内的目标引用才保护：保留集合＝最新一行（联系人／类型／范围）、仍有效、没有 creation_no 的旧版行、名下有记录的目标。
   -- 被另一个同样可清理的目标引用不构成保护，否则连续交接的增量目标会互相钉住，整条链永远无法清理。
   AND g.id NOT IN (SELECT id FROM protected_handoff)
  ORDER BY g.creation_no LIMIT ${limit}`,[ownerId,contactId,ownerId,contactId,BigInt(now-goalRetentionSupersededGraceMs),BigInt(now-goalRetentionGraceMs),ownerId,contactId,BigInt(now-goalRetentionSupersededGraceMs),BigInt(now-goalRetentionGraceMs),BigInt(now-goalRetentionSupersededGraceMs),ownerId,contactId,ownerId,contactId]);
 return ids.map(row=>row.id as string);
}

/** 删除目标及其（无记录的）抓取页；调用方已按 staleGoalIds 的条件选出。 */
export function deleteGoals(tx:StorageTransaction,ownerId:string,ids:readonly string[]):void{
 for(const id of ids){
  tx.run('DELETE FROM sync_capture WHERE owner_id=? AND goal_id=?',[ownerId,id]);
  tx.run('DELETE FROM read_goal WHERE owner_id=? AND id=?',[ownerId,id]);
 }
}
