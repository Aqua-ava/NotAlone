import { MemoryEvolutionDetails } from './MemoryEvolutionDetails';
import { MemoryConditionsDetails } from './MemoryConditionsDetails';
import { memoryTimeText as timeText } from './memory-time-format';
import { MemoryEventDetails } from './MemoryEventDetails';
export { MemoryEventDetails } from './MemoryEventDetails';
import { MemoryProcessingCard } from './MemoryProcessingCard';
import { FirstFrameError } from './FirstFrameError';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MemoryAdditionRequest, MemoryContent, MemoryCorrectionRequest, MemoryHistoryState, MemoryOverviewState, MemoryReadingState, MemorySection, MemorySectionName, MemorySource, MemoryVersion, OwnerFactsPreferencesOverview, PendingMemoryCandidate } from '../shared/memory-bridge';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './memory.css';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { MemoryList } from './MemoryList';
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
      // 概览/分层投影是补充信息，失败不应把记忆主列表一起标成不可用。
      await Promise.allSettled([
        window.notalone.memory.refreshOverview({ contactId: selectedContactId, scopeRevision }),
        window.notalone.memory.refreshOwnerOverview({ contactId: selectedContactId, scopeRevision }),
        window.notalone.memory.readLayeredMemory({ contactId: selectedContactId, scopeRevision }),
      ]);
    }
  }
  async function refreshOverview() {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.refreshOverview({ contactId: selectedContactId, scopeRevision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('概览范围暂不可用，请重新确认联系人。');
      }
    }
  }
  async function refreshOwnerOverview() {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.refreshOwnerOverview({ contactId: selectedContactId, scopeRevision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('本人概览暂不可用，请重新核对资料范围。');
      }
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
  async function openVersions(entry: MemoryVersion) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.openVersions({ contactId: selectedContactId, scopeRevision,
      level: entry.level, memoryId: entry.memoryId, revision: entry.revision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('版本暂不可用，请刷新资料后再查看。');
      }
    }
  }
  async function revertAutoUpdate(entry: MemoryVersion) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.revertAutoUpdate({ contactId: selectedContactId, scopeRevision,
      level: entry.level, memoryId: entry.memoryId, revision: entry.revision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('自动版本或来源已变化，请刷新后再撤销。');
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
  return { state: matches ? state : initial, error, readError, retryRead: () => { setReadError(''); setReadAttempt((value) => value + 1); }, refresh, refreshOverview, refreshOwnerOverview, readLayeredMemory, manageLayeredMemory, correct, add, remove, openVersions, revertAutoUpdate, confirmCandidate, discardCandidate, applyCandidateUpdate };
}


function sourceTime(content: MemoryContent): string {
  const { sourceStartedAt: start, sourceEndedAt: end, sourceTimeComplete: complete } = content.timing;
  if (!start || !end) return '未知（来源时间不完整）';
  const range = Date.parse(start) === Date.parse(end) ? timeText(start) : `${timeText(start)} 至 ${timeText(end)}`;
  return complete ? range : `${range}；来源时间不完整`;
}


export function MemoryCard({ content, memory, removalTarget = memory, candidate, correct, remove, confirmCandidate, discardCandidate, updateMemories, applyCandidateUpdate, busy, trace, initiallyEditing = false }: {
  content: MemoryContent; memory?: MemoryVersion; removalTarget?: MemoryVersion; candidate?: PendingMemoryCandidate; sources: MemorySection<MemorySource>;
  correct?: (entry: MemoryVersion, text: string, category: MemoryCorrectionRequest['category'], changeKind: MemoryCorrectionRequest['changeKind'], conditions?: MemoryCorrectionRequest['conditions']) => Promise<void>; remove?: (entry: MemoryVersion) => Promise<void>; confirmCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; discardCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; busy?: boolean;
  trace: (kind: TraceRecordKind, id: string, text: string) => void;
  openVersions?: (entry: MemoryVersion) => Promise<void>;
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

export function MemoryVersionHistory({ history, revert, busy }: {
  history: MemoryHistoryState; revert?: (entry: MemoryVersion) => Promise<void>; busy?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const section = useRef<HTMLElement>(null);
  const current = history.items[0];
  useEffect(() => setConfirming(false), [history.memoryId, current?.revision, current?.canRevertAutoUpdate]);
  useEffect(() => {
    if (history.phase !== 'idle') section.current?.scrollIntoView({ block: 'start' });
  }, [history.memoryId, history.phase]);
  if (history.phase === 'idle') return null;
  return <section className="memory-section memory-history" aria-label="资料版本历史" ref={section}><h2>资料版本历史</h2>
    <p>旧版保留供查看；只有曾经成立、后来发生变化的资料可作为历史参考。</p>
    {history.phase === 'loading' && <p role="status">正在核对版本和来源…</p>}
    {history.phase === 'error' && <p role="alert">版本或来源已变化，请刷新资料后再查看。</p>}
    {history.phase === 'ready' && current?.status === 'active' && current.adoptionMethod === 'auto'
      && current.canRevertAutoUpdate === true && revert && <>
      <button className="button" disabled={busy} onClick={() => setConfirming(true)}>撤销本次自动更新</button>
      {confirming && <div role="group" aria-label="确认撤销自动更新"><p>撤销当前自动版本，恢复仍有合法原始依据的上一自动版本；采纳方式仍为自动。提交时会再次核对来源。</p>
        <button className="button" disabled={busy} onClick={() => void revert(current)}>确认撤销更新并恢复旧版</button>
        <button className="button" disabled={busy} onClick={() => setConfirming(false)}>取消撤销更新</button>
      </div>}
    </>}
    {history.phase === 'ready' && history.items.map((entry) => <article className="memory-card" key={entry.memoryId}>
      <p>{entry.status === 'active' ? '当前版本' : '旧版本'} · 版本 {entry.revision} · {entry.adoptionMethod === 'auto' ? '自动采纳' : '手动采纳'}</p>
      {entry.status === 'invalidated' && <p>{entry.retirementReason === 'state_changed'
        ? '后来发生变化，可作为历史参考' : entry.retirementReason === 'error_correction'
          ? '原记录有误，已禁用于生成' : '原因未知，已禁用于生成'}</p>}
      {entry.status === 'invalidated' && entry.retiredAt && <p>退出当前资料的记录时间：{timeText(entry.retiredAt)}（不代表变化发生时间）</p>}
      <p>{entry.text}</p><p>来源聊天时间：{sourceTime(entry)}</p><p>保存时间：{timeText(entry.timing.recordedAt)}</p>
      <MemoryTemporalStatus timing={entry.timing} validAt={entry.validAt} invalidAt={entry.invalidAt} />
      <MemoryEventDetails event={entry.event} />
      <MemoryConditionsDetails conditions={entry.conditions} />
      <MemoryEvolutionDetails evolution={entry.evolution} />
      <p>记忆标识：{entry.memoryId}</p>
      {entry.supersedesMemoryId && <p>替代版本引用：{entry.supersedesMemoryId}</p>}
      {entry.supersedesMemoryId && <p>{entry.versionEvidenceSourceCurrent === true ? '原始版本依据当前有效。' : '原始版本依据未核实或已变化，不提供恢复承诺。'}</p>}
      <ul aria-label="版本来源引用">{entry.sourceIds.map((id) => <li key={id}>来源引用：{id}</li>)}</ul>
    </article>)}
  </section>;
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

export function ContactRelationshipOverview({ overview, memories, refresh, openVersions, trace, busy = false }: {
  overview: MemoryOverviewState; memories: MemorySection<MemoryVersion>; refresh: () => Promise<void>;
  openVersions: (entry: MemoryVersion) => Promise<void>; trace?: (kind: TraceRecordKind, id: string, text: string) => void; busy?: boolean;
}) {
  return <section className="memory-section memory-overview" aria-label="联系人经历与关系变化">
    <header><div><h2>联系人经历与关系变化</h2>
      <p>这是已采纳资料的投影，呈现经历与版本变化，不包含未确认推断；不进行性格或动机分析。</p></div></header>
    {(overview.phase === 'idle' || overview.phase === 'loading') && <p role="status">正在核对概览与来源…</p>}
    {overview.phase === 'error' && <div>
      <p role="alert">概览加载失败，请重试。</p>
      <button className="button" disabled={busy} onClick={() => void refresh()}>重试</button>
    </div>}
    {overview.phase === 'ready' && overview.value && <>
      <p className="memory-section-note">资料集合修订：{overview.value.memoryRevision} · 整理时间：{timeText(overview.value.builtAt)}</p>
      {overview.value.entries.length === 0 && <p>这位联系人暂无有合法依据的概览资料。</p>}
      <MemoryList items={overview.value.entries} label="概览" className="memory-cards memory-overview-entries">{(entry) => {
        const { memory: item, currentLeaf, provenance } = entry;
        const leaf = memories.phase === 'ready' && currentLeaf ? memories.items.find((memory) =>
          memory.memoryId === currentLeaf.memoryId && memory.revision === currentLeaf.revision) : undefined;
        return <article className="memory-card" key={item.memoryId}>
          <div className="memory-card-labels"><span>{entry.isLatest ? '当前版本' : '历史版本'} · {categoryNames[item.category]}</span>
            <b>{item.adoptionMethod === 'auto' ? '自动采纳（不表示用户确认）' : '手动采纳'}</b></div>
          <p className="memory-text">{item.text}</p>
          <MemoryTemporalStatus timing={item.timing} validAt={item.validAt} invalidAt={item.invalidAt} compact />
          {!entry.isLatest && <p className="memory-section-note">旧版本只记录当时的资料，不代表当前状态。</p>}
          <details className="memory-details"><summary>查看逐项来源与修订</summary>
            <p>{item.timing.currentStatusReason}</p>
            <div className="memory-times"><p>来源聊天时间：{sourceTime(item)}</p><p>保存时间：{timeText(item.timing.recordedAt)}</p></div>
            <MemoryEventDetails event={item.event} />
            <MemoryConditionsDetails conditions={item.conditions} />
            <MemoryEvolutionDetails evolution={item.evolution} />
            <p>底层资料版本：{item.revision} · 记忆标识：{item.memoryId}</p>
            <p>{provenance.kind === 'manual_entry' ? '用户手动录入（来源为手录资料）。'
              : provenance.kind === 'source_supported' ? '有来源支持，不表示已认证现实真伪。' : '来源来历未核实。'}</p>
            {provenance.references.length === 0 && <p>来源定位未知，请使用底层资料核对。</p>}
            <ul aria-label="概览来源">{provenance.references.map((reference, index) => <li key={index}>
              <p>来源引用：{reference.sourceId} · {reference.sourceKind === 'manual' ? '手录资料'
                : reference.sourceKind === 'local_wechat_observation' ? '已确认会话增量来源' : '导入来源'}</p>
              {reference.messageId && <p>消息引用：{reference.messageId}</p>}
              {reference.sourceRefId && <p>来源片段引用：{reference.sourceRefId}</p>}
              <p>来源定位：{reference.locator ?? '未知'}</p>
            </li>)}</ul>
          {trace && <button className="button" disabled={busy} onClick={() => trace('contact_memory', item.memoryId, item.text)}
            aria-label={`查看概览依据：${item.text}`}>查看依据</button>}
          {leaf ? <button className="button" disabled={busy} onClick={() => void openVersions(leaf)}
            aria-label={`查看变化依据：${item.text}`}>查看底层资料与版本历史</button>
            : <p className="memory-section-note">当前底层版本暂不可核对；此项只供回看，请刷新资料后再修正。</p>}
          <p className="memory-section-note">修正或删除请展开逐条记忆，历史记录会重新核对。</p>
          </details>
        </article>;
      }}</MemoryList>
      <details className="memory-details"><summary>查看概览修订</summary><p>概览修订：{overview.value.projectionRevision}</p></details>
    </>}
  </section>;
}

export function OwnerFactsOverview({ overview, memories, contactId, refresh, openVersions, trace, busy = false }: {
  overview: MemoryOverviewState<OwnerFactsPreferencesOverview>; memories: MemorySection<MemoryVersion>; contactId: string;
  refresh: () => Promise<void>; openVersions: (entry: MemoryVersion) => Promise<void>;
  trace?: (kind: TraceRecordKind, id: string, text: string) => void; busy?: boolean;
}) {
  return <section className="memory-section memory-overview" aria-label="本人事实与偏好概览">
    <header><div><h2>本人事实与偏好概览</h2>
      <p>这里只整理真正属于本人的已采纳事实、明确偏好与禁忌；每项沿底层资料和来源核对，不推断性格或动机。</p></div>
      <button className="button" disabled={busy || overview.phase === 'loading'} onClick={() => void refresh()}>刷新本人概览</button></header>
    {(overview.phase === 'idle' || overview.phase === 'loading') && <p role="status">正在核对本人概览与来源…</p>}
    {overview.phase === 'error' && <p role="alert">本人概览读取失败，旧概览已撤下，请刷新重试。</p>}
    {overview.phase === 'ready' && overview.value && <>
      <p className="memory-section-note">本人资料集合修订：{overview.value.memoryRevision} · 整理时间：{timeText(overview.value.builtAt)}</p>
      {overview.value.entries.length === 0 && <p>当前本人暂无有合法依据的事实与偏好概览资料。</p>}
      <MemoryList items={overview.value.entries} label="概览" className="memory-cards memory-overview-entries">{(entry) => {
        const { memory: item, currentLeaf, provenance } = entry;
        const leaf = memories.phase === 'ready' && currentLeaf ? memories.items.find((memory) => memory.level === 'owner'
          && memory.memoryId === currentLeaf.memoryId && memory.revision === currentLeaf.revision) : undefined;
        const chatReferences = provenance.references.filter((reference) => reference.sourceKind !== 'manual');
        const traceAvailable = chatReferences.length > 0 && chatReferences.every((reference) => reference.contactId === contactId);
        return <article className="memory-card" key={item.memoryId}>
          <div className="memory-card-labels"><span>{entry.isLatest ? '当前版本' : '历史版本'} · {categoryNames[item.category]}</span>
            <b>{item.adoptionMethod === 'auto' ? '自动采纳（不表示用户确认）' : '手动采纳'}</b></div>
          <p className="memory-text">{item.text}</p><MemoryTemporalStatus timing={item.timing} validAt={item.validAt} invalidAt={item.invalidAt} compact />
          {!entry.isLatest && <p className="memory-section-note">旧版本只记录当时的资料，不代表当前状态。</p>}
          <details className="memory-details"><summary>查看逐项来源与修订</summary>
            <p>{item.timing.currentStatusReason}</p>
            <div className="memory-times"><p>来源聊天时间：{sourceTime(item)}</p><p>保存时间：{timeText(item.timing.recordedAt)}</p></div>
            <MemoryEventDetails event={item.event} />
            <MemoryConditionsDetails conditions={item.conditions} />
            <MemoryEvolutionDetails evolution={item.evolution} />
            <p>底层资料版本：{item.revision} · 记忆标识：{item.memoryId}</p>
            <p>{provenance.kind === 'manual_entry' ? '用户手动录入（来源为手录资料）。'
              : provenance.kind === 'source_supported' ? '有来源支持，不表示已认证现实真伪。' : '来源来历未核实。'}</p>
            {provenance.references.length === 0 && <p>来源定位未知，请使用底层资料核对。</p>}
            <ul aria-label="本人概览来源">{provenance.references.map((reference, index) => <li key={index}>
              <p>来源引用：{reference.sourceId} · {reference.sourceKind === 'manual' ? '本人手录资料'
                : reference.sourceKind === 'local_wechat_observation' ? '已确认会话增量来源' : '导入来源'}</p>
              {reference.messageId && <p>消息引用：{reference.messageId}</p>}
              {reference.sourceRefId && <p>来源片段引用：{reference.sourceRefId}</p>}
              {reference.contactId && <p>原来源联系人标识：{reference.contactId}。请先明确选择该联系人，再核对其来源与消息。</p>}
            </li>)}</ul>
          {trace && traceAvailable && <button className="button" disabled={busy} onClick={() => trace('owner_memory', item.memoryId, item.text)}
            aria-label={`查看本人概览依据：${item.text}`}>查看依据</button>}
          {!traceAvailable && <p className="memory-section-note">{provenance.kind === 'manual_entry'
            ? '这条资料由你手动录入。' : '这条资料的完整来源尚未与当前联系人核对。'}</p>}
          {leaf ? <button className="button" disabled={busy} onClick={() => void openVersions(leaf)}
            aria-label={`查看本人变化依据：${item.text}`}>查看本人底层资料与版本历史</button>
            : <p className="memory-section-note">当前本人底层版本暂不可核对；此项只供回看，请刷新资料后再修正。</p>}
          <p className="memory-section-note">展开逐条记忆修正或删除，历史记录会重新核对。</p>
          </details>
        </article>;
      }}</MemoryList>
      <details className="memory-details"><summary>查看本人概览修订</summary><p>概览修订：{overview.value.projectionRevision}</p></details>
    </>}
  </section>;
}

// 版本历史与关系概览组合面板：只在用户展开「版本历史」时渲染，避免默认页面出现空白概览。
export function MemorySecondaryPanels({ view, history, overview, ownerOverview, memories, ownerMemories, contactId,
  openVersions, revert, refreshOverview, refreshOwnerOverview, trace, busy = false }: {
  view: 'contact' | 'owner' | 'pending'; history: MemoryHistoryState; overview: MemoryOverviewState;
  ownerOverview: MemoryOverviewState<OwnerFactsPreferencesOverview>; memories: MemorySection<MemoryVersion>;
  ownerMemories: MemorySection<MemoryVersion>; contactId: string | null;
  openVersions: (entry: MemoryVersion) => Promise<void>; revert: (entry: MemoryVersion) => Promise<void>;
  refreshOverview: () => Promise<void>; refreshOwnerOverview: () => Promise<void>;
  trace?: (kind: TraceRecordKind, id: string, text: string) => void; busy?: boolean;
}) {
  return <>
    {view === 'contact' && <ContactRelationshipOverview overview={overview} memories={memories} refresh={refreshOverview}
      openVersions={openVersions} trace={trace} busy={busy} />}
    {view === 'owner' && contactId !== null && <OwnerFactsOverview overview={ownerOverview} memories={ownerMemories} contactId={contactId}
      refresh={refreshOwnerOverview} openVersions={openVersions} trace={trace} busy={busy} />}
    {(view === 'contact' && history.level === 'contact' || view === 'owner' && history.level === 'owner')
      && <MemoryVersionHistory history={history} revert={revert} busy={busy} />}
  </>;
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
  const historyDetails = useRef<HTMLDetailsElement>(null);
  const [historySelection, setHistorySelection] = useState<{ scope: string; open: boolean } | null>(null);
  const historyOpen = historySelection?.scope === detailKey && historySelection.open;
  const openVersions = async (entry: MemoryVersion) => {
    setHistorySelection({ scope: detailKey, open: true });
    if (historyDetails.current) historyDetails.current.open = true;
    await memory.openVersions(entry);
  };
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
              trace={trace} correct={memory.correct} remove={memory.remove} openVersions={openVersions} busy={state.mutation.phase === 'working'} />)}
            {state.contact.phase === 'ready' && !state.contact.items.some(entry => entry.status === 'active' && entry.memoryId === factTarget.memoryId && entry.revision === factTarget.revision)
              && <p role="alert">目标底层版本已变化或不可用，请重新核对资料；不会改选其他记忆。</p>}
          </section>}
          <MemoryList key={scopeKey} items={state.contact.items.filter(entry => !(factTarget?.scope === scopeKey && factTarget.memoryId === entry.memoryId && factTarget.revision === entry.revision))} label="联系人记忆">{(entry) => <MemoryCard key={`${entry.memoryId}:${factTarget?.memoryId === entry.memoryId ? factTarget.editing : false}`} content={entry} memory={entry} removalTarget={memoryRemovalTarget(entry, state[entry.level].items)} sources={state.sources}
            initiallyEditing={factTarget?.scope === scopeKey && factTarget.memoryId === entry.memoryId && factTarget.revision === entry.revision && factTarget.editing}
            trace={trace} correct={memory.correct} remove={memory.remove} openVersions={openVersions} busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection></div>}
        {view === 'owner' && <ReadingSection title="我的记忆" note="" empty="还没有记住你和这位联系人交流中的事。"
          state={state.owner} retry={() => void memory.refresh('owner')}>
          <AdditionControl key={`owner:${scopeKey}`} level="owner" phase={state.mutation.phase} add={memory.add} />
          <MemoryList key={scopeKey} items={state.owner.items} label="我的记忆">{entry => <MemoryCard
            key={`${entry.memoryId}:${entry.revision}`} content={entry} memory={entry} removalTarget={memoryRemovalTarget(entry, state[entry.level].items)} sources={state.sources}
            trace={trace} correct={memory.correct} remove={memory.remove} openVersions={openVersions} busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        {view === 'pending' && <ReadingSection title="待确认候选" note="这些内容还没记住，需要你核对一下。" empty="暂时没有需要确认的内容。"
          state={state.pending} retry={() => void memory.refresh('pending')}>
          <MemoryList key={scopeKey} items={state.pending.items} label="待确认候选">{(entry) => <MemoryCard key={entry.candidateId} content={entry} candidate={entry} sources={state.sources}
            trace={trace} confirmCandidate={memory.confirmCandidate} discardCandidate={memory.discardCandidate}
            updateMemories={entry.subject === 'self' ? state.owner : state.contact} applyCandidateUpdate={memory.applyCandidateUpdate}
            busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        <details ref={historyDetails} className="memory-disclosure memory-secondary" open={historyOpen}
          onToggle={(event) => setHistorySelection({ scope: detailKey, open: event.currentTarget.open })}><summary>版本历史</summary>
          {historyOpen && <MemorySecondaryPanels view={view}
            history={state.history} overview={state.overview} ownerOverview={state.ownerOverview}
            memories={state.contact} ownerMemories={state.owner} contactId={contact?.contactId ?? null}
            openVersions={openVersions} revert={memory.revertAutoUpdate}
            refreshOverview={memory.refreshOverview} refreshOwnerOverview={memory.refreshOwnerOverview}
            trace={trace} busy={state.mutation.phase === 'working'} />}
        </details>
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
