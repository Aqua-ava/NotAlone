import type { HistoryCoveragePhase, SyncStatusReport } from './sync-control-bridge';

// 只投影当前联系人的覆盖事实；缺少联系人不推断状态，覆盖不再作为生成门槛。
export function historyReplyEligibility(report: Pick<SyncStatusReport, 'historyCoverages' | 'historyAuthorizationState'> | null,
  contactId: string | null, previous?: HistoryCoveragePhase): HistoryCoveragePhase | undefined {
  if (!contactId) return undefined;
  if (!report) return previous;
  const accepted = report.historyAuthorizationState === 'accepted';
  if (!report.historyCoverages) return accepted ? 'not_started' : previous;
  const phases = report.historyCoverages.filter(row => row.contactId === contactId
    && (row.phase !== 'not_started' || accepted)).map(row => row.phase);
  if (accepted && !phases.length) return 'not_started';
  return (['not_started', 'syncing', 'incomplete', 'complete'] as const).find(phase => phases.includes(phase));
}
