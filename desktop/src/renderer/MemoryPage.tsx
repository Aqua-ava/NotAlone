import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ActiveMemory, MemoryAdditionRequest, MemoryContent, MemoryCorrectionRequest, MemoryReadingState, MemorySection, MemorySectionName, MemorySource, PendingMemoryCandidate } from '../shared/memory-bridge';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import './memory.css';

const initial: MemoryReadingState = { revision: -1, contactId: null, scopeRevision: 0, mutation: { phase: 'idle', message: '' },
  contact: { phase: 'idle', items: [] }, owner: { phase: 'idle', items: [] },
  pending: { phase: 'idle', items: [] }, sources: { phase: 'idle', items: [] } };
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
    try { await window.notalone.memory.refresh({ contactId: selectedContactId, scopeRevision, ...(section ? { section } : {}) }); }
    catch {
      if (active.current && scope.current.selectedContactId === selectedContactId && scope.current.scopeRevision === scopeRevision) {
        setError('资料范围暂不可用，请重新确认联系人。');
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
  const matches = state.contactId === session.state.selectedContactId && state.scopeRevision === session.state.scopeRevision;
  return { state: matches ? state : initial, error, refresh, correct, add, remove, confirmCandidate, discardCandidate };
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

function SourceReference({ id, sources }: { id: string; sources: MemorySection<MemorySource> }) {
  const source = sources.phase === 'ready' ? sources.items.find((entry) => entry.sourceId === id) : undefined;
  return <li><p>来源引用：{id}</p>{source ? <p>当前联系人来源：{source.fileName ?? '文件名不可用'} · {sourceNames[source.status]}</p>
    : <p>{sources.phase === 'error' ? '来源目录读取失败，暂时无法核对这项引用。'
      : sources.phase === 'loading' || sources.phase === 'idle' ? '来源目录尚未读取完成。' : '引用类型或来源详情暂不可用。'}</p>}</li>;
}

function MemoryCard({ content, memory, candidate, sources, correct, remove, confirmCandidate, discardCandidate, busy }: {
  content: MemoryContent; memory?: ActiveMemory; candidate?: PendingMemoryCandidate; sources: MemorySection<MemorySource>;
  correct?: (entry: ActiveMemory, text: string, category: MemoryCorrectionRequest['category']) => Promise<void>; remove?: (entry: ActiveMemory) => Promise<void>; confirmCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; discardCandidate?: (entry: PendingMemoryCandidate) => Promise<void>; busy?: boolean;
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
    <div className="memory-times"><p>来源聊天时间：{sourceTime(content)}</p><p>保存时间：{timeText(content.timing.recordedAt)}</p></div>
    <button className="memory-details-button" aria-label={`查看来源与版本：${content.text}`} aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? '收起来源与版本' : '查看来源与版本'}</button>
    {memory && correct && <button className="button" disabled={busy}
      aria-label={`修正资料：${content.text}`} onClick={() => { setRemoving(false); setEditing(true); }}>修正资料</button>}
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
    {candidate && discardCandidate && <button className="button" disabled={busy}
      aria-label={`丢弃候选：${content.text}`} onClick={() => setDiscarding(true)}>丢弃候选</button>}
    {discarding && candidate && discardCandidate && <div className="memory-edit-form" role="group" aria-label="确认丢弃候选">
      <p>丢弃这条待确认候选，不采纳为长期资料；来源消息仍保留。</p>
      <button className="button" disabled={busy} onClick={() => void discardCandidate(candidate)}>确认丢弃</button>
      <button className="button" disabled={busy} onClick={() => setDiscarding(false)}>取消丢弃</button>
    </div>}
    {expanded && <div className="memory-details">
      <p>来源聊天时间表示当时说过，不保证事件在当天发生。</p>
      <p>生效时间：{content.validAt ? timeText(content.validAt) : '未指定'}</p>
      <p>失效时间：{content.invalidAt ? timeText(content.invalidAt) : '未指定'}</p>
      {memory && <><p>记忆标识：{memory.memoryId}</p><p>版本：{memory.revision} · 当前有效</p>
        {memory.supersedesMemoryId && <p>替代版本引用：{memory.supersedesMemoryId}</p>}
        {memory.sourceCandidateId && <p>来源候选引用：{memory.sourceCandidateId}</p>}
        <p>仅展示已有版本和候选引用，历史正文暂不可用。</p></>}
      {candidate && <p>候选标识：{candidate.candidateId}</p>}
      <p>置信度：{Math.round(content.confidence * 100)}%（不表示用户确认）</p>
      {content.riskFlags.length > 0 && <p>风险标记：{content.riskFlags.join('、')}</p>}
      <ul className="memory-source-references" aria-label="来源引用">{content.sourceIds.map((id, index) => <SourceReference key={`${id}:${index}`} id={id} sources={sources} />)}</ul>
    </div>}
  </article>;
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

export function MemoryPage({ session, navigate }: { session: ContactSessionView; navigate: (page: ManagerPage) => void }) {
  const memory = useMemoryReading(session);
  const contact = session.state.contacts.find((entry) => entry.contactId === session.state.selectedContactId);
  const { state } = memory;
  return <div className="memory-page">
    <div className="memory-toolbar"><label>资料联系人 <select aria-label="资料联系人" value={session.state.selectedContactId ?? ''}
      disabled={session.state.contacts.length === 0} onChange={(event) => void session.selectContact(event.target.value)}>
      <option value="" disabled>先确认联系人</option>{session.state.contacts.map((entry) => <option key={entry.contactId} value={entry.contactId}>{entry.displayName}</option>)}</select></label>
      <button className="button" disabled={!contact || [state.contact, state.owner, state.pending, state.sources].some((section) => section.phase === 'loading')}
        onClick={() => void memory.refresh()}>刷新关系资料</button></div>
    {!contact ? <section className="memory-no-contact" aria-label="资料范围未确认"><h2>先确认本次联系人</h2>
      <p>选择联系人后，查看该范围的关系记忆、待确认候选与来源，以及当前本人的共享资料。</p>
      <button className="button" onClick={() => navigate('contacts')}>前往联系人目录</button></section>
      : <>
        <p className="memory-scope-note">当前联系人：{contact.displayName}。记忆只展示当前有效资料；旧版本、过期或尚未生效的记忆不在此列表。</p>
        <ReadingSection title="联系人记忆" note="自动采纳不代表用户确认；手动采纳可能来自录入、确认候选或修正。" empty="这位联系人暂无当前有效记忆。"
          state={state.contact} retry={() => void memory.refresh('contact')}>
          <AdditionControl key={`contact:${state.scopeRevision}`} level="contact" phase={state.mutation.phase} add={memory.add} />
          <div className="memory-cards">{state.contact.items.map((entry) => <MemoryCard key={entry.memoryId} content={entry} memory={entry} sources={state.sources}
            correct={memory.correct} remove={memory.remove} busy={state.mutation.phase === 'working'} />)}</div>
        </ReadingSection>
        <ReadingSection title="本人记忆" note="属于当前本人，可在与不同联系人的回复中共享使用。" empty="当前本人暂无有效记忆。"
          state={state.owner} retry={() => void memory.refresh('owner')}>
          <AdditionControl key={`owner:${state.scopeRevision}`} level="owner" phase={state.mutation.phase} add={memory.add} />
          <div className="memory-cards">{state.owner.items.map((entry) => <MemoryCard key={entry.memoryId} content={entry} memory={entry} sources={state.sources}
            correct={memory.correct} remove={memory.remove} busy={state.mutation.phase === 'working'} />)}</div>
        </ReadingSection>
        <ReadingSection title="待确认候选" note="仅来自当前联系人范围；本人、联系人与双方主体分别标明，未经确认不能当作确定事实。" empty="这位联系人暂无待确认候选。"
          state={state.pending} retry={() => void memory.refresh('pending')}>
          <div className="memory-cards">{state.pending.items.map((entry) => <MemoryCard key={entry.candidateId} content={entry} candidate={entry} sources={state.sources}
            confirmCandidate={memory.confirmCandidate} discardCandidate={memory.discardCandidate} busy={state.mutation.phase === 'working'} />)}</div>
        </ReadingSection>
        <ReadingSection title="当前联系人来源" note="来源目录不能解析所有消息、观察或人工引用；无法核对的引用会保留未知说明。" empty="这位联系人暂无来源记录。"
          state={state.sources} retry={() => void memory.refresh('sources')}>
          <ul className="memory-source-list">{state.sources.items.map((entry) => <li key={entry.sourceId}>
            <b>{entry.fileName ?? '文件名不可用'}</b><p>来源标识：{entry.sourceId}</p><p>{entry.recordCount} 条记录 · {sourceNames[entry.status]}</p>
          </li>)}</ul>
        </ReadingSection>
      </>}
    {state.mutation.phase !== 'idle' && <p className="memory-section-note" role={state.mutation.phase === 'error' ? 'alert' : 'status'}>{state.mutation.message}</p>}
    {memory.error && <p className="memory-section-note" role="alert">{memory.error}</p>}
    {session.error && <p className="memory-section-note" role="alert">{session.error}</p>}
  </div>;
}
