import type { BackgroundSyncPhase, ForegroundReportPhase, SyncControlBridge, SyncControlState } from '../shared/sync-control-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import './bindings.css';

const initial: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };
const backgroundLabels: Record<BackgroundSyncPhase, string> = { disabled: '后台读取已关闭', waiting_bindings: '等待确认会话授权',
  active: '后台读取运行中', degraded: '后台读取已降级，请检查 CLI 后刷新状态' };
const foregroundLabels: Record<ForegroundReportPhase, string> = { sync_disabled: '最近报告：前台定位暂停',
  waiting_foreground: '最近报告：等待微信前台', unavailable: '最近报告：前台定位不可用',
  active: '最近报告：已取得定位结果', failed: '最近报告：前台定位失败' };

export function SyncControlPanel({ bridge }: { bridge: SyncControlBridge }) {
  const { state, latest, active, error, setError } = useRevisionedSession(initial, bridge);
  async function operate(operation: () => Promise<void>) {
    const scopeRevision = latest.current.scopeRevision;
    try { await operation(); if (active.current && scopeRevision === latest.current.scopeRevision) setError(''); }
    catch { if (active.current && scopeRevision === latest.current.scopeRevision) setError('本次同步范围已变化，请刷新状态后重试。'); }
  }
  const report = state.report;
  const available = state.phase === 'ready' && report !== null && state.busy === null;
  const switchSync = () => operate(() => report?.enabled
    ? bridge.disable({ scopeRevision: state.scopeRevision }) : bridge.enable({ scopeRevision: state.scopeRevision }));
  return <div className="bindings-page">
    <section className="bindings-explanation" aria-label="后台 CLI 同步">
      <div className="bindings-toolbar"><h2>后台文字同步</h2><button className="button"
        disabled={state.phase === 'offline' || state.phase === 'loading' || state.busy !== null}
        onClick={() => void operate(() => bridge.refresh())}>刷新同步状态</button></div>
      <p role="status">{report ? report.enabled ? '后台正文同步已开启' : '后台正文同步已关闭' : '后台正文同步状态未确认'}</p>
      <button className="button" disabled={!available} onClick={() => void switchSync()}>{state.busy === 'enable' ? '正在开启后台同步…'
        : state.busy === 'disable' ? '正在关闭后台同步…' : report?.enabled ? '关闭后台同步' : '开启后台同步'}</button>
      <p>开启后仅读取已确认会话的文字；关闭同步或正常退出会停读，重新开启只在仍有效的确认范围内恢复。</p>
      {report && <p>{backgroundLabels[report.backgroundPhase]}。已确认范围：{report.confirmedBindingCount}个会话。</p>}
      {state.phase === 'loading' && <p role="status">正在确认同步状态…</p>}
      {state.phase === 'offline' && <p>连接本机服务后查看与控制后台同步。</p>}
      {state.phase === 'unavailable' && <p role="alert">本次运行身份或同步宿主尚未就绪，请检查配置后刷新状态。</p>}
      {state.errorCode && <p role="alert">{state.errorCode === 'operation-unconfirmed'
        ? '启停结果尚未确认，不能据此判断已经停读。请刷新同步状态后再决定下一步。'
        : '同步状态读取失败，请检查本机服务与 CLI 后刷新。'}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
    <section className="bindings-explanation" aria-label="前台定位最近报告"><h2>前台定位</h2>
      <p>{report ? foregroundLabels[report.foregroundPhase] : '最近同步报告尚不可用。'}</p>
      <p>这里只展示最近报告；当前联系人仍需确认。前台定位暂停或失败不改变已确认范围的后台同步。</p>
    </section>
  </div>;
}
