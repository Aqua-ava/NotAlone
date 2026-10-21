import { useCallback, useEffect, useRef, useState } from 'react';
import { readInitialState } from './initial-read';

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
  const reading = useRef(false);
  const receive = useCallback((update: State | Update) => {
    if (!active.current) return;
    const next = reduce ? reduce(latest.current, update) : update as State;
    if (!active.current || next.revision <= latest.current.revision) return;
    if (next.scopeRevision !== latest.current.scopeRevision) setError('');
    latest.current = next;
    setState(next);
  }, [reduce]);
  // 首帧读取失败写入可见错误；成功后清空错误并保留重试入口。
  const retry = useCallback(() => readInitialState({
    read: () => bridge.getState(),
    receive,
    reportError: setError,
    isActive: () => active.current,
    busy: reading,
  }), [bridge, receive]);

  useEffect(() => {
    active.current = enabled;
    if (!enabled) return;
    const unsubscribe = bridge.onStateChanged(receive);
    void retry();
    return () => { active.current = false; unsubscribe(); };
  }, [bridge, receive, enabled, retry]);

  return { state, error, setError, latest, active, receive, retry };
}
