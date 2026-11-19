import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {deleteGoals,goalRetentionReady,staleGoalIds} from './goal-retention.ts';

/** 离线排空每批最多删除的目标数；每批是一次独立事务。 */
export const goalCompactionBatch=200;
/** 试算一次最多模拟的批数，防止单个动作超出执行预算。 */
const dryRunBatchCap=500;

export type GoalCompactionSkip='owner_not_active'|'contact_not_active'|'deletion_in_progress'|'indexes_missing';
export interface GoalCompactionResult{
 contactId:string;skipped:GoalCompactionSkip|null;
 /** 本次实际删除（试算时为 0）。 */
 deleted:number;
 /** 试算：按每批上限逐批推演到没有可清理目标为止的总数与批数（推演在保存点内完成并回滚，不改任何行）。 */
 projectedTotal:number|null;projectedBatches:number|null;projectedTruncated:boolean;
}

/** 联系人或所有者正在删除（含账号删除、已计划未结案的删除操作与历史删除围栏）时不得压缩，避免与删除计划竞争。 */
export function goalCompactionSkip(tx:StorageTransaction,ownerId:string,contactId:string):GoalCompactionSkip|null{
 const owner=tx.get('SELECT state FROM owner WHERE owner_id=?',[ownerId]);
 if(owner?.state!=='active')return 'owner_not_active';
 const contact=tx.get('SELECT state FROM contact WHERE owner_id=? AND id=?',[ownerId,contactId]);
 if(contact?.state!=='active')return 'contact_not_active';
 if(tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=?',[ownerId,contactId]))return 'deletion_in_progress';
 // 联系人范围的删除与账号范围的删除（contact_identity 为空）只要尚未结案就跳过。
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND (contact_identity=? OR scope_kind='account') LIMIT 1",[ownerId,contactId]))return 'deletion_in_progress';
 if(!goalRetentionReady(tx))return 'indexes_missing';
 return null;
}

/**
 * 单联系人的一批排空：与创建新目标时的顺带清理共用同一保留集合（staleGoalIds），
 * 只删无记录、未被恢复操作引用、非最新／非续读基线／非保留集合引用的目标及其空抓取页；不改 schema。
 * dryRun 为真时只推演，不留下任何改动。
 */
export function compactGoals(tx:StorageTransaction,input:{ownerId:string;contactId:string;dryRun:boolean;limit:number;now?:number}):GoalCompactionResult{
 const {ownerId,contactId,dryRun,limit}=input,now=input.now??Date.now();
 if(typeof ownerId!=='string'||!ownerId||typeof contactId!=='string'||!contactId||typeof dryRun!=='boolean'||!Number.isInteger(limit)||limit<1||limit>goalCompactionBatch)throw new StorageFailure('history_compaction_invalid');
 const result:GoalCompactionResult={contactId,skipped:goalCompactionSkip(tx,ownerId,contactId),deleted:0,projectedTotal:null,projectedBatches:null,projectedTruncated:false};
 if(result.skipped)return result;
 if(!dryRun){
  const ids=staleGoalIds(tx,ownerId,contactId,now,limit);
  deleteGoals(tx,ownerId,ids);
  result.deleted=ids.length;return result;
 }
 // 试算：在保存点内逐批真实删除并计数，最后整体回滚，结果与逐批实际执行一致。
 tx.run('SAVEPOINT goal_compaction_dry_run');
 try{
  let total=0,batches=0;
  for(;batches<dryRunBatchCap;){
   const ids=staleGoalIds(tx,ownerId,contactId,now,limit);
   if(!ids.length)break;
   deleteGoals(tx,ownerId,ids);total+=ids.length;batches++;
  }
  result.projectedTotal=total;result.projectedBatches=batches;result.projectedTruncated=batches>=dryRunBatchCap;
 }finally{
  tx.run('ROLLBACK TO goal_compaction_dry_run');tx.run('RELEASE goal_compaction_dry_run');
 }
 return result;
}
