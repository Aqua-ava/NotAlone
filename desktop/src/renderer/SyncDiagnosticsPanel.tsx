import { useEffect } from 'react';
import type { SyncControlBridge, SyncControlState } from '../shared/sync-control-bridge';
import { HistoryCoverageDiagnostics } from './HistoryCoverageStatus';
import { useRevisionedSession } from './use-revisioned-session';

const initial: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };

export function SyncDiagnosticsPanel({ bridge, contacts }: {
  bridge: SyncControlBridge; contacts: { contactId: string; displayName: string }[];
}) {
  const { state, error, setError, retry, active } = useRevisionedSession(initial, bridge);
  async function refresh() {
    await retry();
    try { await bridge.refresh(); }
    catch { if (active.current) setError('同步诊断暂时无法刷新，请重试。'); }
  }
  useEffect(() => { void refresh(); }, [bridge]);
  const failed = !!error || !!state.errorCode || state.phase === 'failed' || state.phase === 'unavailable';
  return <section aria-label="同步诊断状态">
    <button className="button" disabled={state.phase === 'loading'} onClick={() => void refresh()}>刷新诊断状态</button>
    {failed && <p role="alert">同步诊断状态暂不可用，请刷新重试。</p>}
    <HistoryCoverageDiagnostics key={state.scopeRevision} coverages={failed ? undefined : state.report?.historyCoverages}
      contacts={contacts} bodyAvailable={state.report?.bodyAvailable} enabled={state.report?.enabled}
      incrementalIdentityLimit={state.report?.incrementalIdentityLimit} />
  </section>;
}
