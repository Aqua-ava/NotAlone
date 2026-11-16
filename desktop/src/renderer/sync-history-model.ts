import type { HistoryCoverage } from '../shared/sync-control-bridge';

export type SyncIssueKind = 'source' | 'identity' | 'capability' | 'local' | 'temporary' | 'history' | 'unknown';
export interface SyncIssueGroup {
  kind: SyncIssueKind;
  title: string;
  description: string;
}
export const syncIssueGroups: readonly SyncIssueGroup[] = [
  { kind: 'source', title: '聊天来源需要核验', description: '暂时无法确认聊天来源或读取范围，相关读取已暂停；已保存的聊天仍保留。请查看联系人的同步设置与来源核验状态。' },
  { kind: 'identity', title: '部分消息需要核验', description: '部分消息的身份或状态尚未确认，暂不作为回复依据。可在故障排查中查看原因。' },
  { kind: 'capability', title: '读取能力需要核验', description: '当前微信读取能力尚未通过核验，相关读取保持关闭。可在故障排查中查看原因。' },
  { kind: 'local', title: '本机记录暂不可读取', description: '这台电脑可能没有对应历史记录，或部分历史已被删除。请查看联系人的具体状态。' },
  { kind: 'temporary', title: '暂时读取失败', description: '本次读取遇到临时问题，已保存的记录会保留。' },
  { kind: 'history', title: '历史尚未读完', description: '部分历史还未完成读取，暂时不能确认聊天资料完整。' },
  { kind: 'unknown', title: '同步状态需要检查', description: '同步已停止或状态尚未确认。请查看联系人状态或故障排查，确认下一步。' },
];

const reasonKinds: Readonly<Record<string, SyncIssueKind>> = {
  cli_chat_not_private: 'source', cli_scope_unverified: 'source',
  history_source_continuity_unverified: 'source', history_external_scope_changed: 'source',
  history_cursor_invalid: 'source', history_cursor_scope_changed: 'source',
  history_suppression_unverified: 'source', history_suppression_changed: 'source',
  history_page_invalid: 'source', history_support_changed: 'source',
  history_identity_quarantined: 'identity', history_identity_conflict: 'identity', history_identity_insufficient: 'identity',
  history_support_unsupported: 'capability', history_support_unverified: 'capability',
  history_message_state_unverified: 'capability', history_source_lifecycle_unverified: 'capability',
  history_snapshot_runtime_proof_required: 'capability', history_partition_coverage_runtime_proof_required: 'capability',
  history_incremental_unavailable: 'capability', history_tail_unsupported: 'capability', history_tail_baseline_too_large: 'capability',
  local_history_deleted: 'local', local_history_empty: 'local', history_empty: 'local', history_partitions_missing: 'local',
  cli_timeout: 'temporary', cli_output_invalid: 'temporary', cli_freshness_unknown: 'temporary',
  cli_normalization_failed: 'temporary', cli_message_table_missing: 'temporary', history_page_stalled: 'temporary',
  history_native_unavailable: 'temporary', history_native_timeout: 'temporary', history_interrupted: 'temporary',
  history_source_temporarily_unavailable: 'temporary',
  history_incomplete: 'history',
};
const issuePriority: Readonly<Record<SyncIssueKind, number>> = { source: 0, identity: 1, capability: 2, unknown: 3, local: 4, temporary: 5, history: 6 };
const stoppedPhases = new Set(['blocked', 'incomplete', 'invalidated', 'unavailable']);

export interface SyncContactStatus {
  contactId: string;
  displayName: string;
  rows: HistoryCoverage[];
  issue: SyncIssueKind | null;
  complete: boolean;
  /** 已保存的本机历史是否读完；任一记录缺少该字段（旧后台）时为 undefined，不推断为已完成。仅用于进度展示。 */
  savedComplete: boolean | undefined;
  reading: boolean;
  following: boolean;
  awaitingMessages: boolean;
}

function rowIssues(row: HistoryCoverage): SyncIssueKind[] {
  const codes = [row.failureCode, row.incrementalFailureCode].filter((code): code is string => Boolean(code));
  const kinds = codes.filter(code => !(row.phase === 'complete' && ['local_history_empty', 'local_history_deleted'].includes(code))
    && !(row.incrementalAwaitingMessages && ['history_incremental_unavailable', 'history_tail_unsupported'].includes(code)))
    .map(code => reasonKinds[code] ?? 'unknown');
  if (!kinds.length && row.phase === 'incomplete') kinds.push('history');
  if (!kinds.length && stoppedPhases.has(row.incrementalPhase ?? '') && !row.incrementalAwaitingMessages) kinds.push('unknown');
  return kinds;
}

/** 一个联系人只计数一次；来源失证等阻断原因优先于补历史和临时失败。 */
export function buildSyncContacts(coverages: readonly HistoryCoverage[] = [], contacts: readonly { contactId: string; displayName: string }[] = []): SyncContactStatus[] {
  const names = new Map(contacts.map(contact => [contact.contactId, contact.displayName]));
  const grouped = new Map<string, HistoryCoverage[]>();
  for (const row of coverages) {
    const rows = grouped.get(row.contactId);
    if (rows) rows.push(row); else grouped.set(row.contactId, [row]);
  }
  return [...grouped].map(([contactId, rows]) => {
    const issues = rows.flatMap(rowIssues);
    issues.sort((left, right) => issuePriority[left] - issuePriority[right]);
    return {
      contactId, displayName: names.get(contactId) ?? '未命名联系人', rows, issue: issues[0] ?? null,
      complete: rows.every(row => row.phase === 'complete'),
      savedComplete: rows.some(row => row.savedHistoryComplete === undefined) ? undefined : rows.every(row => row.savedHistoryComplete === true),
      reading: rows.some(row => row.phase === 'syncing' && !row.failureCode && !row.incrementalFailureCode),
      following: rows.some(row => row.incrementalPhase === 'syncing' && !row.failureCode && !row.incrementalFailureCode),
      awaitingMessages: rows.every(row => row.incrementalAwaitingMessages === true),
    };
  });
}

export function syncContactLabel(contact: SyncContactStatus, bodyAvailable?: boolean, enabled?: boolean): string {
  if (enabled === false) return '自动同步已关闭';
  if (contact.issue) return syncIssueGroups.find(group => group.kind === contact.issue)!.title;
  if (bodyAvailable === false) return contact.reading || contact.following ? '正在核验读取能力' : '等待读取能力核验';
  if (contact.awaitingMessages || contact.rows.every(row => row.phase === 'complete' && row.messageCount === 0
    && row.nonTextCount === 0 && (row.metadataOnlyCount ?? 0) === 0)) return '本机暂无可读记录';
  if (contact.reading) return '正在读取历史';
  if (contact.complete) return contact.following ? '历史已读完 · 正在同步新消息' : '本机历史已读完';
  return '等待同步';
}
