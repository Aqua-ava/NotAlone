import { useEffect, useRef, useState } from 'react';
import { readInitialState } from './initial-read';

type StateBridge<State> = { getState(): Promise<State>; onStateChanged(listener: (state: State) => void): () => void };

// 单调接收桥状态：订阅推送并读取首帧，旧修订被忽略；首帧读取失败写入可见错误并可重试。
export function useBridgeState<State extends { revision: number }>(bridge: StateBridge<State>, initial: State, enabled = true):
  { state: State; error: string; retry: () => void } {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const reading = useRef(false);
  const latestRevision = useRef(initial.revision);
  const stateVersion = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const receive = (next: State) => {
      if (!active || next.revision < latestRevision.current) return;
      latestRevision.current = next.revision; stateVersion.current++;
      setError(''); setState(next);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void readInitialState({ read: () => bridge.getState(), receive, reportError: setError,
      isActive: () => active, busy: reading, getStateVersion: () => stateVersion.current });
    return () => { active = false; unsubscribe(); };
  }, [bridge, enabled, readAttempt]);
  return { state, error, retry: () => setReadAttempt((value) => value + 1) };
}
