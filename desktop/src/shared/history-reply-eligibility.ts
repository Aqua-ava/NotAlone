import type { HistoryCoveragePhase, SyncStatusReport } from './sync-control-bridge';

// 旧账号拒绝历史时保持增量回复；已接受账号缺任务/覆盖时必须视为尚未开始。
export function historyReplyEligibility(report: Pick<SyncStatusReport, 'historyCoverages' | 'historyAuthorizationState'> | null,
  contactId: string | null, previous?: HistoryCoveragePhase): HistoryCoveragePhase | undefined {
  if (!report) return previous;
  const accepted = report.historyAuthorizationState === 'accepted';
  if (!report.historyCoverages) return accepted ? 'not_started' : previous;
  const phases = report.historyCoverages.filter(row => row.contactId === contactId
    && (row.phase !== 'not_started' || accepted)).map(row => row.phase);
  if (accepted && !phases.length) return 'not_started';
  return (['not_started', 'syncing', 'incomplete', 'complete'] as const).find(phase => phases.includes(phase));
}
