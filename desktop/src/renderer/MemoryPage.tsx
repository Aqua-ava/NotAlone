import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActiveMemory, MemoryAdditionRequest, MemoryContent, MemoryCorrectionRequest, MemoryEvent, MemoryHistoryState, MemoryOverviewState, MemoryReadingState, MemorySection, MemorySectionName, MemorySource, MemoryVersion, OwnerFactsPreferencesOverview, PendingMemoryCandidate } from '../shared/memory-bridge';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './memory.css';
import { SourceDeletionPanel } from './SourceDeletionPanel';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { MemoryList } from './MemoryList';
import { LayeredMemoryPanel } from './LayeredMemoryPanel';
import type { LayeredMemoryManagementRequest } from '../shared/memory-bridge';
import { TracePanel, useTraceReading } from './TracePanel';
import type { TraceRecordKind } from '../shared/trace-bridge';
import { UpdateBackupCleanupRecovery } from './UpdateBackupDeletionNotice';

const initial: MemoryReadingState = { revision: -1, contactId: null, scopeRevision: 0, mutation: { phase: 'idle', message: '' },
  contact: { phase: 'idle', items: [] }, owner: { phase: 'idle', items: [] },
  pending: { phase: 'idle', items: [] }, sources: { phase: 'idle', items: [] },
  history: { phase: 'idle', items: [], memoryId: null, level: null }, overview: { phase: 'idle', value: null },
  ownerOverview: { phase: 'idle', value: null }, layeredMemory: { phase: 'idle', value: null } };
const categoryNames = { common_fact: '共同事实', preference: '偏好', taboo: '禁忌', recent_state: '近期状态', relationship_note: '关系备注' };
const topicNames = { health: '健康', work: '工作', family: '家庭', travel: '旅行', finance: '财务', study: '学习', emotion: '情绪', other: '其他' };
const subjectNames = { self: '本人', contact: '联系人', shared: '双方' };
const sourceNames = { active: '有效', delete_requested: '已请求删除', deleting: '正在删除', delete_failed: '删除失败', deleted: '已标记删除' };

function useMemoryReading(session: ContactSessionView) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const active = useRef(true);
  const latest = useRef(initial);
  const scope = useRef(session.state);
  scope.current = session.state;
  useEffect(() => {
    active.current = true;
    const receive = (next: MemoryReadingState) => {
      if (!active.current || next.revision < latest.current.revision) return;
      latest.current = next;
      setState(next);
    };
    const unsubscribe = window.notalone.memory.onStateChanged(receive);
    void window.notalone.memory.getState().then(receive).catch(() => {});
    return () => { active.current = false; unsubscribe(); };
  }, []);
  async function refresh(section?: MemorySectionName) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try {
      await Promise.all([window.notalone.memory.refresh({ contactId: selectedContactId, scopeRevision, ...(section ? { section } : {}) }),
        ...(!section ? [window.notalone.memory.refreshOverview({ contactId: selectedContactId, scopeRevision }),
          window.notalone.memory.refreshOwnerOverview({ contactId: selectedContactId, scopeRevision }),
          window.notalone.memory.readLayeredMemory({ contactId: selectedContactId, scopeRevision })] : [])]);
    }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围暂不可用，请重新确认联系人。');
      }
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
  async function readLayeredMemory() {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.readLayeredMemory({ contactId: selectedContactId, scopeRevision }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('主题资料范围暂不可用，请重新核对联系人。');
      }
    }
  }
  async function manageLayeredMemory(action: LayeredMemoryManagementRequest['action'], settingsGeneration: number, purposeConfirmed?: true) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.manageLayeredMemory({ contactId: selectedContactId, scopeRevision, action, settingsGeneration,
      ...(purposeConfirmed ? { purposeConfirmed } : {}) }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('主题资料范围或设置已变化，请重新读取后重试。');
      }
    }
  }
  useEffect(() => {
    setError('');
    if (session.state.selectedContactId) void refresh();
  }, [session.state.selectedContactId, session.state.scopeRevision]);
  async function correct(entry: ActiveMemory, text: string, category: MemoryCorrectionRequest['category']) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await window.notalone.memory.correct({ contactId: selectedContactId, scopeRevision, level: entry.level,
      memoryId: entry.memoryId, revision: entry.revision, text, category }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围或版本已变化，请刷新后再修正。');
      }
    }
  }
  async function openVersions(entry: ActiveMemory) {
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
  async function remove(entry: ActiveMemory) {
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
  async function applyCandidateUpdate(entry: PendingMemoryCandidate, previous: ActiveMemory) {
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
  return { state: matches ? state : initial, error, refresh, refreshOverview, refreshOwnerOverview, readLayeredMemory, manageLayeredMemory, correct, add, remove, openVersions, revertAutoUpdate, confirmCandidate, discardCandidate, applyCandidateUpdate };
}

// 时间展示统一注明 UTC+8；不把来源日期、保存日期或有效期互相替代。
function timeText(value: string | null): string {
  if (!value) return '未知';
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const field = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${field('year')}年${field('month')}月${field('day')}日 ${field('hour')}:${field('minute')}:${field('second')}（UTC+8）`;
}
function sourceTime(content: MemoryContent): string {
  const { sourceStartedAt: start, sourceEndedAt: end, sourceTimeComplete: complete } = content.timing;
  if (!start || !end) return '未知（来源时间不完整）';
  const range = Date.parse(start) === Date.parse(end) ? timeText(start) : `${timeText(start)} 至 ${timeText(end)}`;
  return complete ? range : `${range}；来源时间不完整`;
}

export function MemoryEventDetails({ event }: { event?: MemoryEvent | null }) {
  const stageNames = { planned: '计划', agreed: '约定', rescheduled: '改期', cancelled: '取消', occurred: '已发生', unknown: '未知' };
  const period = !event?.occurrenceStart ? '未知' : !event.occurrenceEnd
    ? `${timeText(event.occurrenceStart)}；结束时间未知`
    : Date.parse(event.occurrenceStart) === Date.parse(event.occurrenceEnd) ? timeText(event.occurrenceStart)
      : `${timeText(event.occurrenceStart)} 至 ${timeText(event.occurrenceEnd)}`;
  return <div className="memory-details" role="group" aria-label="事件信息">
    <p>事件阶段：{event ? stageNames[event.stage] : '未知'}（{event?.stageVerified ? '来源已核验' : '未核验'}）</p>
    <p>事件发生时段：{period}（{event?.occurrenceVerified ? '来源已核验' : '未核验'}）</p>
    <p>阶段与发生时段分别核验；计划或约定的时间仍表示安排，时间到期不会自动标记已发生。</p>
    <p>阶段依据：{event?.stageEvidence.length ? '' : '未知'}</p>
    {event && event.stageEvidence.length > 0 && <ul aria-label="阶段依据">{event.stageEvidence.map((entry, index) =>
      <li key={index}>消息引用：{entry.messageId} · 字符 {entry.charStart} 至 {entry.charEnd}</li>)}</ul>}
    <p>发生时段依据：{event?.occurrenceEvidence.length ? '' : '未知'}</p>
    {event && event.occurrenceEvidence.length > 0 && <ul aria-label="发生时段依据">{event.occurrenceEvidence.map((entry, index) =>
      <li key={index}>消息引用：{entry.messageId} · 字符 {entry.charStart} 至 {entry.charEnd}</li>)}</ul>}
  </div>;
}

function SourceReference({ id, sources }: { id: string; sources: MemorySection<MemorySource> }) {
  const source = sources.phase === 'ready' ? sources.items.find((entry) => entry.sourceId === id) : undefined;
  return <li><p>来源引用：{id}</p>{source ? <p>当前联系人来源：{source.fileName ?? '文件名不可用'} · {sourceNames[source.status]}</p>
    : <p>{sources.phase === 'error' ? '来源目录读取失败，暂时无法核对这项引用。'
      : sources.phase === 'loading' || sources.phase === 'idle' ? '来源目录尚未读取完成。' : '引用类型或来源详情暂不可用。'}</p>}</li>;
}

function MemoryCard({ content, memory, candidate, sources, correct, remove, openVersions, confirmCandidate, discardCandidate, updateMemories, applyCandidateUpdate, busy, trace }: {
  content: MemoryContent; memory?: ActiveMemory; candidate?: PendingMemoryCandidate; sources: MemorySection<MemorySource>;
  correct?: (entry: ActiveMemory, text: string, category: MemoryCorrectionRequest['category']) => Promise<void>; remove?: (entry: ActiveMemory) => Promise<void>; confirmCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; discardCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; busy?: boolean;
  trace: (kind: TraceRecordKind, id: string) => void;
  openVersions?: (entry: ActiveMemory) => Promise<void>;
  updateMemories?: MemorySection<ActiveMemory>;
  applyCandidateUpdate?: (entry: PendingMemoryCandidate, previous: ActiveMemory) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [text, setText] = useState(content.text);
  const [category, setCategory] = useState(content.category);
  return <article className={`memory-card ${candidate ? 'memory-pending' : ''}`}>
    <div className="memory-card-labels"><span>{categoryNames[content.category]} · {topicNames[content.topic]}</span>
      <b>{candidate ? '待确认 · 不是已确认事实' : memory?.adoptionMethod === 'auto' ? '自动采纳（可撤销）' : '手动采纳'}</b></div>
    <p className="memory-text">{content.text}</p>
    {candidate && <p className="memory-subject">主体：{subjectNames[candidate.subject]}</p>}
    {candidate?.correctionReview?.map((review) => <div key={review.decisionId} className="memory-details"
      role="group" aria-label="新证据与原人工决定">
      <p>原主张：{review.previousText}</p>
      <p>{review.decision === 'corrected' ? `原人工修正：${review.correctedText}` : '你此前已否决这项主张。'}</p>
      <p>{review.semanticRelation === 'same' ? '候选文字与原主张相同。' : '候选与原主张的语义关系尚未确定。'}{review.reason}</p>
      <p>确认会保存这项新候选，原人工决定继续保留。</p>
      <ul className="memory-source-references" aria-label="新增证据来源">{review.newSourceIds.map((id) => <SourceReference key={id} id={id} sources={sources} />)}</ul>
    </div>)}
    <MemoryTemporalStatus timing={content.timing} compact />
    <button className="memory-details-button" aria-label={`查看来源与版本：${content.text}`} aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? '收起来源与版本' : '查看来源与版本'}</button>
    {memory && correct && <button className="button" disabled={busy}
      aria-label={`修正资料：${content.text}`} onClick={() => { setRemoving(false); setEditing(true); }}>修正资料</button>}
    {memory && openVersions && <button className="button" disabled={busy}
      aria-label={`查看版本历史：${content.text}`} onClick={() => void openVersions(memory)}>查看版本历史</button>}
    {editing && memory && correct && <form aria-label={memory.level === 'owner' ? '修正本人资料' : '修正联系人资料'} className="memory-edit-form" onSubmit={(event) => {
      event.preventDefault(); void correct(memory, text, category);
    }}><label>资料正文<textarea aria-label="资料正文" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /></label>
      <label>资料分类<select aria-label="资料分类" value={category} disabled={busy}
        onChange={(event) => setCategory(event.target.value as MemoryCorrectionRequest['category'])}>
        {Object.entries(categoryNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <p>修正会保存新的手动版本并保留来源，旧版退出当前资料。</p>
      <button className="button" type="submit" disabled={busy || !text.trim()}>保存修正</button>
      <button className="button" type="button" disabled={busy} onClick={() => setEditing(false)}>取消修正</button>
    </form>}
    {memory && remove && <button className="button" disabled={busy}
      aria-label={`${memory.adoptionMethod === 'auto' ? '撤销自动采纳' : '删除资料'}：${content.text}`}
      onClick={() => { setEditing(false); setRemoving(true); }}>{memory.adoptionMethod === 'auto' ? '撤销自动采纳' : '删除资料'}</button>}
    {removing && memory && remove && <div className="memory-edit-form" role="group" aria-label="确认删除资料">
      <p>{memory.adoptionMethod === 'auto' ? '撤销等同删除这条资料，不删除来源消息，也不提供恢复承诺。' : '删除这条资料，来源消息仍保留。'}</p>
      <button className="button" disabled={busy} onClick={() => void remove(memory)}>{memory.adoptionMethod === 'auto' ? '确认撤销' : '确认删除'}</button>
      <button className="button" disabled={busy} onClick={() => setRemoving(false)}>取消删除</button>
    </div>}
    {candidate && confirmCandidate && <button className="button" disabled={busy}
      aria-label={`确认并保存：${content.text}`} onClick={() => void confirmCandidate(candidate)}>确认并保存</button>}
    {candidate && updateMemories && applyCandidateUpdate && <PendingMemoryUpdate candidate={candidate}
      memories={updateMemories} apply={applyCandidateUpdate} busy={busy} />}
    {candidate && discardCandidate && <button className="button" disabled={busy}
      aria-label={`丢弃候选：${content.text}`} onClick={() => setDiscarding(true)}>丢弃候选</button>}
    {discarding && candidate && discardCandidate && <div className="memory-edit-form" role="group" aria-label="确认丢弃候选">
      <p>丢弃这条待确认候选，不采纳为长期资料；来源消息仍保留。</p>
      <button className="button" disabled={busy} onClick={() => void discardCandidate(candidate)}>确认丢弃</button>
      <button className="button" disabled={busy} onClick={() => setDiscarding(false)}>取消丢弃</button>
    </div>}
    {expanded && <div className="memory-details">
      <p>{content.timing.currentStatusReason}</p>
      <div className="memory-times"><p>来源聊天时间：{sourceTime(content)}</p><p>保存时间：{timeText(content.timing.recordedAt)}</p></div>
      <MemoryEventDetails event={content.event} />
      <button className="button" aria-label={`查看提取过程：${content.text}`} onClick={() => {
        if (candidate) trace('candidate', candidate.candidateId);
        else if (memory) trace(memory.level === 'owner' ? 'owner_memory' : 'contact_memory', memory.memoryId);
      }}>查看提取过程</button>
      <p>来源聊天时间表示当时说过，不保证事件在当天发生。</p>
      <p>生效时间：{content.validAt ? timeText(content.validAt) : '未指定'}</p>
      <p>失效时间：{content.invalidAt ? timeText(content.invalidAt) : '未指定'}</p>
      {memory && <><p>记忆标识：{memory.memoryId}</p><p>版本：{memory.revision} · 已采纳</p>
        {memory.supersedesMemoryId && <p>替代版本引用：{memory.supersedesMemoryId}</p>}
        {memory.sourceCandidateId && <p>来源候选引用：{memory.sourceCandidateId}</p>}
        <p>版本历史可查看仍有合法来源的旧资料。</p></>}
      {candidate && <p>候选标识：{candidate.candidateId}</p>}
      <p>置信度：{Math.round(content.confidence * 100)}%（不表示用户确认）</p>
      {content.riskFlags.length > 0 && <p>风险标记：{content.riskFlags.join('、')}</p>}
      <ul className="memory-source-references" aria-label="来源引用">{content.sourceIds.map((id, index) => <SourceReference key={`${id}:${index}`} id={id} sources={sources} />)}</ul>
    </div>}
  </article>;
}

export function PendingMemoryUpdate({ candidate, memories, apply, busy }: {
  candidate: PendingMemoryCandidate; memories: MemorySection<ActiveMemory>; busy?: boolean;
  apply: (candidate: PendingMemoryCandidate, previous: ActiveMemory) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const previous = memories.items.find((entry) => `${entry.memoryId}:${entry.revision}` === selected);
  useEffect(() => setSelected(''), [candidate.candidateId, memories.phase]);
  if (memories.phase !== 'ready' || memories.items.length === 0) return null;
  return <form className="memory-edit-form" aria-label={`应用候选更新：${candidate.text}`} onSubmit={(event) => {
    event.preventDefault(); if (previous) void apply(candidate, previous);
  }}>
    <label>选择要更新的当前资料<select aria-label="选择要更新的当前资料" value={previous ? selected : ''}
      disabled={busy} onChange={(event) => setSelected(event.target.value)}>
      <option value="">请先选择并核对旧资料</option>
      {memories.items.map((entry) => <option key={entry.memoryId} value={`${entry.memoryId}:${entry.revision}`}>{entry.text}（版本 {entry.revision}）</option>)}
    </select></label>
    {previous && <p>所选旧版：{previous.text}（版本 {previous.revision}）。请核对本次变化和新候选的来源。</p>}
    <p>确认后保存为手动新版本，旧版保留在历史中；进展变化不表示旧资料当时有误。</p>
    <button className="button" type="submit" disabled={busy || !previous}>确认应用为新版本</button>
  </form>;
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
    <p>旧版记录当时的资料；版本变化不表示旧资料当时有误。</p>
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
      <p>{entry.text}</p><p>来源聊天时间：{sourceTime(entry)}</p><p>保存时间：{timeText(entry.timing.recordedAt)}</p>
      <MemoryTemporalStatus timing={entry.timing} />
      <MemoryEventDetails event={entry.event} />
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
  return <div><button className="button" disabled={busy} onClick={() => setOpen(true)}>{name}</button>
    {open && <form className="memory-edit-form" aria-label={name} onSubmit={(event) => { event.preventDefault(); void add(level, text, category); }}>
      <label>资料正文<textarea aria-label="资料正文" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} /></label>
      <label>资料分类<select aria-label="资料分类" value={category} disabled={busy}
        onChange={(event) => setCategory(event.target.value as MemoryAdditionRequest['category'])}>
        {Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p>{level === 'owner' ? '本人资料可在不同联系人的回复中共享使用。' : '只保存到当前已确认联系人的资料。'}手动补充不会成为自动采纳。</p>
      <button className="button" type="submit" disabled={busy || !text.trim()}>保存资料</button>
      <button className="button" type="button" disabled={busy} onClick={() => setOpen(false)}>取消补充</button>
    </form>}
  </div>;
}

function ReadingSection<T>({ title, note, empty, state, retry, children }: {
  title: string; note: string; empty: string; state: MemorySection<T>; retry: () => void; children: ReactNode;
}) {
  return <section className="memory-section" aria-label={title}>
    <header><div><h2>{title}</h2><p>{note}</p></div>
      <button className="button" disabled={state.phase === 'loading'} onClick={retry} aria-label={`重新读取${title}`}>刷新</button></header>
    {(state.phase === 'loading' || state.phase === 'idle') && <p className="memory-section-note" role="status">正在读取{title}…</p>}
    {state.phase === 'error' && <p className="memory-section-note" role="alert">{title}读取失败，请重试。</p>}
    {state.phase === 'ready' && (<>{state.items.length === 0 && <p className="memory-section-note">{empty}</p>}{children}</>)}
  </section>;
}

export function ContactRelationshipOverview({ overview, memories, refresh, openVersions, trace, busy = false }: {
  overview: MemoryOverviewState; memories: MemorySection<ActiveMemory>; refresh: () => Promise<void>;
  openVersions: (entry: ActiveMemory) => Promise<void>; trace?: (kind: TraceRecordKind, id: string) => void; busy?: boolean;
}) {
  return <section className="memory-section memory-overview" aria-label="联系人经历与关系变化">
    <header><div><h2>联系人经历与关系变化</h2>
      <p>这是已采纳资料的投影，呈现经历与版本变化，不包含未确认推断；不进行性格或动机分析。</p></div>
      <button className="button" disabled={busy || overview.phase === 'loading'} onClick={() => void refresh()}>刷新联系人概览</button></header>
    {(overview.phase === 'idle' || overview.phase === 'loading') && <p role="status">正在核对概览与来源…</p>}
    {overview.phase === 'error' && <p role="alert">概览读取失败，旧概览已撤下，请刷新重试。</p>}
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
          <MemoryTemporalStatus timing={item.timing} compact />
          {!entry.isLatest && <p className="memory-section-note">旧版本只记录当时的资料，不代表当前状态。</p>}
          <details className="memory-details"><summary>查看逐项来源与修订</summary>
            <p>{item.timing.currentStatusReason}</p>
            <div className="memory-times"><p>来源聊天时间：{sourceTime(item)}</p><p>保存时间：{timeText(item.timing.recordedAt)}</p></div>
            <MemoryEventDetails event={item.event} />
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
          {trace && <button className="button" disabled={busy} onClick={() => trace('contact_memory', item.memoryId)}
            aria-label={`查看概览提取过程：${item.text}`}>查看提取过程</button>}
          {leaf ? <button className="button" disabled={busy} onClick={() => void openVersions(leaf)}
            aria-label={`查看变化依据：${item.text}`}>查看底层资料与版本历史</button>
            : <p className="memory-section-note">当前底层版本暂不可核对；此项只供回看，请刷新资料后再修正。</p>}
          <p className="memory-section-note">修正或删除请切换到联系人记忆，概览会重新核对。</p>
          </details>
        </article>;
      }}</MemoryList>
      <details className="memory-details"><summary>查看概览修订</summary><p>概览修订：{overview.value.projectionRevision}</p></details>
    </>}
  </section>;
}

export function OwnerFactsOverview({ overview, memories, contactId, refresh, openVersions, trace, busy = false }: {
  overview: MemoryOverviewState<OwnerFactsPreferencesOverview>; memories: MemorySection<ActiveMemory>; contactId: string;
  refresh: () => Promise<void>; openVersions: (entry: ActiveMemory) => Promise<void>;
  trace?: (kind: TraceRecordKind, id: string) => void; busy?: boolean;
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
          <p className="memory-text">{item.text}</p><MemoryTemporalStatus timing={item.timing} compact />
          {!entry.isLatest && <p className="memory-section-note">旧版本只记录当时的资料，不代表当前状态。</p>}
          <details className="memory-details"><summary>查看逐项来源与修订</summary>
            <p>{item.timing.currentStatusReason}</p>
            <div className="memory-times"><p>来源聊天时间：{sourceTime(item)}</p><p>保存时间：{timeText(item.timing.recordedAt)}</p></div>
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
          {trace && traceAvailable && <button className="button" disabled={busy} onClick={() => trace('owner_memory', item.memoryId)}
            aria-label={`查看本人概览提取过程：${item.text}`}>查看提取过程</button>}
          {!traceAvailable && <p className="memory-section-note">{provenance.kind === 'manual_entry'
            ? '本人手录资料不适用模型提取过程。' : '完整来源范围尚未与当前联系人核对，暂不读取提取过程；可按逐项原来源标识核对。'}</p>}
          {leaf ? <button className="button" disabled={busy} onClick={() => void openVersions(leaf)}
            aria-label={`查看本人变化依据：${item.text}`}>查看本人底层资料与版本历史</button>
            : <p className="memory-section-note">当前本人底层版本暂不可核对；此项只供回看，请刷新资料后再修正。</p>}
          <p className="memory-section-note">切换到本人记忆修正或删除，概览会重新核对。</p>
          </details>
        </article>;
      }}</MemoryList>
      <details className="memory-details"><summary>查看本人概览修订</summary><p>概览修订：{overview.value.projectionRevision}</p></details>
    </>}
  </section>;
}

const memoryViews = { contact: '联系人记忆', owner: '本人记忆', pending: '待确认候选',
  layeredMemory: '主题资料', overview: '联系人概览', ownerOverview: '本人概览', sources: '来源与过程' } as const;
type MemoryView = keyof typeof memoryViews;

export function MemoryPage({ session, navigate }: { session: ContactSessionView; navigate: (page: ManagerPage) => void }) {
  const memory = useMemoryReading(session);
  const traces = useTraceReading(session);
  const scopeKey = `${session.state.selectedContactId}:${session.state.scopeRevision}`;
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  const [selection, setSelection] = useState<{ scope: string; view: MemoryView }>({ scope: scopeKey, view: 'contact' });
  const view = selection.scope === scopeKey ? selection.view : 'contact';
  const tracePanel = useRef<HTMLDivElement>(null);
  const selectView = (next: MemoryView) => setSelection({ scope: scopeKey, view: next });
  const trace = (kind: TraceRecordKind, id: string) => {
    selectView('sources');
    void traces.find('memory-traces', kind, id).then(() => {
      if (activeScope.current === scopeKey) tracePanel.current?.scrollIntoView({ block: 'start' });
    });
  };
  const contact = session.state.contacts.find((entry) => entry.contactId === session.state.selectedContactId);
  const { state } = memory;
  return <div className="memory-page">
    <div className="memory-navigation"><div className="memory-toolbar"><label>资料联系人 <select aria-label="资料联系人" value={session.state.selectedContactId ?? ''}
      disabled={session.state.contacts.length === 0} onChange={(event) => void session.selectContact(event.target.value)}>
      <option value="" disabled>先确认联系人</option>{session.state.contacts.map((entry) => <option key={entry.contactId} value={entry.contactId}>{entry.displayName}</option>)}</select></label>
      <button className="button" disabled={!contact || [state.contact, state.owner, state.pending, state.sources].some((section) => section.phase === 'loading')}
        onClick={() => void memory.refresh()}>刷新记忆</button></div>
      {contact && <nav className="memory-tabs" aria-label="记忆分类">{(Object.keys(memoryViews) as MemoryView[]).map((name) =>
        <button key={name} aria-pressed={view === name} onClick={() => selectView(name)}>{memoryViews[name]}</button>)}</nav>}
    </div>
    {!contact ? <section className="memory-no-contact" aria-label="资料范围未确认"><h2>先确认本次联系人</h2>
      <p>选择联系人后，查看该范围的关系记忆、待确认候选与来源，以及当前本人的共享资料。</p>
      <button className="button" onClick={() => navigate('contacts')}>前往联系人目录</button></section>
      : <>
        <p className="memory-scope-note">当前联系人：{contact.displayName}。请以卡片核实状态为准，过期资料仅供回看；历史版本可在概览中查看。</p>
        {view === 'layeredMemory' && <LayeredMemoryPanel key={scopeKey} state={state.layeredMemory} contactName={contact.displayName}
          busy={state.mutation.phase === 'working'} read={memory.readLayeredMemory} manage={memory.manageLayeredMemory}
          facts={() => selectView('contact')} />}
        {view === 'overview' && <ContactRelationshipOverview key={scopeKey} overview={state.overview} memories={state.contact} refresh={memory.refreshOverview}
          openVersions={memory.openVersions} trace={trace} busy={state.mutation.phase === 'working'} />}
        {view === 'contact' && <ReadingSection title="联系人记忆" note="自动采纳不代表用户确认；手动采纳可能来自录入、确认候选或修正。" empty="这位联系人暂无可查看记忆。"
          state={state.contact} retry={() => void memory.refresh('contact')}>
          <AdditionControl key={`contact:${state.scopeRevision}`} level="contact" phase={state.mutation.phase} add={memory.add} />
          <MemoryList key={scopeKey} items={state.contact.items} label="联系人记忆">{(entry) => <MemoryCard key={entry.memoryId} content={entry} memory={entry} sources={state.sources}
            trace={trace} correct={memory.correct} remove={memory.remove} openVersions={memory.openVersions} busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        {view === 'ownerOverview' && <OwnerFactsOverview key={scopeKey} overview={state.ownerOverview} memories={state.owner} contactId={contact.contactId} refresh={memory.refreshOwnerOverview}
          openVersions={memory.openVersions} trace={trace} busy={state.mutation.phase === 'working'} />}
        {view === 'owner' && <ReadingSection title="本人记忆" note="属于当前本人，可在与不同联系人的回复中共享使用。" empty="当前本人暂无可查看记忆。"
          state={state.owner} retry={() => void memory.refresh('owner')}>
          <AdditionControl key={`owner:${state.scopeRevision}`} level="owner" phase={state.mutation.phase} add={memory.add} />
          <MemoryList key={scopeKey} items={state.owner.items} label="本人记忆">{(entry) => <MemoryCard key={entry.memoryId} content={entry} memory={entry} sources={state.sources}
            trace={trace} correct={memory.correct} remove={memory.remove} openVersions={memory.openVersions} busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        {view === 'pending' && <ReadingSection title="待确认候选" note="仅来自当前联系人范围；本人、联系人与双方主体分别标明，未经确认不能当作确定事实。" empty="这位联系人暂无待确认候选。"
          state={state.pending} retry={() => void memory.refresh('pending')}>
          <MemoryList key={scopeKey} items={state.pending.items} label="待确认候选">{(entry) => <MemoryCard key={entry.candidateId} content={entry} candidate={entry} sources={state.sources}
            trace={trace} confirmCandidate={memory.confirmCandidate} discardCandidate={memory.discardCandidate}
            updateMemories={entry.subject === 'self' ? state.owner : state.contact} applyCandidateUpdate={memory.applyCandidateUpdate}
            busy={state.mutation.phase === 'working'} />}</MemoryList>
        </ReadingSection>}
        {view === 'sources' && <ReadingSection title="当前联系人来源" note="来源目录不能解析所有消息、观察或人工引用；无法核对的引用会保留未知说明。" empty="这位联系人暂无来源记录。"
          state={state.sources} retry={() => void memory.refresh('sources')}>
          <MemoryList key={scopeKey} items={state.sources.items} label="当前联系人来源" className="memory-source-list" list>{(entry) => <li key={entry.sourceId}>
            <b>{entry.fileName ?? '文件名不可用'}</b><p>来源标识：{entry.sourceId}</p><p>{entry.recordCount} 条记录 · {sourceNames[entry.status]}</p>
          </li>}</MemoryList>
        </ReadingSection>}
      </>}
    {contact && <MemoryVersionHistory history={state.history} revert={memory.revertAutoUpdate} busy={state.mutation.phase === 'working'} />}
    {contact && view === 'sources' && <SourceDeletionPanel session={session} />}
    {contact && view === 'sources' && <div ref={tracePanel} className="memory-trace-target"><TracePanel key={session.state.scopeRevision} traces={traces} /></div>}
    {state.mutation.phase !== 'idle' && <p className="memory-section-note" role={state.mutation.phase === 'error' ? 'alert' : 'status'}>{state.mutation.message}</p>}
    {state.mutation.backupCleanupRequired && <UpdateBackupCleanupRecovery />}
    {memory.error && <p className="memory-section-note" role="alert">{memory.error}</p>}
    {session.error && <p className="memory-section-note" role="alert">{session.error}</p>}
  </div>;
}
