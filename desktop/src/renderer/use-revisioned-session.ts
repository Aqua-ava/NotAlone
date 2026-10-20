import { useCallback, useEffect, useRef, useState } from 'react';

type RevisionedSession = { revision: number; scopeRevision: number };
type SessionSubscription<State, Update> = {
  getState(): Promise<State>;
  onStateChanged(listener: (state: Update) => void): () => void;
};

// 联系人与改写各自持有状态，只共享订阅、卸载保护和单调快照接收。
export function useRevisionedSession<State extends RevisionedSession, Update extends RevisionedSession = State>(initial: State, bridge: SessionSubscription<State, Update>, enabled = true,
  reduce?: (current: State, update: State | Update) => State) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const latest = useRef(state);
  const active = useRef(true);
  const receive = useCallback((update: State | Update) => {
    if (!active.current) return;
    const next = reduce ? reduce(latest.current, update) : update as State;
    if (!active.current || next.revision <= latest.current.revision) return;
    if (next.scopeRevision !== latest.current.scopeRevision) setError('');
    latest.current = next;
    setState(next);
  }, [reduce]);

  useEffect(() => {
    active.current = enabled;
    if (!enabled) return;
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => {});
    return () => { active.current = false; unsubscribe(); };
  }, [bridge, receive, enabled]);

  return { state, error, setError, latest, active, receive };
}
