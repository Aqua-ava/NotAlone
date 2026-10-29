import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';

/**
 * 读取前的抑制边界。03 尚未认证精确历史截断，06 的 verified 边界也未提供，
 * 因此只要清空代次已推进或存在联系人级删除围栏，就保持拒绝放行；
 * 不因重启、重选或关闭再开启而清零旧排除。06 在同一位置接入已核验边界后替换本函数体，
 * 调用点不变。
 */
export function assertHistoryReadBoundary(tx: StorageTransaction, token: ReadEligibility, options: { kind: 'history' | 'incremental' }): void {
  void options;
  if (BigInt(token.barrier_generation) !== 0n) throw new StorageFailure('history_suppression_unverified');
  if (tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=?', [token.owner_id, token.contact_id])) throw new StorageFailure('history_suppression_unverified');
}
