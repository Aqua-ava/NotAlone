import { MemoryEvolutionDetails } from './MemoryEvolutionDetails';
import { MemoryConditionsDetails, MemoryConditionsEditor, conditionEditorText, conditionEditProposal, conditionEditorValid } from './MemoryConditionsDetails';
import { memoryTimeText as timeText } from './memory-time-format';
import { MemoryEventDetails } from './MemoryEventDetails';
import { useEffect, useRef, useState } from 'react';
import type { MemoryVersion, MemoryCategory, MemoryChangeKind, OwnerLayeredMemoryState } from '../shared/memory-bridge';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { MemoryList } from './MemoryList';
import { memoryAvailability, memoryRemovalTarget } from './memory-availability';

const categoryNames = { common_fact: '共同事实', preference: '偏好', taboo: '禁忌', recent_state: '近期状态', relationship_note: '关系备注' };



function sourceTime(memory: MemoryVersion): string {
  const { sourceStartedAt: start, sourceEndedAt: end, sourceTimeComplete: complete } = memory.timing;
  if (!start || !end) return '未知（来源时间不完整）';
  const range = Date.parse(start) === Date.parse(end) ? timeText(start) : `${timeText(start)} 至 ${timeText(end)}`;
  return complete ? range : `${range}；来源时间不完整`;
}

type OwnerMemoryActions = {
  onVersions?: (entry: MemoryVersion) => Promise<void>;
  onTrace?: (entry: MemoryVersion) => void;
};

export function OwnerLayeredMemoryPanel({ onVersions, onTrace }: OwnerMemoryActions = {}) {
  const [state, setState] = useState<OwnerLayeredMemoryState>({ revision: -1, phase: 'idle', value: null, mutation: { phase: 'idle', message: '' } });
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('common_fact');
  const factsSection = useRef<HTMLElement>(null);
  const [factTarget, setFactTarget] = useState<{ memoryId: string; revision: number; editing: boolean } | null>(null);
  const revision = useRef(-1);
  useEffect(() => {
    let active = true;
    const receive = (next: OwnerLayeredMemoryState) => {
      if (active && next.revision >= revision.current) { revision.current = next.revision; setState(next); }
    };
    const unsubscribe = window.notalone.memory.onOwnerLayeredMemoryChanged(receive);
    void window.notalone.memory.getOwnerLayeredMemoryState().then(receive).catch(() => {});
    void window.notalone.memory.readOwnerMemories().catch(() => { if (active) setError('你的记忆暂不可读取，请重试。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function run(command: () => Promise<void>) {
    setError('');
    try { await command(); } catch { setError('本人资料范围或设置已变化，请重新读取后重试。'); }
  }
  const facts = (target?: { memoryId: string; revision: number }, editing = false) => {
    setFactTarget(target ? { ...target, editing } : null);
    factsSection.current?.scrollIntoView({ block: 'start' });
    void run(() => window.notalone.memory.readOwnerMemories());
  };
  const correctionTarget = state.value?.correctionTarget;
  useEffect(() => { if (correctionTarget) facts(correctionTarget, true); }, [correctionTarget?.memoryId, correctionTarget?.revision]);
  const targetMemory = state.memories?.phase === 'ready' ? state.memories.items.find(memory => memory.memoryId === factTarget?.memoryId && memory.revision === factTarget.revision) : undefined;
  return <>
    <section className="memory-section memory-facts" aria-label="我的记忆" ref={factsSection}>
      <div className="section-heading"><h2>我的记忆</h2>
        <button className="button" aria-label="刷新我的记忆" disabled={state.mutation.phase === 'working'}
          onClick={() => void run(() => window.notalone.memory.readOwnerMemories())}>刷新</button>
      </div>
      <details className="memory-disclosure memory-addition"><summary>＋ 补充一条</summary>
        <form className="memory-edit-form" aria-label="补充本人资料" onSubmit={event => {
          event.preventDefault(); setError('');
          void window.notalone.memory.addOwnerMemory({ text: text.trim(), category })
            .then(() => setText('')).catch(() => setError('本人资料保存结果未确认，请核对后重试。'));
        }}>
          <label>本人资料内容<textarea value={text} maxLength={4000} onChange={event => setText(event.target.value)} disabled={state.mutation.phase === 'working'} /></label>
          <label>资料分类<select aria-label="资料分类" value={category} disabled={state.mutation.phase === 'working'} onChange={event => setCategory(event.target.value as MemoryCategory)}>
            {Object.entries(categoryNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
          <button className="button" type="submit" disabled={!text.trim() || state.mutation.phase === 'working'}>保存本人资料</button>
        </form>
      </details>
      {(!state.memories || state.memories.phase === 'idle' || state.memories.phase === 'loading') && <p role="status">正在读取…</p>}
      {state.memories?.phase === 'error' && <p role="alert">读取失败，请刷新重试。</p>}
      {state.memories?.phase === 'ready' && state.memories.items.length === 0 && <p>还没有记住关于你的事。</p>}
      {factTarget && state.memories?.phase === 'ready'
        && !state.memories.items.some(memory => memory.memoryId === factTarget.memoryId && memory.revision === factTarget.revision)
        && <p role="alert">目标本人底层版本已变化或不可用，请重新核对资料；不会改选其他记忆。</p>}
      {targetMemory && <section aria-label="本次纠错的本人底层记忆"><h3>需要修正的记忆</h3>
        <OwnerFactCard key={`${targetMemory.memoryId}:${targetMemory.revision}`} memory={targetMemory} removalTarget={memoryRemovalTarget(targetMemory, state.memories?.items ?? [])} initiallyEditing={factTarget?.editing}
          busy={state.mutation.phase === 'working'} run={run} onVersions={onVersions} onTrace={onTrace} />
      </section>}
      {state.memories?.phase === 'ready' && <MemoryList label="我的记忆" items={state.memories.items.filter(memory => memory !== targetMemory)}>
        {memory => <OwnerFactCard key={`${memory.memoryId}:${memory.revision}`} memory={memory} removalTarget={memoryRemovalTarget(memory, state.memories?.items ?? [])}
          busy={state.mutation.phase === 'working'} run={run} onVersions={onVersions} onTrace={onTrace} />}
      </MemoryList>}
    </section>
    {state.mutation.phase !== 'idle' && <p role={state.mutation.phase === 'error' ? 'alert' : 'status'}>{state.mutation.message}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}


function OwnerFactCard({ memory, removalTarget = memory, busy, run, initiallyEditing = false, onVersions, onTrace }: OwnerMemoryActions & { memory: MemoryVersion; removalTarget?: MemoryVersion; busy: boolean; run: (command: () => Promise<void>) => Promise<void>; initiallyEditing?: boolean }) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [deleting, setDeleting] = useState(false);
  const [text, setText] = useState(memory.text);
  const [category, setCategory] = useState(memory.category);
  const [conditionText, setConditionText] = useState(conditionEditorText(memory.conditions));
  const [changeKind, setChangeKind] = useState<MemoryChangeKind>('error_correction');
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (initiallyEditing) { setEditing(true); editor.current?.focus(); editor.current?.scrollIntoView({ block: 'center' }); }
  }, [initiallyEditing]);
  const availability = memoryAvailability(memory);
  return <article className={`memory-card ${availability.excluded ? 'memory-retired' : ''}`}>
    <p className="memory-text">{availability.excluded ? <s>{memory.text}</s> : memory.text}</p>
    <p className="memory-availability">{availability.label}</p>
    <p className="memory-section-note">{memory.adoptionMethod === 'auto' ? '自动记下 · 未经你确认' : '手动记下'}</p>
    <MemoryConditionsDetails conditions={memory.conditions} />
    <MemoryEvolutionDetails evolution={memory.evolution} />
    <MemoryTemporalStatus timing={memory.timing} validAt={memory.validAt} invalidAt={memory.invalidAt} compact />
    <details className="memory-details"><summary>查看详情</summary>
      <p>版本 {memory.revision}</p><p>{memory.timing.currentStatusReason}</p>
      <p>分类：{categoryNames[memory.category]}</p>
      <p>来源聊天时间：{sourceTime(memory)}</p><p>保存时间：{timeText(memory.timing.recordedAt)}</p>
      <p>来源聊天时间表示当时说过，不保证事件在当天发生。</p>
      <MemoryEventDetails event={memory.event} />
      <p>生效时间：{memory.validAt ? timeText(memory.validAt) : '未指定'}</p>
      <p>失效时间：{memory.invalidAt ? timeText(memory.invalidAt) : '未指定'}</p>
      <p>记忆标识：{memory.memoryId}</p>
      {memory.supersedesMemoryId && <p>替代版本引用：{memory.supersedesMemoryId}</p>}
      {memory.sourceCandidateId && <p>来源候选引用：{memory.sourceCandidateId}</p>}
      <p>来源标识：{memory.sourceIds.join('、') || '来源标识不可用'}</p>
      {onTrace && <button className="button" onClick={() => onTrace(memory)}>查看来源过程</button>}
    </details>
    {memory.status === 'active' && <button className="button" aria-label="修正本人记忆" disabled={busy} onClick={() => setEditing(!editing)}>修改</button>}
    <button className="button" aria-label="删除本人记忆" disabled={busy} onClick={() => setDeleting(true)}>删除</button>
    {editing && memory.status === 'active' && <form className="memory-edit-form" onSubmit={event => { event.preventDefault();
      const conditions = conditionEditProposal(conditionText, memory.conditions);
      void run(() => window.notalone.memory.correctOwnerMemory({ memoryId: memory.memoryId, revision: memory.revision, text: text.trim(), category, changeKind, ...(conditions === undefined ? {} : { conditions }) })); }}>
      <label>修正本人记忆内容<textarea ref={editor} value={text} maxLength={4000} onChange={event => setText(event.target.value)} /></label>
      <label>资料分类<select aria-label="资料分类" value={category} disabled={busy} onChange={event => setCategory(event.target.value as MemoryCategory)}>
        {Object.entries(categoryNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <MemoryConditionsEditor value={conditionText} onChange={setConditionText} disabled={busy} />
      <label>修改原因<select aria-label="修改原因" value={changeKind} disabled={busy}
        onChange={event => setChangeKind(event.target.value as MemoryChangeKind)}>
        <option value="error_correction">纠正错误</option><option value="state_changed">记录变化</option></select></label>
      <p>{changeKind === 'error_correction' ? '原来的内容记错了。旧版只保留供查看，不再用于生成。'
        : '原来的内容曾经成立，后来发生变化。旧版将划线保留，不再引用。'}</p>
      <p>保存新的手动版本并保留来源；本次保存时间不代表变化发生时间。</p>
      <button className="button" disabled={busy || !text.trim() || !conditionEditorValid(conditionText)}>保存本人记忆修正</button>
    </form>}
    {deleting && <div role="group" aria-label="确认删除本人记忆"><p>删除这条记忆后，相关摘要也会失效。若旧条目已有替代记忆，请删除对应的当前条目以清除旧记录。此操作无法撤销。</p>
      {removalTarget.memoryId !== memory.memoryId && <p>将删除当前记忆「{removalTarget.text}」及相关旧条目。</p>}
      <button className="button" disabled={busy} onClick={() => void run(() => window.notalone.memory.deleteOwnerMemory({ memoryId: removalTarget.memoryId, revision: removalTarget.revision }))}>确认删除本人记忆</button>
      <button className="button" onClick={() => setDeleting(false)}>取消删除本人记忆</button></div>}
  </article>;
}
