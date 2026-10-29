import type { StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import { assertVerifiedHistoryBoundary } from './clear-actions.ts';

/**
 * 读取前的抑制边界（04 的固定调用点，四个 accept/begin 动作共用）。
 * 06 接入后语义：清空代次为 0 时沿用旧联系人级删除围栏拒绝；
 * 代次已推进时必须存在该会话该代次被原子接受的完整 B（verified），
 * 才允许新资格读取历史或增量。候选 pending/blocked 仍保持拒绝，不因重启/重选清零。
 */
export function assertHistoryReadBoundary(tx: StorageTransaction, token: ReadEligibility, options: { kind: 'history' | 'incremental' }): void {
  void options;
  assertVerifiedHistoryBoundary(tx, token);
}
