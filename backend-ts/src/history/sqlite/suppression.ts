import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';

/** 历史、增量、引用与来源恢复共用同一清空屏障，不按读取用途放宽。 */
export function assertHistoryReadBoundary(tx: StorageTransaction, token: ReadEligibility): void {
  const reject = (): never => { throw new StorageFailure('history_suppression_unverified'); };
  const barrier = BigInt(token.barrier_generation);
  if (barrier === 0n) {
    if (tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=?', [token.owner_id, token.contact_id])) reject();
    return;
  }
  // 升级夹具缺少清空结构时仍按未核验拒绝，不让底层 SQL 错误代替边界结果。
  if (!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", ['history_cutoff'])) reject();
  const cutoff = tx.get("SELECT source_generation FROM history_cutoff WHERE owner_id=? AND conversation_id=? AND barrier_generation=? AND state='verified'",
    [token.owner_id, token.conversation_id, barrier]);
  // 已接受的完整边界还须属于同一来源代次，避免旧成员键失配后复活已清空内容。
  if (!cutoff || cutoff.source_generation !== token.source_generation) reject();
}
