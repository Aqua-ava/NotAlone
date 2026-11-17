import { Fragment, useCallback, useState, type ReactNode } from 'react';
import type { BackendBridge } from '../shared/backend-bridge';
import type { FixedMemoryProcessingBridge, FixedProcessingRun } from '../shared/fixed-memory-processing';
import { FixedMemoryProcessingPanel } from './FixedMemoryProcessingPanel';
import { MemoryAutomaticSwitch } from './MemoryAutomaticSwitch';
import { useConnectedSnapshot } from './use-connected-snapshot';

export interface MemoryProcessingEntryProps {
  bridge: FixedMemoryProcessingBridge;
  backend: Pick<BackendBridge, 'onStateChanged'> & Partial<Pick<BackendBridge, 'getState'>>;
  scopeKey?: string | number;
  contactId?: string | null;
  children: ReactNode | ((processingRevision: number, completedRunId: string | null) => ReactNode);
  visible?: boolean;
  releaseOnUnmount?: boolean;
}

/** 本机 SQLite 运行状态经桥核验后才挂载记忆页面。 */
export function MemoryProcessingEntry({ bridge, backend, scopeKey, contactId = null, children, visible = true, releaseOnUnmount = true }: MemoryProcessingEntryProps) {
  const [processingRevision,setProcessingRevision]=useState(0);
  const [completedRunId,setCompletedRunId]=useState<string|null>(null);
  const onRunUpdated=useCallback((run:FixedProcessingRun|null)=>{
    setProcessingRevision(value=>value+1);setCompletedRunId(run?.state==='completed'?run.runId:null);
  },[]);
  const readMode = useCallback(async () => {
    const mode = await bridge.readMode();
    if (mode.mode !== 'sqlite') throw new Error('记忆存储模式无效');
    return mode;
  }, [bridge]);
  const { state: current, retry } = useConnectedSnapshot(backend, readMode, scopeKey);
  if (current?.phase === 'ready') {
    return <Fragment key={current.value.connectionGeneration}>
      <MemoryAutomaticSwitch bridge={bridge}/>
      {typeof children === 'function' ? children(processingRevision, completedRunId) : children}
      <details className="memory-processing-disclosure">
        <summary>记忆处理状态</summary>
        <FixedMemoryProcessingPanel releaseOnUnmount={releaseOnUnmount} visible={visible} bridge={bridge}
          contactId={contactId} scopeKey={scopeKey} onRunUpdated={onRunUpdated}/>
      </details>
    </Fragment>;
  }
  if (current?.phase === 'connecting') return <p role="status">正在连接本机服务，连接后可查看记忆。</p>;
  if (current?.phase === 'disconnected') return <p role="status">本机服务尚未连接，连接后可查看记忆。</p>;
  if (current?.phase === 'stopping') return <p role="status">正在停止本次后台读取，记忆页面暂不可用。</p>;
  if (current?.phase === 'stopped') return <p role="status">本次后台读取已停止。</p>;
  if (current?.phase === 'shutdown-failed') return <p role="alert">后台停读尚未获确认，请重试停读或查看诊断。</p>;
  if (current?.phase === 'connection-read-failed') return <section aria-label="记忆页连接状态">
    <p role="alert">本机连接状态读取失败，请重试。</p>
    <button type="button" onClick={() => void retry()}>重新读取连接状态</button>
  </section>;
  if (current?.phase === 'failed') return <section aria-label="记忆处理模式">
    <p role="alert">记忆处理模式暂不可用，请重新读取。</p>
    <button type="button" onClick={() => void retry()}>重新读取记忆模式</button>
  </section>;
  return <p role="status">{current.phase === 'connection-pending' ? '正在读取本机连接状态…' : '正在核对记忆处理模式…'}</p>;
}
