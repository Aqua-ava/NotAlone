import { useEffect, useRef, useState } from 'react';
import type { ActiveMemory, MemoryChangeKind, OwnerLayeredMemoryManagementRequest, OwnerLayeredMemoryState } from '../shared/memory-bridge';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { LayeredMemoryPanel } from './LayeredMemoryPanel';

export function OwnerLayeredMemoryPanel({ onFacts }: { onFacts?: () => void } = {}) {
  const [state, setState] = useState<OwnerLayeredMemoryState>({ revision: -1, phase: 'idle', value: null, mutation: { phase: 'idle', message: '' } });
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [showFacts, setShowFacts] = useState(false);
  const [factTarget, setFactTarget] = useState<{ memoryId: string; revision: number; editing: boolean } | null>(null);
  const revision = useRef(-1);
  useEffect(() => {
    let active = true;
    const receive = (next: OwnerLayeredMemoryState) => {
      if (active && next.revision >= revision.current) { revision.current = next.revision; setState(next); }
    };
    const unsubscribe = window.notalone.memory.onOwnerLayeredMemoryChanged(receive);
    void window.notalone.memory.getOwnerLayeredMemoryState().then(receive).catch(() => {});
    void window.notalone.memory.readOwnerLayeredMemory({}).catch(() => { if (active) setError('本人资料暂不可读取，请重试。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function run(command: () => Promise<void>) {
    setError('');
    try { await command(); } catch { setError('本人资料范围或设置已变化，请重新读取后重试。'); }
  }
  const facts = (target?: { memoryId: string; revision: number }, editing = false) => {
    if (onFacts && !target) { onFacts(); return; }
    setFactTarget(target ? { ...target, editing } : null); setShowFacts(true); void run(() => window.notalone.memory.readOwnerMemories());
  };
  const correctionTarget = state.value?.correctionTarget;
  useEffect(() => { if (correctionTarget) facts(correctionTarget, true); }, [correctionTarget?.memoryId, correctionTarget?.revision]);
  return <>
    <LayeredMemoryPanel owner state={state} contactName="本人" busy={state.mutation.phase === 'working'} facts={facts}
      read={mappingCursor => run(() => window.notalone.memory.readOwnerLayeredMemory({ mappingCursor }))}
      manage={(action, settingsGeneration, options) => run(() => window.notalone.memory.manageOwnerLayeredMemory({ action, settingsGeneration, ...options } as OwnerLayeredMemoryManagementRequest))} />
    <details className="memory-disclosure"><summary>补充本人资料</summary>
    <form className="memory-section memory-edit-form" aria-label="补充本人资料" onSubmit={event => {
      event.preventDefault(); setError('');
      void window.notalone.memory.addOwnerMemory({ text: text.trim(), category: 'common_fact' })
        .then(() => setText('')).catch(() => setError('本人资料保存结果未确认，请核对后重试。'));
    }}>
      <h2>补充本人资料</h2><p>补充你的经历、偏好，帮助助手更了解你。</p>
      <label>本人资料内容<textarea value={text} maxLength={4000} onChange={event => setText(event.target.value)} disabled={state.mutation.phase === 'working'} /></label>
      <button className="button" type="submit" disabled={!text.trim() || state.mutation.phase === 'working'}>保存本人资料</button>
    </form></details>
    {showFacts && <section className="memory-section" aria-label="本人底层记忆">
      <h2>本人底层记忆</h2><p>仅当前本人的已采纳资料；自动采纳不代表用户确认。</p>
      <button className="button" disabled={state.mutation.phase === 'working'} onClick={() => void run(() => window.notalone.memory.readOwnerMemories())}>重新读取本人底层记忆</button>
      {state.memories?.phase === 'loading' && <p role="status">正在读取本人底层记忆…</p>}
      {state.memories?.phase === 'error' && <p role="alert">本人底层记忆读取失败，旧内容已撤下。</p>}
      {state.memories?.phase === 'ready' && state.memories.items.length === 0 && <p>暂无本人底层记忆。</p>}
      {factTarget && <section aria-label="本次纠错的本人底层记忆"><h3>本次纠错的本人底层记忆</h3>
        {state.memories?.phase === 'ready' && state.memories.items.filter(memory => memory.memoryId === factTarget.memoryId && memory.revision === factTarget.revision)
          .map(memory => <OwnerFactCard key={`${memory.memoryId}:${memory.revision}`} memory={memory} initiallyEditing={factTarget.editing} busy={state.mutation.phase === 'working'} run={run} />)}
        {state.memories?.phase === 'ready' && !state.memories.items.some(memory => memory.memoryId === factTarget.memoryId && memory.revision === factTarget.revision)
          && <p role="alert">目标本人底层版本已变化或不可用，请重新核对资料；不会改选其他记忆。</p>}
      </section>}
      {state.memories?.phase === 'ready' && state.memories.items.map(memory => <OwnerFactCard key={`${memory.memoryId}:${memory.revision}`} memory={memory}
        busy={state.mutation.phase === 'working'} run={run} />)}
    </section>}
    {state.mutation.phase !== 'idle' && <p role={state.mutation.phase === 'error' ? 'alert' : 'status'}>{state.mutation.message}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}


function OwnerFactCard({ memory, busy, run, initiallyEditing = false }: { memory: ActiveMemory; busy: boolean; run: (command: () => Promise<void>) => Promise<void>; initiallyEditing?: boolean }) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [deleting, setDeleting] = useState(false);
  const [text, setText] = useState(memory.text);
  const [changeKind, setChangeKind] = useState<MemoryChangeKind>('error_correction');
  return <article className="memory-card">
    <p className="memory-text">{memory.text}</p>
    <p>采纳方式：{memory.adoptionMethod === 'auto' ? '系统自动采纳，非用户确认' : '手动采纳'} · 版本 {memory.revision}</p>
    <MemoryTemporalStatus timing={memory.timing} />
    <details className="memory-details"><summary>查看本人记忆依据标识</summary><p>记忆标识：{memory.memoryId}</p>
      <p>来源标识：{memory.sourceIds.join('、') || '来源标识不可用'}</p></details>
    <button className="button" disabled={busy} onClick={() => setEditing(!editing)}>修正本人记忆</button>
    <button className="button" disabled={busy} onClick={() => setDeleting(true)}>删除本人记忆</button>
    {editing && <form className="memory-edit-form" onSubmit={event => { event.preventDefault(); void run(() => window.notalone.memory.correctOwnerMemory({ memoryId: memory.memoryId, revision: memory.revision, text: text.trim(), category: memory.category, changeKind })); }}>
      <label>修正本人记忆内容<textarea value={text} maxLength={4000} onChange={event => setText(event.target.value)} /></label>
      <label>修改原因<select aria-label="修改原因" value={changeKind} disabled={busy}
        onChange={event => setChangeKind(event.target.value as MemoryChangeKind)}>
        <option value="error_correction">纠正错误</option><option value="state_changed">记录变化</option></select></label>
      <p>{changeKind === 'error_correction' ? '原来的内容记错了。旧版只保留供查看，不再用于生成。'
        : '原来的内容曾经成立，后来发生变化。旧版可作为历史参考。'}</p>
      <p>保存新的手动版本并保留来源；本次保存时间不代表变化发生时间。</p>
      <button className="button" disabled={busy || !text.trim()}>保存本人记忆修正</button>
    </form>}
    {deleting && <div role="group" aria-label="确认删除本人记忆"><p>删除该底层记忆，并使依赖它的整理资料失效。</p>
      <button className="button" disabled={busy} onClick={() => void run(() => window.notalone.memory.deleteOwnerMemory({ memoryId: memory.memoryId, revision: memory.revision }))}>确认删除本人记忆</button>
      <button className="button" onClick={() => setDeleting(false)}>取消删除本人记忆</button></div>}
  </article>;
}
