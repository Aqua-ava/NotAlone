import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { AssistantSessionDeletion } from '../shared/reply-bridge';
import type { ReplySessionView } from './RewritePanel';
import type { SavedAssistantInput, SavedAssistantTurn } from '../shared/assistant-session';

function SavedTurn({ turn, index }: { turn: SavedAssistantTurn; index: number }) {
  return <article aria-label={`第${index + 1}轮讨论`}>
    {turn.placeholder ? <p>{turn.placeholder}</p> : <>
      <p>{typeof turn.input?.content.draft_text === 'string' ? turn.input.content.draft_text
        : typeof turn.input?.content.direction === 'string' ? turn.input.content.direction
        : typeof turn.input?.content.purpose === 'string' ? turn.input.content.purpose : '本轮回复输入'}</p>
      {typeof turn.input?.content.user_instruction === 'string' && <p>{turn.input.content.user_instruction}</p>}
      {turn.state === 'running' && <p>本轮生成尚未完成。</p>}
      {turn.state === 'failed' && <p>本轮生成未成功保存。</p>}
      {turn.reply?.candidates.map((candidate) => <p key={candidate.candidateId}
        data-assistant-candidate-id={candidate.candidateId}
        data-assistant-reply-request-id={turn.reply!.replyRequestId}>{candidate.text}</p>)}
    </>}
  </article>;
}
function SavedDiscussion({ input }: { input: SavedAssistantInput }) {
  const content = input.content;
  return <article aria-label="已保存的方向讨论">
    {input.placeholder ? <p>{input.placeholder}</p> : content && <dl>
      {content.type === 'purpose_exploration' ? <><dt>当时的主动目的</dt><dd>{content.purposeHint}</dd></>
        : <><dt>当时选择的消息</dt><dd>{content.targetMessageId}</dd></>}
      {content.correction && <><dt>纠正理解</dt><dd>{content.correction}</dd></>}
      {content.requirements && <><dt>本次要求</dt><dd>{content.requirements}</dd></>}
      {content.answer && <><dt>关键问题回答</dt><dd>{content.answer}</dd></>}
      {content.confirmedIntent && <><dt>已确认的本次意愿</dt><dd>{content.confirmedIntent}</dd></>}
      <dt>当时的策略选择</dt><dd>{content.skillMode === 'disabled' ? '使用通用流程'
        : content.skillMode === 'auto' ? '按当时场景选择' : `指定版本 ${content.skillVersionId}`}</dd>
    </dl>}
  </article>;
}

export function AssistantSessionPanel({ replies }: { replies: ReplySessionView }) {
  const saved = replies.state.savedSession;
  const [confirmation, setConfirmation] = useState<AssistantSessionDeletion | null>(null);
  const [copyError, setCopyError] = useState(false);
  const copyScopeKey = `${replies.state.contactId}:${replies.state.scopeRevision}:${saved?.sessionId}`;
  const currentCopyScope = useRef(copyScopeKey); currentCopyScope.current = copyScopeKey;
  const deleting = replies.state.sessionDeletion === 'deleting';
  const catalog = replies.state.sessionCatalog;
  const busy = deleting || catalog?.phase === 'loading' || saved?.phase === 'loading'
    || replies.state.exploration.phase === 'waiting'
    || replies.state.sessionDeletion === 'failed' || replies.state.sourceAvailability === 'checking';
  useEffect(() => { setConfirmation(null); setCopyError(false); }, [replies.state.contactId, replies.state.scopeRevision, saved?.sessionId]);
  function confirmDelete() {
    if (!confirmation) return;
    const command = confirmation; setConfirmation(null);
    void replies.deleteSavedSession(command);
  }
  function manageSamples() {
    const samples = document.getElementById('assistant-expression-samples');
    if (samples instanceof HTMLDetailsElement) { samples.open = true; samples.scrollIntoView({ block: 'nearest' }); }
  }
  function noteHistoricalCopy(event: ClipboardEvent<HTMLElement>) {
    const selection = window.getSelection(); const text = selection?.toString() ?? '';
    if (!selection || !text.trim() || !replies.state.contactId) return;
    const nodes = [selection.anchorNode, selection.focusNode];
    const candidate = nodes.map((node) => (node instanceof Element ? node : node?.parentElement)
      ?.closest('[data-assistant-candidate-id]')).find((element) => element && event.currentTarget.contains(element));
    const candidateId = candidate?.getAttribute('data-assistant-candidate-id');
    const replyRequestId = candidate?.getAttribute('data-assistant-reply-request-id');
    if (!candidateId || !replyRequestId) return;
    // 混合或超长选区仍交给唯一来源控制器核验，拒绝后不能成为无来源手工样本。
    void window.notalone.styleSamples.noteCandidateCopy({ contactId: replies.state.contactId,
      scopeRevision: replies.state.scopeRevision, replyRequestId, candidateId, text: text.slice(0, 65_536),
      ...(text.length > 65_536 ? { invalidSelection: true as const } : {}) })
      .then(() => { if (currentCopyScope.current === copyScopeKey) setCopyError(false); })
      .catch(() => { if (currentCopyScope.current === copyScopeKey) setCopyError(true); });
  }
  return <section aria-label="助手会话">
    <button disabled={!replies.state.contactId || busy} onClick={() => void replies.newSavedSession()}>
      新开助手会话
    </button>
    <button disabled={!replies.state.contactId || busy} onClick={() => void replies.listSavedSessions()}>刷新会话列表</button>
    {catalog?.phase === 'loading' && <p role="status">正在核对助手会话…</p>}
    {catalog?.selectionPending && catalog.phase !== 'loading' && <p role="alert">助手会话操作尚未确认，请刷新列表后明确选择会话。</p>}
    {catalog?.phase === 'failed' && !catalog.selectionPending && <p role="alert">助手会话列表暂不可用，请刷新重试。</p>}
    {catalog?.phase === 'ready' && <ul aria-label="助手会话目录">
      {!catalog.items.length && <li>这位联系人还没有助手会话。</li>}
      {catalog.items.map((item) => <li key={item.sessionId}>
        <button disabled={busy} onClick={() => void replies.selectSavedSession(item.sessionId)}>查看会话 {item.sessionId}</button>
        {item.isCurrent && <span> 当前会话</span>}
        {item.sessionId === saved?.sessionId && <span> 正在查看</span>}
      </li>)}
    </ul>}
    <button disabled={!replies.state.contactId || saved?.phase === 'loading' || deleting || catalog?.phase === 'loading' || catalog?.selectionPending} onClick={() => void replies.readSavedSession()}>
      {saved?.phase === 'failed' ? '重试读取已保存讨论' : '查看已保存讨论'}
    </button>
    <button disabled={!saved?.sessionId || saved.phase === 'loading' || deleting || catalog?.phase === 'loading' || catalog?.selectionPending}
      onClick={() => setConfirmation({ contactId: replies.state.contactId!, scopeRevision: replies.state.scopeRevision,
        sessionId: saved!.sessionId!, confirmed: true })}>删除当前助手会话</button>
    {confirmation && <div role="group" aria-label="确认删除助手会话">
      <p>删除这段助手讨论、候选和使用痕迹后无法恢复。独立聊天来源、联系人关系记忆和本人记忆仍会保留。</p>
      <p>已主动保存的表达样本仍会保留，可在表达样本管理中单独删除。</p>
      <button onClick={manageSamples}>管理表达样本</button>
      <button disabled={catalog?.phase === 'loading' || catalog?.selectionPending} onClick={confirmDelete}>确认删除会话</button>
      <button onClick={() => setConfirmation(null)}>取消删除会话</button>
    </div>}
    {deleting && <p role="status">正在删除并核对助手会话…</p>}
    {replies.state.sessionDeletion === 'failed' && <p role="alert">助手会话删除尚未确认完成，请重试。
      <button disabled={!saved?.sessionId} onClick={() => void replies.deleteSavedSession({ contactId: replies.state.contactId!,
        scopeRevision: replies.state.scopeRevision, sessionId: saved!.sessionId!, confirmed: true })}>重试删除会话</button>
    </p>}
    {replies.state.sessionDeletion === 'deleted' && <p role="status">当前助手会话已删除。</p>}
    {replies.state.sessionDeletion === 'missing' && <p role="status">当前助手会话已不存在。</p>}
    {saved?.phase === 'loading' && <p role="status">正在读取已保存讨论…</p>}
    {saved?.phase === 'failed' && <p role="alert">已保存讨论暂不可用，请重试读取。</p>}
    {copyError && <p role="alert">复制来源暂不可确认，请重新读取讨论后核对。</p>}
    {saved?.phase === 'ready' && <section aria-label="已保存的讨论" onCopy={noteHistoricalCopy}>
      {!saved.inputs.length && <p>当前会话还没有讨论。</p>}
      {saved.inputs.map((input) => {
        if (input.type !== 'generation') return <SavedDiscussion key={input.inputVersionId} input={input} />;
        const index = saved.turns.findIndex((turn) => turn.turnId === input.turnId && turn.inputVersionId === input.inputVersionId);
        return index < 0 ? null : <SavedTurn key={input.inputVersionId} turn={saved.turns[index]} index={index} />;
      })}
    </section>}
  </section>;
}
