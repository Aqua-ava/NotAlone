import { useEffect, useRef, useState } from 'react';
import { readInitialState } from './initial-read';
import type { BackendState } from '../shared/backend-bridge';
import { Icon } from './icons';
import type { StartupState } from '../shared/startup-bridge';

const initial: BackendState = { phase: 'disconnected', reused: false, revision: -1, canRetryConnection: false, canRetryShutdown: false,
  canSaveStartupPaths: false, canPrepareConfiguration: false };
export function useBackendState(): { state: BackendState; error: string; retry: () => void } {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const reading = useRef(false);
  useEffect(() => {
    let active = true;
    const receive = (next: BackendState) => {
      if (active) setState((previous) => next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.notalone.backend.onStateChanged(receive);
    void readInitialState({ read: () => window.notalone.backend.getState(), receive, reportError: setError,
      isActive: () => active, busy: reading });
    return () => { active = false; unsubscribe(); };
  }, [readAttempt]);
  return { state, error, retry: () => setReadAttempt((value) => value + 1) };
}

export function BackendBadge({ state, compact = false }: { state: BackendState; compact?: boolean }) {
  const label = state.phase === 'connected' ? '已连接'
    : state.phase === 'connecting' ? '连接中' : state.phase === 'stopping' ? '正在停读'
      : state.phase === 'shutdown-failed' ? '停读未获确认' : state.phase === 'stopped' ? '已停读' : '尚未连接';
  return <span className={compact ? 'ime-status' : 'connection-status'} role="status"><span className="status-dot" />{label}</span>;
}

export function BackendConnectionNote({ state, startup, onDiagnose }: {
  state: BackendState; startup?: StartupState; onDiagnose?: () => void;
}) {
  if (state.phase === 'connected') return null;
  if (startup && startup.phase !== 'ready' && state.phase !== 'shutdown-failed' && !state.canRetryShutdown) return null;
  const failedStop = state.phase === 'shutdown-failed';
  const title = failedStop ? '后端关闭未获确认'
    : state.phase === 'stopping' ? '正在停止本次后台读取' : '本机服务尚未连接';
  const message = failedStop ? '后端关闭未获确认，请重试停读。'
      : state.errorCode === 'backend_handshake_invalid' ? '本机服务连接信息无效，请检查后重试。'
        : state.errorCode === 'backend_connection_failed' ? '本机服务连接失败，请重试。'
          : state.phase === 'stopping' ? '停止期间暂停业务操作，请等待真实结果。' : '联系人、资料与生成暂时不可用。';
  return <section className="connection-note" aria-label="连接状态"><Icon name="config" size={20} /><div>
    <b>{title}</b><p role={failedStop ? 'alert' : undefined}>{message}</p></div>
    {state.canRetryConnection && <button className="button" onClick={() => void window.notalone.backend.retryConnection().catch(() => {})}>重试连接</button>}
    {onDiagnose && startup?.mode !== 'managed' && <button className="button" onClick={onDiagnose}>查看诊断</button>}
    {state.canRetryShutdown && <button className="button" onClick={() => void window.notalone.backend.quit().catch(() => {})}>重试停读并退出</button>}
  </section>;
}
