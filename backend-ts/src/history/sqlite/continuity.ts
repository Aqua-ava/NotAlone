import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryTarget } from './contracts.ts';

/** 排除记录只可在原来源代次和表实例内比较；无法比较时保留持久停读。 */
export function sourceExclusionsMatch(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget): boolean {
  const rows = tx.all(`SELECT external_key FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? AND scheme='local'
    UNION ALL SELECT m.external_key FROM history_cutoff_member m JOIN history_cutoff c ON c.owner_id=m.owner_id AND c.conversation_id=m.conversation_id AND c.barrier_generation=m.barrier_generation
    WHERE m.owner_id=? AND m.conversation_id=? AND c.state='verified'`, [token.owner_id, token.conversation_id, token.owner_id, token.conversation_id]);
  for (const row of rows) {
    let key: unknown;
    try { key = JSON.parse(String(row.external_key)); } catch { return false; }
    if (!Array.isArray(key) || key.length !== 4 || key.some(value => typeof value !== 'string')
      || key[0] !== target.sourceGeneration || !target.tables.some(table => table.partition === key[1] && table.instance === key[2])) return false;
  }
  return true;
}

export function assertSourceContinuity(tx: StorageTransaction, token: ReadEligibility, target: HistoryTarget): void {
  if (tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?', [token.owner_id, token.contact_id])
    || !sourceExclusionsMatch(tx, token, target)) throw new StorageFailure('history_source_continuity_unverified');
}
