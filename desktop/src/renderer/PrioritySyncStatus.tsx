import type { SyncControlBridge, SyncControlState } from '../shared/sync-control-bridge';
import { useRevisionedSession } from './use-revisioned-session';

const initial: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null,
  busy: null, errorCode: null };

export function PrioritySyncStatus({ contactId, bridge }: { contactId: string | null; bridge: SyncControlBridge }) {
  const { state } = useRevisionedSession(initial, bridge);
  const report = state.report;
  if (!contactId || !report?.enabled || !report.priority) return null;
  const priority = report.priority;
  if (priority.contactId !== contactId) return <p className="rewrite-privacy" role="status">当前联系人尚未取得优先同步状态。</p>;
  const last = priority.lastSuccessAt === null ? null : new Date(priority.lastSuccessAt);
  const seconds = last === null ? 0 : Math.max(0, Math.floor((Date.now() - last.getTime()) / 1000));
  const age = seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
  return <div className="rewrite-privacy" aria-label="当前联系人同步状态">
    <p role="status">{last ? `最近成功检查消息：${last.toLocaleTimeString('zh-CN', { hour12: false })}（${age}）。`
      : '当前联系人尚未成功检查消息。'}</p>
    {priority.lastFailureCode && <p role="status">{priority.lastFailureCode === 'cli_timeout'
      ? '当前联系人读取超时，将在后续轮次重试。' : '当前联系人本次读取未成功，请查看后台同步状态。'}</p>}
  </div>;
}
