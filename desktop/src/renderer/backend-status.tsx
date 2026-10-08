import { useEffect, useState } from 'react';
import type { BackendState } from '../shared/backend-bridge';
import { Icon } from './icons';

const initial: BackendState = { phase: 'disconnected', reused: false, revision: -1, canRetryConnection: false, canRetryShutdown: false,
  canSaveStartupPaths: false, canPrepareConfiguration: false };
export function useBackendState(): BackendState {
  const [state, setState] = useState(initial);
  useEffect(() => {
    let active = true;
    const receive = (next: BackendState) => {
      if (active) setState((previous) => next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.notalone.backend.onStateChanged(receive);
    void window.notalone.backend.getState().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  return state;
}

export function BackendBadge({ state, compact = false }: { state: BackendState; compact?: boolean }) {
  const label = state.phase === 'connected' ? '已连接'
    : state.phase === 'connecting' ? '连接中' : state.phase === 'stopping' ? '正在停读'
      : state.phase === 'shutdown-failed' ? '停读未获确认' : state.phase === 'stopped' ? '已停读' : '尚未连接';
  return <span className={compact ? 'ime-status' : 'connection-status'} role="status"><span className="status-dot" />{label}</span>;
}

export function BackendConnectionNote({ state }: { state: BackendState }) {
  const connected = state.phase === 'connected';
  const failedStop = state.phase === 'shutdown-failed';
  const title = connected ? '本机服务已连接' : failedStop ? '后端关闭未获确认'
    : state.phase === 'stopping' ? '正在停止本次后台读取' : '本机服务尚未连接';
  const message = connected ? (state.reused ? '已验证既有运行时。' : '已启动并验证本机运行时。')
    : failedStop ? '后端关闭未获确认，请重试停读。'
      : state.errorCode === 'backend_handshake_invalid' ? '本机服务连接信息无效，请检查后重试。'
        : state.errorCode === 'backend_connection_failed' ? '本机服务连接失败，请重试。'
          : state.phase === 'stopping' ? '停止期间暂停业务操作，请等待真实结果。' : '联系人、资料与生成暂时不可用。';
  return <section className="connection-note" aria-label="连接状态"><Icon name="config" size={20} /><div>
    <b>{title}</b><p role={failedStop ? 'alert' : undefined}>{message}</p></div>
    {state.canRetryConnection && <button className="button" onClick={() => void window.notalone.backend.retryConnection().catch(() => {})}>重试连接</button>}
    {state.canRetryShutdown && <button className="button" onClick={() => void window.notalone.backend.quit().catch(() => {})}>重试停读并退出</button>}
  </section>;
}
