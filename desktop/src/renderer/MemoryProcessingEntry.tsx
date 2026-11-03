import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendBridge } from '../shared/backend-bridge';
import type { FixedMemoryProcessingBridge, FixedProcessingMode, FixedProcessingRun } from '../shared/fixed-memory-processing';
import { FixedMemoryProcessingPanel } from './FixedMemoryProcessingPanel';

export interface MemoryProcessingEntryProps {
  bridge: FixedMemoryProcessingBridge;
  backend: Pick<BackendBridge, 'onStateChanged'> & Partial<Pick<BackendBridge, 'getState'>>;
  scopeKey?: string | number;
  contactId?: string | null;
  children: ReactNode;
  visible?: boolean;
  releaseOnUnmount?: boolean;
  sqliteChildren?: ReactNode | ((processingRevision:number,completedRunId:string|null)=>ReactNode);
}

type EntryScope = Pick<MemoryProcessingEntryProps, 'bridge' | 'backend' | 'scopeKey'>;
type EntryState = { scope: EntryScope } & (
  { phase: 'pending' | 'disconnected' | 'failed' } | { phase: 'ready'; mode: FixedProcessingMode }
);

/** 模式经本机桥核验后才挂载对应的记忆页面。 */
export function MemoryProcessingEntry({ bridge, backend, scopeKey, contactId = null, children, sqliteChildren, visible = true, releaseOnUnmount = true }: MemoryProcessingEntryProps) {
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
        if (active && accepted === revision && scope.current === acceptedScope) {
          setState({ scope: acceptedScope, phase: 'ready', mode: next });
        }
      } catch {
        if (active && accepted === revision && scope.current === acceptedScope) {
          setState({ scope: acceptedScope, phase: 'failed' });
        }
      }
    };
    const receive = (state: {phase:string;revision?:number}) => {
      if (!active || scope.current !== acceptedScope || state.revision !== undefined && state.revision < connectionRevision) return;
      if(state.revision !== undefined)connectionRevision=state.revision;
      connectionObserved = true;
      const wasConnected = connected;
      connected = state.phase === 'connected';
      if (connected) { if (!wasConnected) void read(); }
      else { revision++; setState({ scope: acceptedScope, phase: 'disconnected' }); }
    };
    const readConnection = async () => {
      try { if(backend.getState)receive(await backend.getState()); }
      catch { if(active&&!connectionObserved)setState({scope:acceptedScope,phase:'failed'}); }
    };
    reread.current = () => connected ? read() : readConnection();
    const unsubscribe = backend.onStateChanged(receive);
    if(backend.getState)void readConnection();
    else if(!connectionObserved){connected=true;void read();}
    return () => { active = false; revision++; unsubscribe(); reread.current = async () => {}; };
  }, [bridge, backend, acceptedScope]);
  const current = state?.scope === acceptedScope ? state : null;
  if (current?.phase === 'ready') {
    if (current.mode.mode === 'legacy') return visible ? children : null;
    if (current.mode.mode === 'sqlite') return <Fragment key={current.mode.connectionGeneration}>{typeof sqliteChildren==='function'?sqliteChildren(processingRevision,completedRunId):sqliteChildren}<details className="memory-processing-disclosure"><summary>记忆处理状态</summary><FixedMemoryProcessingPanel releaseOnUnmount={releaseOnUnmount} visible={visible} bridge={bridge} contactId={contactId} scopeKey={scopeKey} onRunUpdated={onRunUpdated}/></details></Fragment>;
  }
  if (current?.phase === 'disconnected') return <p role="status">本机连接已变化，正在等待重新连接。</p>;
  if (current?.phase === 'failed') return <section aria-label="记忆处理模式">
    <p role="alert">记忆处理模式暂不可用，请重新读取。</p>
    <button type="button" onClick={() => void reread.current()}>重新读取记忆模式</button>
  </section>;
  return <p role="status">正在核对记忆处理模式…</p>;
}
