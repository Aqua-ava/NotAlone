import {useEffect, useMemo, useRef, useState} from 'react';
import {memoryReadFailureCode, memoryReadResult, type MemoryReadFailureResult} from '../shared/sqlite-memory-management';

export interface MemoryBrowserNotice {message: string; error: boolean}
type ReadOutcome = 'ready' | 'failed' | 'invalid' | 'stale';
interface ReadOptions {preserve?: boolean; silent?: boolean}

/** 记忆浏览内部的单路读取：范围与请求身份共同决定回包能否进入快照。 */
export function useMemoryBrowserRead<T>(scope: object, unavailableMessage: string) {
  const session = useMemo(() => ({active: false, request: null as object | null}), [scope]);
  const latest = useRef(session);
  latest.current = session;
  const empty = () => ({session, snapshot: null as T | null, busy: false, notice: null as MemoryBrowserNotice | null});
  const [state, setState] = useState(empty);
  const current = () => session.active && latest.current === session;
  const update = (change: (value: ReturnType<typeof empty>) => ReturnType<typeof empty>) => {
    if (current()) setState(value => change(value.session === session ? value : empty()));
  };

  useEffect(() => {
    session.active = true;
    return () => {session.active = false; session.request = null;};
  }, [session]);

  function clear(notice: MemoryBrowserNotice | null = null) {
    session.request = null;
    update(() => ({...empty(), notice}));
  }

  async function read(load: () => Promise<T | MemoryReadFailureResult>, {preserve = false, silent = false}: ReadOptions = {}): Promise<ReadOutcome> {
    if (!current()) return 'stale';
    const request = {};
    session.request = request;
    const accepted = () => current() && session.request === request;
    update(value => ({...value, snapshot: preserve ? value.snapshot : null, busy: silent ? value.busy : true, notice: silent ? value.notice : null}));
    try {
      const snapshot = memoryReadResult(await load());
      if (!accepted()) return 'stale';
      update(value => ({...value, snapshot}));
      return 'ready';
    } catch (error) {
      if (!accepted()) return 'stale';
      const code = memoryReadFailureCode(error);
      const message = code === 'memory_read_timeout' ? '读取超时，请重试' : code ? '读取暂不可用，请重试' : unavailableMessage;
      update(value => ({...value, snapshot: code ? value.snapshot : null, notice: {message, error: true}}));
      return code ? 'failed' : 'invalid';
    } finally {
      if (accepted()) {
        session.request = null;
        update(value => ({...value, busy: false}));
      }
    }
  }

  const view = state.session === session ? state : empty();
  return {
    snapshot: view.snapshot, busy: view.busy, notice: view.notice,
    read, clear, isReading: () => session.request !== null,
    notify: (notice: MemoryBrowserNotice | null) => update(value => ({...value, notice})),
  };
}
