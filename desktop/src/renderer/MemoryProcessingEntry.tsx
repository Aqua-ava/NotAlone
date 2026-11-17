import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendBridge, BackendPhase } from '../shared/backend-bridge';
import type { FixedMemoryProcessingBridge, FixedProcessingMode, FixedProcessingRun } from '../shared/fixed-memory-processing';
import { FixedMemoryProcessingPanel } from './FixedMemoryProcessingPanel';
import { MemoryAutomaticSwitch } from './MemoryAutomaticSwitch';

export interface MemoryProcessingEntryProps {
  bridge: FixedMemoryProcessingBridge;
  backend: Pick<BackendBridge, 'onStateChanged'> & Partial<Pick<BackendBridge, 'getState'>>;
  scopeKey?: string | number;
  contactId?: string | null;
  children: ReactNode | ((processingRevision: number, completedRunId: string | null) => ReactNode);
  visible?: boolean;
  releaseOnUnmount?: boolean;
}

type EntryScope = Pick<MemoryProcessingEntryProps, 'bridge' | 'backend' | 'scopeKey'>;
type EntryState = { scope: EntryScope } & (
  { phase: 'pending' | 'failed' | 'connection-read-failed' | Exclude<BackendPhase, 'connected'> } | { phase: 'ready'; mode: FixedProcessingMode }
);

/** 本机 SQLite 运行状态经桥核验后才挂载记忆页面。 */
export function MemoryProcessingEntry({ bridge, backend, scopeKey, contactId = null, children, visible = true, releaseOnUnmount = true }: MemoryProcessingEntryProps) {
  const [state, setState] = useState<EntryState | null>(null);
  const [processingRevision,setProcessingRevision]=useState(0);
  const [completedRunId,setCompletedRunId]=useState<string|null>(null);
  const onRunUpdated=useCallback((run:FixedProcessingRun|null)=>{
    setProcessingRevision(value=>value+1);setCompletedRunId(run?.state==='completed'?run.runId:null);
  },[]);
  const scope = useRef<EntryScope>({ bridge, backend, scopeKey });
  if (scope.current.bridge !== bridge || scope.current.backend !== backend || scope.current.scopeKey !== scopeKey) {
    scope.current = { bridge, backend, scopeKey };
  }
  const acceptedScope = scope.current;
  const reread = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true, revision = 0, connectionRevision = -1, connectionObserved = false, connected = false;
    const read = async () => {
      if (!active || !connected || scope.current !== acceptedScope) return;
      const accepted = ++revision;
      setState({ scope: acceptedScope, phase: 'pending' });
      try {
        const next = await bridge.readMode();
        if (next.mode !== 'sqlite') throw new Error('记忆存储模式无效');
        if (active && accepted === revision && scope.current === acceptedScope) {
          setState({ scope: acceptedScope, phase: 'ready', mode: next });
        }
      } catch {
        if (active && accepted === revision && scope.current === acceptedScope) {
          setState({ scope: acceptedScope, phase: 'failed' });
        }
      }
    };
    const receive = (state: {phase:BackendPhase;revision?:number}) => {
      if (!active || scope.current !== acceptedScope || state.revision !== undefined && state.revision < connectionRevision) return;
      if(state.revision !== undefined)connectionRevision=state.revision;
      connectionObserved = true;
      const wasConnected = connected;
      connected = state.phase === 'connected';
      if (state.phase === 'connected') { if (!wasConnected) void read(); }
      else { revision++; setState({ scope: acceptedScope, phase: state.phase }); }
    };
    const readConnection = async () => {
      try { if(backend.getState)receive(await backend.getState()); }
      catch { if(active&&!connectionObserved)setState({scope:acceptedScope,phase:'connection-read-failed'}); }
    };
    reread.current = () => connected ? read() : readConnection();
    const unsubscribe = backend.onStateChanged(receive);
    if(backend.getState)void readConnection();
    else if(!connectionObserved){connected=true;void read();}
    return () => { active = false; revision++; unsubscribe(); reread.current = async () => {}; };
  }, [bridge, backend, acceptedScope]);
  const current = state?.scope === acceptedScope ? state : null;
  if (current?.phase === 'ready') {
    return <Fragment key={current.mode.connectionGeneration}>
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
    <button type="button" onClick={() => void reread.current()}>重新读取连接状态</button>
  </section>;
  if (current?.phase === 'failed') return <section aria-label="记忆处理模式">
    <p role="alert">记忆处理模式暂不可用，请重新读取。</p>
    <button type="button" onClick={() => void reread.current()}>重新读取记忆模式</button>
  </section>;
  return <p role="status">{!current && backend.getState ? '正在读取本机连接状态…' : '正在核对记忆处理模式…'}</p>;
}
