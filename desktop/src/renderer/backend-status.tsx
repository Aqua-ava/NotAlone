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
  const latestRevision = useRef(initial.revision);
  const stateVersion = useRef(0);
  useEffect(() => {
    let active = true;
    const receive = (next: BackendState) => {
      if (!active || next.revision < latestRevision.current) return;
      latestRevision.current = next.revision; stateVersion.current++;
      setError(''); setState(next);
    };
    const unsubscribe = window.notalone.backend.onStateChanged(receive);
    void readInitialState({ read: () => window.notalone.backend.getState(), receive, reportError: setError,
      isActive: () => active, busy: reading, getStateVersion: () => stateVersion.current });
    return () => { active = false; unsubscribe(); };
  }, [readAttempt]);
  return { state, error, retry: () => setReadAttempt((value) => value + 1) };
}

export function BackendBadge({ state, compact = false }: { state: BackendState; compact?: boolean }) {
  const label = state.phase === 'connected' ? '本机服务已连接'
    : state.phase === 'connecting' ? '连接中' : state.phase === 'stopping' ? '正在停读'
      : state.phase === 'shutdown-failed' ? '停读未获确认' : state.phase === 'stopped' ? '已停读' : '尚未连接';
  return <span className={compact ? 'ime-status' : 'connection-status'} role="status"><span className="status-dot" />{label}</span>;
}

export function BackendConnectionNote({ state, startup, onDiagnose }: {
  state: BackendState; startup?: StartupState; onDiagnose?: () => void;
}) {
  const [actionError, setActionError] = useState('');
  const attempt = (message: string, operation: () => Promise<unknown>) => {
    setActionError('');
    void operation().catch(() => setActionError(message));
  };
  if (state.phase === 'connected') return null;
  if (startup && startup.phase !== 'ready' && !state.canRetryShutdown && (state.phase === 'connecting' || state.phase === 'disconnected')) return null;
  const failedStop = state.phase === 'shutdown-failed';
  const preparationFailed = failedStop && state.errorCode === 'backend_shutdown_preparation_failed';
  const title = state.phase === 'connecting' ? '正在连接本机服务' : preparationFailed ? '退出准备未完成' : failedStop ? '后端关闭未获确认'
    : state.phase === 'stopping' ? '正在停止本次后台读取'
      : state.phase === 'stopped' ? '本次后台读取已停止' : '本机服务尚未连接';
  const startupMessages: Partial<Record<NonNullable<BackendState['errorCode']>, string>> = {
    backend_startup_runtime_failed: '本机服务运行组件未能启动，请检查安装组件后重试。',
    backend_startup_configuration_failed: '本机服务启动配置未通过检查，请查看诊断并检查设置。',
    backend_startup_storage_failed: '本机数据库未能打开或通过检查，请查看诊断，保留现有资料。',
    backend_startup_modules_failed: '本机服务业务模块初始化失败，请查看诊断后重试。',
    backend_startup_handshake_failed: '本机服务连接准备未完成，请查看诊断后重试。',
  };
  const message = state.phase === 'connecting' ? '本机服务正在启动，完成后即可使用联系人、资料与生成。'
      : preparationFailed ? '退出前的本机清理未完成，请重试或查看诊断。'
      : failedStop ? '后端关闭未获确认，请重试停读。'
      : state.phase === 'stopped' ? '后台读取已停止，联系人、资料与生成暂时不可用。'
      : state.errorCode && startupMessages[state.errorCode] ? startupMessages[state.errorCode]
      : state.errorCode === 'backend_handshake_invalid' ? '本机服务连接信息无效，请检查后重试。'
        : state.errorCode === 'backend_connection_failed' ? '本机服务连接失败，请重试。'
          : state.phase === 'stopping' ? '停止期间暂停业务操作，请等待真实结果。' : '联系人、资料与生成暂时不可用。';
  return <section className="connection-note" aria-label="连接状态"><Icon name="config" size={20} /><div>
    <b>{title}</b><p role={failedStop ? 'alert' : undefined}>{message}</p>
    {actionError && <p role="alert">{actionError}</p>}</div>
    {state.canRetryConnection && <button className="button" onClick={() => attempt('重试连接未成功，请稍后再试。', () => window.notalone.backend.retryConnection())}>重试连接</button>}
    {onDiagnose && <button className="button" onClick={onDiagnose}>查看诊断</button>}
    {state.canRetryShutdown && <button className="button" onClick={() => attempt('重试停读尚未获确认，请稍后再试。', () => window.notalone.backend.quit())}>重试停读并退出</button>}
  </section>;
}
