import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendBridge } from '../shared/backend-bridge';
import type { FixedMemoryProcessingBridge, FixedProcessingMode, FixedProcessingRun } from '../shared/fixed-memory-processing';
import { FixedMemoryProcessingPanel } from './FixedMemoryProcessingPanel';
import { HistoryMemoryProcessingPanel } from './HistoryMemoryProcessingPanel';

export interface MemoryProcessingEntryProps {
  bridge: FixedMemoryProcessingBridge;
  backend: Pick<BackendBridge, 'onStateChanged'>;
  scopeKey?: string | number;
  contactId?: string | null;
  scopeRevision?: number;
  children: ReactNode;
  sqliteChildren?: ReactNode | ((processingRevision:number,completedRunId:string|null)=>ReactNode);
}

type EntryScope = Pick<MemoryProcessingEntryProps, 'bridge' | 'backend' | 'scopeKey'>;
type EntryState = { scope: EntryScope } & (
  { phase: 'pending' | 'disconnected' | 'failed' } | { phase: 'ready'; mode: FixedProcessingMode }
);

/** 模式经本机桥核验后才挂载对应的记忆页面。 */
export function MemoryProcessingEntry({ bridge, backend, scopeKey, contactId = null, scopeRevision = 0, children, sqliteChildren }: MemoryProcessingEntryProps) {
  const [state, setState] = useState<EntryState | null>(null);
  const [processingRevision,setProcessingRevision]=useState(0);
  const [completedRunId,setCompletedRunId]=useState<string|null>(null);
  const [historyRevision,setHistoryRevision]=useState(0);
  const historyStarted=useCallback(()=>setHistoryRevision(value=>value+1),[]);
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
    let active = true, revision = 0, connectionObserved = false, connected = true;
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
    reread.current = read;
    const unsubscribe = backend.onStateChanged(state => {
      if (!active || scope.current !== acceptedScope) return;
      connectionObserved = true;
      connected = state.phase === 'connected';
      if (connected) void read();
      else { revision++; setState({ scope: acceptedScope, phase: 'disconnected' }); }
    });
    if (!connectionObserved) void read();
    return () => { active = false; revision++; unsubscribe(); reread.current = async () => {}; };
  }, [bridge, backend, acceptedScope]);
  const current = state?.scope === acceptedScope ? state : null;
  if (current?.phase === 'ready') {
    if (current.mode.mode === 'legacy') return children;
    if (current.mode.mode === 'sqlite') return <><FixedMemoryProcessingPanel bridge={bridge} contactId={contactId} scopeKey={`${scopeKey??''}:${historyRevision}`} onRunUpdated={onRunUpdated}/><HistoryMemoryProcessingPanel bridge={bridge} contactId={contactId} scopeRevision={scopeRevision} onStarted={historyStarted}/>{typeof sqliteChildren==='function'?sqliteChildren(processingRevision,completedRunId):sqliteChildren}</>;
  }
  if (current?.phase === 'disconnected') return <p role="status">本机连接已变化，正在等待重新连接。</p>;
  if (current?.phase === 'failed') return <section aria-label="记忆处理模式">
    <p role="alert">记忆处理模式暂不可用，请重新读取。</p>
    <button type="button" onClick={() => void reread.current()}>重新读取记忆模式</button>
  </section>;
  return <p role="status">正在核对记忆处理模式…</p>;
}
