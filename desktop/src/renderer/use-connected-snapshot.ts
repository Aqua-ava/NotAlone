import { useEffect, useRef, useState } from 'react';
import type { BackendBridge, BackendPhase } from '../shared/backend-bridge';

type Connection = Pick<BackendBridge, 'onStateChanged'> & Partial<Pick<BackendBridge, 'getState'>>;
type SnapshotState<T> = { phase: 'ready'; value: T } | {
  phase: 'connection-pending' | 'pending' | 'failed' | 'connection-read-failed' | Exclude<BackendPhase, 'connected'>;
};
type Scope<T> = { backend: Connection | undefined; read: () => Promise<T>; key: unknown };

/** 连接与范围变化立即撤下快照，只有当前读取可提交；隐藏页面继续接收连接失效。 */
export function useConnectedSnapshot<T>(backend: Connection | undefined, read: () => Promise<T>, key?: unknown) {
  const scope = useRef<Scope<T>>({ backend, read, key });
  if (scope.current.backend !== backend || scope.current.read !== read || scope.current.key !== key) {
    scope.current = { backend, read, key };
  }
  const acceptedScope = scope.current;
  const [state, setState] = useState<(SnapshotState<T> & { scope: Scope<T>; request: number }) | null>(null);
  const retry = useRef<() => Promise<void>>(async () => {});
  const invalidate = useRef<(accepted: number) => void>(() => {});
  useEffect(() => {
    let active = true, request = 0, connectionRevision = -1, connectionObserved = false, connected = false;
    const current = () => active && scope.current === acceptedScope;
    const publish = (next: SnapshotState<T>) => { if (current()) setState({ ...next, scope: acceptedScope, request }); };
    const readSnapshot = async () => {
      if (!current() || !connected) return;
      const accepted = ++request;
      publish({ phase: 'pending' });
      try {
        const value = await read();
        if (accepted === request) publish({ phase: 'ready', value });
      } catch {
        if (accepted === request) publish({ phase: 'failed' });
      }
    };
    const receive = (next: { phase: BackendPhase; revision?: number }) => {
      if (!current() || next.revision !== undefined && next.revision < connectionRevision) return;
      if (next.revision !== undefined) connectionRevision = next.revision;
      connectionObserved = true;
      const wasConnected = connected;
      connected = next.phase === 'connected';
      if (next.phase === 'connected') { if (!wasConnected) void readSnapshot(); }
      else { request++; publish({ phase: next.phase }); }
    };
    const readConnection = async () => {
      try { if (backend?.getState) receive(await backend.getState()); }
      catch { if (!connectionObserved) publish({ phase: 'connection-read-failed' }); }
    };
    retry.current = () => connected ? readSnapshot() : readConnection();
    // 子页失效只撤下它所属的快照，不能作废重连后已开始的新读取。
    invalidate.current = accepted => {
      if (!current() || !connected || accepted !== request) return;
      request++; publish({ phase: 'failed' });
    };
    const unsubscribe = backend?.onStateChanged(receive);
    if (backend?.getState) void readConnection();
    else if (!connectionObserved) receive({ phase: 'connected' });
    return () => {
      active = false; request++; unsubscribe?.();
      retry.current = async () => {}; invalidate.current = () => {};
    };
  }, [acceptedScope]);
  const current: SnapshotState<T> = state?.scope === acceptedScope ? state
    : { phase: backend?.getState ? 'connection-pending' : 'pending' };
  return {
    state: current,
    retry: () => scope.current === acceptedScope ? retry.current() : Promise.resolve(),
    invalidate: () => {
      if (scope.current === acceptedScope && state?.scope === acceptedScope && state.phase === 'ready') {
        invalidate.current(state.request);
      }
    },
  };
}
