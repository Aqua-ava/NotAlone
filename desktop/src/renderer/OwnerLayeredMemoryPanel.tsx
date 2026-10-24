import { useEffect, useState } from 'react';
import type {
  LayeredMemoryManagementOptions,
  OwnerLayeredMemoryState,
} from '../shared/memory-bridge';
import { LayeredMemorySections, type LayeredMemoryAction } from './LayeredMemorySections';

const empty: OwnerLayeredMemoryState = {
  revision: 0,
  phase: 'idle',
  value: null,
  mutation: { phase: 'idle', message: '' },
};

export function OwnerLayeredMemoryPanel() {
  const [state, setState] = useState<OwnerLayeredMemoryState>(empty);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const receive = (next: OwnerLayeredMemoryState) => {
      if (active) setState(current => next.revision < current.revision ? current : next);
    };
    const unsubscribe = window.notalone.memory.onOwnerLayeredMemoryChanged(receive);
    void window.notalone.memory.getOwnerLayeredMemoryState().then(receive)
      .catch(() => { if (active) setError('本人主题资料状态暂时无法读取。'); });
    void window.notalone.memory.readOwnerLayeredMemory({})
      .catch(() => { if (active) setError('本人主题资料暂时无法读取。'); });
    return () => {
      active = false;
      unsubscribe();
      void window.notalone.memory.releaseOwnerLayeredMemory().catch(() => {});
    };
  }, [attempt]);

  async function refresh() {
    setError('');
    try {
      await window.notalone.memory.readOwnerLayeredMemory({});
      setState(await window.notalone.memory.getOwnerLayeredMemoryState());
    } catch {
      setError('本人主题资料暂时无法读取。');
    }
  }

  async function manage(action: LayeredMemoryAction, options: LayeredMemoryManagementOptions) {
    const value = state.value;
    if (!value) throw new Error('本人主题资料尚未读取。');
    setError('');
    await window.notalone.memory.manageOwnerLayeredMemory({
      action,
      settingsGeneration: value.settingsGeneration,
      ...options,
    });
    setState(await window.notalone.memory.getOwnerLayeredMemoryState());
  }

  const busy = state.mutation.phase === 'working';
  return <section className="memory-section" aria-label="本人主题资料">
    <header><div><h2>本人主题背景</h2><p>只整理你本人已采纳且有有效来源的资料，不混入某位联系人的专属结论。</p></div>
      <button className="button" disabled={state.phase === 'loading' || busy} onClick={() => setAttempt(value => value + 1)}>
        重新读取本人主题
      </button></header>
    {(state.phase === 'idle' || state.phase === 'loading') && <p className="memory-section-note" role="status">正在读取本人主题资料…</p>}
    {state.phase === 'error' && <p role="alert">本人主题资料读取失败。
      <button className="button" onClick={() => void refresh()}>重试</button></p>}
    {error && <p role="alert">{error}</p>}
    {state.phase === 'ready' && state.value && <>
      {state.value.scenarios.length === 0 && !state.value.profile && <p className="memory-section-note">还没有整理好的本人主题资料。</p>}
      <LayeredMemorySections state={state} manage={manage} busy={busy} />
    </>}
    {state.mutation.phase !== 'idle' && <p role={state.mutation.phase === 'error' ? 'alert' : 'status'}>{state.mutation.message}</p>}
  </section>;
}
