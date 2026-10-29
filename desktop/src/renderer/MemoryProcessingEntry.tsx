import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackendBridge } from '../shared/backend-bridge';
import type { FixedMemoryProcessingBridge, FixedProcessingMode } from '../shared/fixed-memory-processing';
import { FixedMemoryProcessingPanel } from './FixedMemoryProcessingPanel';

export interface MemoryProcessingEntryProps {
  bridge: FixedMemoryProcessingBridge;
  backend: Pick<BackendBridge, 'onStateChanged'>;
  scopeKey?: string | number;
  children: ReactNode;
}

type EntryScope = Pick<MemoryProcessingEntryProps, 'bridge' | 'backend' | 'scopeKey'>;
type EntryState = { scope: EntryScope } & (
  { phase: 'pending' | 'disconnected' | 'failed' } | { phase: 'ready'; mode: FixedProcessingMode }
);

/** 模式经本机桥核验后才挂载对应的记忆页面。 */
export function MemoryProcessingEntry({ bridge, backend, scopeKey, children }: MemoryProcessingEntryProps) {
  const [state, setState] = useState<EntryState | null>(null);
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
    if (current.mode.mode === 'sqlite') return <FixedMemoryProcessingPanel bridge={bridge} scopeKey={scopeKey}/>;
  }
  if (current?.phase === 'disconnected') return <p role="status">本机连接已变化，正在等待重新连接。</p>;
  if (current?.phase === 'failed') return <section aria-label="记忆处理模式">
    <p role="alert">记忆处理模式暂不可用，请重新读取。</p>
    <button type="button" onClick={() => void reread.current()}>重新读取记忆模式</button>
  </section>;
  return <p role="status">正在核对记忆处理模式…</p>;
}
