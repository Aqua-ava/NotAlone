import type { StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistorySupportReport, HistoryTarget } from './contracts.ts';
import { historyCursorScopeDigest } from './cursor.ts';

/** 支持档的同一序历化字符串；行内 support_json 以此格式保存，比较前必须经同一规范化。 */
export const serializeSupport = (report: HistorySupportReport): string =>
  JSON.stringify(Object.fromEntries(Object.entries(report).sort(([a], [b]) => a.localeCompare(b))));

/** 可续用的既有空目标：后续读取按该行的 target/cursor 继续，不重发 INSERT。 */
export interface ReusableEmptyGoal { kind: 'history' | 'incremental'; id: string; target: HistoryTarget; cursor: string | null }

/**
 * 同一联系人的 0 页单空目标复用判据（任务 01 阶段 B 批准范围）。全部成立才返回该行：
 * - binding_id、grant_id、accepted_data_generation、accepted_barrier_generation 与当前许可完全一致；
 * - pages_accepted=0 且名下没有任何 capture_record（含经 sync_capture 的抓取记录）；
 * - 行内 cursor_scope_digest 与用当前许可/支持档/新目标重算的 cursor_scope_digest（cursor.ts）完全一致——
 *   该摘要覆盖 descriptor/协议/source_generation/分区集合/表实例等固定目标身份与完整支持档证据，
 *   因此原生读取器的固定目标可证明未被替换；任一身份变化都会失配；
 * - 行内 support_json 与当前支持档序历化后一致、eligibility_json 与当前资格序列化后一致
 *   （history.pending/history.acceptPage 等后续动作都按这两项校验， reclaimed 行必须先满足它们）；
 * - 行内 target_json 与本次新目标 JSON 一致（比摘要更强的结构同等判定，防止摘要未覆盖字段的漂移）；
 * - incremental 行必须有 cursor（history.incrementalPending 的继续前提）；history 行不得是
 *   cursor 为 null 的 incomplete 终页剩余（history.pending 已到终页的固定快照不能反复接收完整扫描）。
 * 任一条件不成立该行不可续用，调用方保持原有"新建/作废"行为；已 invalidated 的行不会被本函数返回。
 */
export function reusableEmptyGoals(tx: StorageTransaction, token: ReadEligibility, report: HistorySupportReport, target: HistoryTarget): ReusableEmptyGoal[] {
  const digest = historyCursorScopeDigest(token, report, target);
  const expectedSupport = serializeSupport(report);
  let expectedTargetJson: string, expectedEligibility: string;
  try { expectedTargetJson = JSON.stringify(target); expectedEligibility = JSON.stringify(token); }
  catch { return []; }
  const rows = tx.all(`SELECT * FROM read_goal WHERE owner_id=? AND contact_id=?
    AND kind IN ('history','incremental') AND state IN ('running','incomplete') AND creation_no IS NOT NULL
    ORDER BY creation_no DESC, created_at DESC, id DESC`, [token.owner_id, token.contact_id]);
  const reusable: ReusableEmptyGoal[] = [];
  for (const row of rows) {
    try {
      if (pagesAccepted(row) !== 0n) continue;
      if (String(row.binding_id) !== token.binding_id || String(row.grant_id) !== token.grant_id) continue;
      if (String(BigInt(String(row.accepted_data_generation))) !== String(BigInt(token.data_generation))
        || String(BigInt(String(row.accepted_barrier_generation))) !== String(BigInt(token.barrier_generation))) continue;
      if (String(row.cursor_scope_digest ?? '') !== digest) continue;
      if (String(row.support_json) !== expectedSupport || String(row.eligibility_json) !== expectedEligibility) continue;
      const stored = JSON.parse(String(row.target_json)) as HistoryTarget;
      if (JSON.stringify(stored) !== expectedTargetJson) continue;
      if (hasCaptureRecord(tx, token.owner_id, String(row.id))) continue;
      if (row.kind === 'incremental' && !row.cursor) continue;
      if (row.kind === 'history' && row.state === 'incomplete' && !row.cursor) continue;
      reusable.push({kind: row.kind as 'history' | 'incremental', id: String(row.id), target: stored, cursor: row.cursor === null || row.cursor === undefined ? null : String(row.cursor)});
    } catch {/* 单行证据损坏时按不可续用处理，保持既有行为。 */}
  }
  return reusable;
}

function pagesAccepted(row: Record<string, unknown>): bigint {
  const value = row.pages_accepted;
  if (value === null || value === undefined) return 0n;
  return BigInt(String(value));
}

/** 目标名下存在任何 capture_record（被规范化或隔离的记录）即不是"0 页空目标"。 */
function hasCaptureRecord(tx: StorageTransaction, owner: string, goalId: string): boolean {
  return Boolean(tx.get(`SELECT 1 FROM sync_capture c WHERE c.owner_id=? AND c.goal_id=?
    AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=c.owner_id AND r.capture_id=c.id)`, [owner, goalId]));
}
