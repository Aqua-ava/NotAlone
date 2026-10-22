import { MemoryProcessingCard } from './MemoryProcessingCard';
import { FirstFrameError } from './FirstFrameError';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MemoryAdditionRequest, MemoryContent, MemoryCorrectionRequest, MemoryReadingState, MemorySection, MemorySectionName, MemorySource, MemoryVersion, PendingMemoryCandidate } from '../shared/memory-bridge';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './memory.css';
import { MemoryList } from './MemoryList';
import { LayeredMemorySections } from './LayeredMemorySections';
import { memoryAvailability, memoryRemovalTarget } from './memory-availability';
import type { LayeredMemoryManagementRequest, LayeredMemoryManagementOptions } from '../shared/memory-bridge';
import { MemoryEvidence } from './MemoryEvidence';
import type { TraceRecordKind } from '../shared/trace-bridge';
import { UpdateBackupCleanupRecovery } from './UpdateBackupDeletionNotice';

const initial: MemoryReadingState = { revision: -1, contactId: null, scopeRevision: 0, mutation: { phase: 'idle', message: '' },
  contact: { phase: 'idle', items: [] }, owner: { phase: 'idle', items: [] },
  pending: { phase: 'idle', items: [] }, sources: { phase: 'idle', items: [] },
  history: { phase: 'idle', items: [], memoryId: null, level: null }, overview: { phase: 'idle', value: null },
  ownerOverview: { phase: 'idle', value: null }, layeredMemory: { phase: 'idle', value: null } };
const categoryNames = { common_fact: '共同事实', preference: '偏好', taboo: '禁忌', recent_state: '近期状态', relationship_note: '关系备注' };

function useMemoryReading(session: ContactSessionView) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const active = useRef(true);
  const latest = useRef(initial);
  const scope = useRef(session.state);
  scope.current = session.state;
  useEffect(() => {
    active.current = true;
    const receive = (next: MemoryReadingState) => {
      if (!active.current || next.revision < latest.current.revision) return;
      latest.current = next;
      setReadError('');
      setState(next);
    };
    const unsubscribe = window.notalone.memory.onStateChanged(receive);
    void window.notalone.memory.getState().then(receive)
      .catch(() => { if (active.current) setReadError('资料状态暂时无法读取，请重试。'); });
    return () => { active.current = false; unsubscribe(); };
  }, [readAttempt]);
  async function refresh(section?: MemorySectionName) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try {
      await window.notalone.memory.refresh({ contactId: selectedContactId, scopeRevision, ...(section ? { section } : {}) });
    } catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围暂不可用，请重新确认联系人。');
      }
      return;
    }
    if (!section) {
      // 分层投影是补充信息，失败不应把记忆主列表一起标成不可用。
      await window.notalone.memory.readLayeredMemory({ contactId: selectedContactId, scopeRevision });
    }
  }
  async function readLayeredMemory(mappingCursor: string | null = null) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.readLayeredMemory({ contactId: selectedContactId, scopeRevision, mappingCursor }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('主题资料范围暂不可用，请重新核对联系人。');
      }
    }
  }
  async function manageLayeredMemory(action: LayeredMemoryManagementRequest['action'], settingsGeneration: number, options?: LayeredMemoryManagementOptions) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.manageLayeredMemory({ contactId: selectedContactId, scopeRevision, action, settingsGeneration,
      ...options }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('主题资料范围或设置已变化，请重新读取后重试。');
      }
    }
  }
  useEffect(() => {
    setError('');
    if (session.state.selectedContactId) void refresh();
    const { selectedContactId, scopeRevision } = session.state;
    return () => {
      if (selectedContactId) void window.notalone.memory.releaseLayeredMemory({ contactId: selectedContactId, scopeRevision }).catch(() => {});
    };
  }, [session.state.selectedContactId, session.state.scopeRevision]);
  async function correct(entry: MemoryVersion, text: string, category: MemoryCorrectionRequest['category'], changeKind: MemoryCorrectionRequest['changeKind'], conditions?: MemoryCorrectionRequest['conditions']) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.correct({ contactId: selectedContactId, scopeRevision, level: entry.level,
      memoryId: entry.memoryId, revision: entry.revision, text, category, changeKind, ...(conditions === undefined ? {} : { conditions }) }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围或版本已变化，请刷新后再修正。');
      }
    }
  }
  async function add(level: MemoryAdditionRequest['level'], text: string, category: MemoryAdditionRequest['category']) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.add({ contactId: selectedContactId, scopeRevision, level, text, category }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围已变化，请刷新后再补充。');
      }
    }
  }
  async function remove(entry: MemoryVersion) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.remove({ contactId: selectedContactId, scopeRevision, level: entry.level,
      memoryId: entry.memoryId, revision: entry.revision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围或版本已变化，请刷新后再删除。');
      }
    }
  }
  async function confirmCandidate(entry: PendingMemoryCandidate) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.confirmCandidate({ contactId: selectedContactId, scopeRevision, candidateId: entry.candidateId }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('候选范围已变化，请刷新后再确认。');
      }
    }
  }
  async function discardCandidate(entry: PendingMemoryCandidate) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.discardCandidate({ contactId: selectedContactId, scopeRevision, candidateId: entry.candidateId }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('候选范围已变化，请刷新后再丢弃。');
      }
    }
  }
  async function applyCandidateUpdate(entry: PendingMemoryCandidate, previous: MemoryVersion) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.applyCandidateUpdate({ contactId: selectedContactId, scopeRevision,
      candidateId: entry.candidateId, previousMemoryId: previous.memoryId, expectedRevision: previous.revision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('所选候选或旧版已变化，请刷新后再应用。');
      }
    }
  }
  const matches = state.contactId === session.state.selectedContactId && state.scopeRevision === session.state.scopeRevision;
  return { state: matches ? state : initial, error, readError, retryRead: () => { setReadError(''); setReadAttempt((value) => value + 1); }, refresh, readLayeredMemory, manageLayeredMemory, correct, add, remove, confirmCandidate, discardCandidate, applyCandidateUpdate };
}

export function MemoryCard({ content, memory, removalTarget = memory, candidate, correct, remove, confirmCandidate, discardCandidate, updateMemories, applyCandidateUpdate, busy, trace, initiallyEditing = false }: {
  content: MemoryContent; memory?: MemoryVersion; removalTarget?: MemoryVersion; candidate?: PendingMemoryCandidate; sources: MemorySection<MemorySource>;
  correct?: (entry: MemoryVersion, text: string, category: MemoryCorrectionRequest['category'], changeKind: MemoryCorrectionRequest['changeKind'], conditions?: MemoryCorrectionRequest['conditions']) => Promise<void>; remove?: (entry: MemoryVersion) => Promise<void>; confirmCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; discardCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; busy?: boolean;
  trace: (kind: TraceRecordKind, id: string, text: string) => void;
  updateMemories?: MemorySection<MemoryVersion>;
  applyCandidateUpdate?: (entry: PendingMemoryCandidate, previous: MemoryVersion) => Promise<void>;
  initiallyEditing?: boolean;
}) {
  const displayText = content.text.replace(/\bself\b/g, '我').replace(/\bcontact\b/g, '对方');
  const [editing, setEditing] = useState(initiallyEditing);
  const [removing, setRemoving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [text, setText] = useState(displayText);
  const moreActions = useRef<HTMLDetailsElement>(null);
  const availability = memory ? memoryAvailability(memory) : null;
  const retired = availability?.excluded === true;
  const unavailable = retired || (memory?.validAt && Date.parse(memory.validAt) > Date.now());
  function closeMenu() {
    if (moreActions.current) moreActions.current.open = false;
  }
  return <article className={`memory-card ${candidate ? 'memory-pending' : ''} ${retired ? 'memory-retired' : ''}`}>
    <div className="memory-card-summary">
      <p className="memory-text">{retired ? <s>{displayText}</s> : displayText}</p>
      <details className="memory-more" ref={moreActions}>
        <summary aria-label={`更多操作：${displayText}`}>⋯</summary>
        <div className="memory-more-actions">
          <button className="button" aria-label={`查看依据：${displayText}`} onClick={() => {
            closeMenu();
            if (candidate) trace('candidate', candidate.candidateId, content.text);
            else if (memory) trace(memory.level === 'owner' ? 'owner_memory' : 'contact_memory', memory.memoryId, content.text);
          }}>查看依据</button>
          {memory?.status === 'active' && correct && <button className="button" disabled={busy}
            aria-label={`修正资料：${displayText}`} onClick={() => { closeMenu(); setRemoving(false); setEditing(true); }}>编辑</button>}
          {memory && remove && <button className="button" disabled={busy}
            aria-label={`${memory.adoptionMethod === 'auto' ? '撤销自动采纳' : '删除资料'}：${displayText}`}
            onClick={() => { closeMenu(); setEditing(false); setRemoving(true); }}>移除</button>}
        </div>
      </details>
    </div>
    {availability && unavailable && <p className="memory-availability">{availability.label}</p>}
    {content.evolution?.kind === 'unresolved_conflict' && <p className="memory-availability">有矛盾，请核对依据。</p>}
    {candidate && <p className="memory-subject">尚未记住 · 关于{candidate.subject === 'self' ? '我' : candidate.subject === 'contact' ? '对方' : '我们'}</p>}
    {Boolean(candidate?.correctionReview?.length) && <p className="memory-availability">涉及此前人工决定，请先核对依据。</p>}
    {editing && memory?.status === 'active' && correct && <form aria-label={memory.level === 'owner' ? '修正本人资料' : '修正联系人资料'} className="memory-edit-form" onSubmit={(event) => {
      event.preventDefault(); void correct(memory, text, content.category, 'error_correction');
    }}><label>记忆内容<textarea aria-label="资料正文" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /></label>
      <button className="button" type="submit" aria-label="保存修正" disabled={busy || !text.trim()}>保存</button>
      <button className="button" type="button" aria-label="取消修正" disabled={busy} onClick={() => setEditing(false)}>取消</button>
    </form>}
    {removing && memory && remove && <div className="memory-edit-form" role="group" aria-label="确认删除资料">
      <p>确定移除这条记忆？</p>
      {removalTarget && removalTarget.memoryId !== memory.memoryId && <p>将删除当前记忆「{removalTarget.text}」及相关旧条目。</p>}
      <button className="button" disabled={busy} onClick={() => void remove(removalTarget ?? memory)}>{memory.adoptionMethod === 'auto' ? '确认撤销' : '确认删除'}</button>
      <button className="button" disabled={busy} onClick={() => setRemoving(false)}>取消删除</button>
    </div>}
    {candidate && confirmCandidate && <button className="button" disabled={busy}
      aria-label={`确认并保存：${content.text}`} onClick={() => void confirmCandidate(candidate)}>记住</button>}
    {candidate && updateMemories && applyCandidateUpdate && <PendingMemoryUpdate candidate={candidate}
      memories={updateMemories} apply={applyCandidateUpdate} busy={busy} />}
    {candidate && discardCandidate && <button className="button" disabled={busy}
      aria-label={`丢弃候选：${content.text}`} onClick={() => setDiscarding(true)}>不记住</button>}
    {discarding && candidate && discardCandidate && <div className="memory-edit-form" role="group" aria-label="确认丢弃候选">
      <p>丢弃这条待确认候选，不采纳为长期资料；来源消息仍保留。</p>
      <button className="button" disabled={busy} onClick={() => void discardCandidate(candidate)}>确认丢弃</button>
      <button className="button" disabled={busy} onClick={() => setDiscarding(false)}>取消丢弃</button>
    </div>}
  </article>;
}

export function PendingMemoryUpdate({ candidate, memories, apply, busy }: {
  candidate: PendingMemoryCandidate; memories: MemorySection<MemoryVersion>; busy?: boolean;
  apply: (candidate: PendingMemoryCandidate, previous: MemoryVersion) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const available = memories.items.filter(entry => entry.status === 'active' && !memoryAvailability(entry).excluded);
  const previous = available.find((entry) => `${entry.memoryId}:${entry.revision}` === selected);
  useEffect(() => setSelected(''), [candidate.candidateId, memories.phase]);
  if (memories.phase !== 'ready' || available.length === 0) return null;
  return <details className="memory-details"><summary>更新已有记忆</summary><form className="memory-edit-form" aria-label={`应用候选更新：${candidate.text}`} onSubmit={(event) => {
    event.preventDefault(); if (previous) void apply(candidate, previous);
  }}>
    <label>选择要更新的当前资料<select aria-label="选择要更新的当前资料" value={previous ? selected : ''}
      disabled={busy} onChange={(event) => setSelected(event.target.value)}>
      <option value="">请先选择并核对旧资料</option>
      {available.map((entry) => <option key={entry.memoryId} value={`${entry.memoryId}:${entry.revision}`}>{entry.text}（版本 {entry.revision}）</option>)}
    </select></label>
    {previous && <p>所选旧版：{previous.text}（版本 {previous.revision}）。请核对本次变化和新候选的来源。</p>}
    <p>确认后保存为手动新版本，旧条目划线保留且不再引用；进展变化不表示旧资料当时有误。</p>
    <button className="button" type="submit" disabled={busy || !previous}>确认应用为新版本</button>
  </form></details>;
}

function AdditionControl({ level, phase, add }: {
  level: 'owner' | 'contact'; phase: MemoryReadingState['mutation']['phase'];
  add: (level: MemoryAdditionRequest['level'], text: string, category: MemoryAdditionRequest['category']) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [category, setCategory] = useState<MemoryAdditionRequest['category']>('common_fact');
  const name = level === 'owner' ? '补充本人资料' : '补充联系人资料';
  const busy = phase === 'working';
  useEffect(() => { if (phase === 'success') { setOpen(false); setText(''); } }, [phase]);
  return <div className="memory-addition"><button className="button" aria-label={name} disabled={busy} onClick={() => setOpen(true)}>＋ 补充一条</button>
    {open && <form className="memory-edit-form" aria-label={name} onSubmit={(event) => { event.preventDefault(); void add(level, text, category); }}>
      <label>资料正文<textarea aria-label="资料正文" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /></label>
      <label>资料分类<select aria-label="资料分类" value={category} disabled={busy}
        onChange={(event) => setCategory(event.target.value as MemoryAdditionRequest['category'])}>
        {Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p>{level === 'owner' ? '这条本人资料会关联当前联系人，显示在你们的记忆里。' : '只保存到当前已确认联系人的资料。'}手动补充不会成为自动采纳。</p>
      <button className="button" type="submit" disabled={busy || !text.trim()}>保存资料</button>
      <button className="button" type="button" disabled={busy} onClick={() => setOpen(false)}>取消补充</button>
    </form>}
  </div>;
}

function ReadingSection<T>({ title, note, empty, state, retry, children }: {
  title: string; note: string; empty: string; state: MemorySection<T>; retry: () => void; children: ReactNode;
}) {
  return <section className="memory-section" aria-label={title}>
    <header><div><h2>{title === '联系人记忆' ? '记住的事' : title === '待确认候选' ? '需要你确认' : title}</h2>{note && <p>{note}</p>}</div>
      {(state.phase === 'error' || !['联系人记忆', '待确认候选'].includes(title)) &&
        <button className="button" disabled={state.phase === 'loading'} onClick={retry} aria-label={`重新读取${title}`}>刷新</button>}</header>
    {(state.phase === 'loading' || state.phase === 'idle') && <p className="memory-section-note" role="status">正在读取{title}…</p>}
    {state.phase === 'error' && <p className="memory-section-note" role="alert">{title}读取失败，请重试。</p>}
    {state.phase === 'ready' && (<>{state.items.length === 0 && <p className="memory-section-note">{empty}</p>}{children}</>)}
  </section>;
}


const memoryViews = { contact: '对方', owner: '我', pending: '待确认' } as const;
type MemoryView = keyof typeof memoryViews;

export function MemoryPage({ session, navigate }: { session: ContactSessionView; navigate: (page: ManagerPage) => void }) {
  const memory = useMemoryReading(session);
  const scopeKey = `${session.state.selectedContactId}:${session.state.scopeRevision}`;
  const [view, selectView] = useState<MemoryView>('contact');
  const [factTarget, setFactTarget] = useState<{ scope: string; memoryId: string; revision: number; editing: boolean } | null>(null);
  const detailKey = `${scopeKey}:${view}`;
  const [evidenceTarget, setEvidenceTarget] = useState<{ scope: string; kind: TraceRecordKind; id: string; text: string } | null>(null);
  const evidencePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (evidenceTarget?.scope === detailKey) evidencePanel.current?.scrollIntoView({ block: 'nearest' });
  }, [evidenceTarget, detailKey]);
  const factsDetails = useRef<HTMLDivElement>(null);
  const revealFacts = () => {
    if (factsDetails.current) {
      factsDetails.current.scrollIntoView({ block: 'start' });
    }
  };
  const openFact = (target?: { memoryId: string; revision: number }, editing = false) => {
    setFactTarget(target ? { scope: scopeKey, ...target, editing } : null);
    selectView('contact');
    revealFacts();
    void memory.refresh('contact');
  };
  useEffect(() => {
    if (factTarget?.scope === scopeKey) revealFacts();
  }, [factTarget, scopeKey]);
  const correctionTarget = memory.state.layeredMemory.value?.correctionTarget;
  useEffect(() => {
    if (correctionTarget && memory.state.contactId === session.state.selectedContactId) openFact(correctionTarget, true);
  }, [correctionTarget?.memoryId, correctionTarget?.revision, scopeKey]);
  const trace = (kind: TraceRecordKind, id: string, text: string) => setEvidenceTarget({ scope: detailKey, kind, id, text });
  const contact = session.state.contacts.find((entry) => entry.contactId === session.state.selectedContactId);
  const { state } = memory;
  return <div className="memory-page">
    <div className="memory-navigation"><nav className="memory-tabs" aria-label="记忆分类">{(Object.keys(memoryViews) as MemoryView[]).map((name) =>
      <button key={name} aria-pressed={view === name} onClick={() => selectView(name)}>{memoryViews[name]}</button>)}</nav>
    <div className="memory-toolbar"><button className="button" disabled={!contact || [state.contact, state.owner, state.pending, state.sources].some((section) => section.phase === 'loading')}
        onClick={() => void memory.refresh()}>刷新记忆</button></div>
    </div>
    <div className="memory-view-content" key={`${scopeKey}:${view}`}>
    <MemoryProcessingCard request={contact ? { scope: 'contact', contactId: contact.contactId, scopeRevision: session.state.scopeRevision } : undefined}
      contactNames={Object.fromEntries(session.state.contacts.map(contact => [contact.contactId, contact.displayName]))}
      onProgress={contact ? () => window.notalone.memory.refreshProcessingResults({ scope: 'contact', contactId: contact.contactId,
        scopeRevision: session.state.scopeRevision }) : undefined}>
    {!contact ? <section className="memory-no-contact" aria-label="资料范围未确认"><h2>选择一位联系人</h2>
      <p>请在顶部选择联系人，再查看你们之间记住的事。</p>
      {session.state.contacts.length === 0 && <button className="button" onClick={() => navigate('contacts')}>添加联系人</button>}</section>
      : <>
        {view === 'contact' && <div ref={factsDetails} className="memory-facts"><ReadingSection title="联系人记忆" note="" empty="还没有记住关于对方的事。"
          state={state.contact} retry={() => void memory.refresh('contact')}>
          <AdditionControl key={`contact:${state.scopeRevision}`} level="contact" phase={state.mutation.phase} add={memory.add} />
          {factTarget?.scope === scopeKey && <section aria-label="本次纠错的底层记忆"><h3>修改这条记忆</h3>
            {state.contact.items.filter(entry => entry.status === 'active' && entry.memoryId === factTarget.memoryId && entry.revision === factTarget.revision).map(entry => <MemoryCard
              key={`${entry.memoryId}:${entry.revision}`} content={entry} memory={entry} removalTarget={memoryRemovalTarget(entry, state[entry.level].items)} sources={state.sources} initiallyEditing={factTarget.editing}
              trace={trace} correct={memory.correct} remove={memory.remove} busy={state.mutation.phase === 'working'} />)}
            {state.contact.phase === 'ready' && !state.contact.items.some(entry => entry.status === 'active' && entry.memoryId === factTarget.memoryId && entry.revision === factTarget.revision)
              && <p role="alert">目标底层版本已变化或不可用，请重新核对资料；不会改选其他记忆。</p>}
          </section>}
          <MemoryList key={scopeKey} items={state.contact.items.filter(entry => !(factTarget?.scope === scopeKey && factTarget.memoryId === entry.memoryId && factTarget.revision === entry.revision))} label="联系人记忆">{(entry) => <MemoryCard key={`${entry.memoryId}:${factTarget?.memoryId === entry.memoryId ? factTarget.editing : false}`} content={entry} memory={entry} removalTarget={memoryRemovalTarget(entry, state[entry.level].items)} sources={state.sources}
            initiallyEditing={factTarget?.scope === scopeKey && factTarget.memoryId === entry.memoryId && factTarget.revision === entry.revision && factTarget.editing}
            trace={trace} correct={memory.correct} remove={memory.remove} busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>
          <LayeredMemorySections state={state.layeredMemory} />
        </div>}
        {view === 'owner' && <ReadingSection title="我的记忆" note="" empty="还没有记住你和这位联系人交流中的事。"
          state={state.owner} retry={() => void memory.refresh('owner')}>
          <AdditionControl key={`owner:${scopeKey}`} level="owner" phase={state.mutation.phase} add={memory.add} />
          <MemoryList key={scopeKey} items={state.owner.items} label="我的记忆">{entry => <MemoryCard
            key={`${entry.memoryId}:${entry.revision}`} content={entry} memory={entry} removalTarget={memoryRemovalTarget(entry, state[entry.level].items)} sources={state.sources}
            trace={trace} correct={memory.correct} remove={memory.remove} busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        {view === 'pending' && <ReadingSection title="待确认候选" note="这些内容还没记住，需要你核对一下。" empty="暂时没有需要确认的内容。"
          state={state.pending} retry={() => void memory.refresh('pending')}>
          <MemoryList key={scopeKey} items={state.pending.items} label="待确认候选">{(entry) => <MemoryCard key={entry.candidateId} content={entry} candidate={entry} sources={state.sources}
            trace={trace} confirmCandidate={memory.confirmCandidate} discardCandidate={memory.discardCandidate}
            updateMemories={entry.subject === 'self' ? state.owner : state.contact} applyCandidateUpdate={memory.applyCandidateUpdate}
            busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        {evidenceTarget?.scope === detailKey && <div ref={evidencePanel}>
          <MemoryEvidence key={`${scopeKey}:${evidenceTarget.kind}:${evidenceTarget.id}`} session={session}
            kind={evidenceTarget.kind} recordId={evidenceTarget.id} text={evidenceTarget.text} onClose={() => setEvidenceTarget(null)} />
        </div>}

      </>}
    </MemoryProcessingCard>
    </div>
    {state.mutation.phase !== 'idle' && <p className="memory-section-note" role={state.mutation.phase === 'error' ? 'alert' : 'status'}>{state.mutation.message}</p>}
    {state.mutation.backupCleanupRequired && <UpdateBackupCleanupRecovery />}
    {memory.error && <p className="memory-section-note" role="alert">{memory.error}</p>}
    <FirstFrameError message={memory.readError} retry={memory.retryRead} />
    {session.error && <p className="memory-section-note" role="alert">{session.error}</p>}
  </div>;
}
