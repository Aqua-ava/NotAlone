import type { HistoryCoveragePhase, SyncStatusReport } from './sync-control-bridge';

// 旧账号授权的尚未开始只是未知覆盖；不能阻断仍获准的增量回复。
export function historyReplyEligibility(report: Pick<SyncStatusReport, 'historyCoverages' | 'historyAuthorizationState'> | null,
  contactId: string | null, previous?: HistoryCoveragePhase): HistoryCoveragePhase | undefined {
  if (!report?.historyCoverages) return previous;
  const phases = report?.historyCoverages?.filter(row => row.contactId === contactId
    && (row.phase !== 'not_started' || report.historyAuthorizationState === 'accepted')).map(row => row.phase) ?? [];
  return (['not_started', 'syncing', 'incomplete', 'complete'] as const).find(phase => phases.includes(phase));
}
