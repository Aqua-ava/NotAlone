import { SqliteReplyCandidatesPanel } from './SqliteReplyCandidatesPanel';
import { useEffect, useRef, useState } from 'react';
import type { AssistantSessionDeletion } from '../shared/reply-bridge';
import type { ReplySessionView } from './RewritePanel';
import { UpdateBackupCleanupRecovery } from './UpdateBackupDeletionNotice';
import { SqliteDiscussionEntries } from './SqliteDiscussionEntries';
import { SqliteDiscussionComposer } from './SqliteDiscussionComposer';
import type { SqliteDiscussionReceipt } from '../shared/sqlite-discussion-bridge';

export function AssistantSessionDeletionConfirmation({ busy, onConfirm, onCancel }: {
  busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <div className="session-confirmation" role="group" aria-label="确认删除助手讨论">
    <p>删除这段助手讨论、候选版本和运行使用痕迹后无法恢复。联系人、原始微信聊天、关系记忆和本人记忆不会删除。</p>
    <button className="button" disabled={busy} onClick={onConfirm}>确认删除讨论</button>
    <button className="button" onClick={onCancel}>取消删除</button>
  </div>;
}

export function AssistantSessionPanel({ replies, initialDraft = '', onDraftChange }: {
  replies: ReplySessionView; initialDraft?: string;
  onDraftChange?: (text: string, scope: { contactId: string; scopeRevision: number }) => void;
}) {
  const saved = replies.state.savedSession;
  const [confirmation, setConfirmation] = useState<AssistantSessionDeletion | null>(null);
  const deleting = replies.state.sessionDeletion === 'deleting';
  const catalog = replies.state.sessionCatalog;
  const sqliteDiscussion = saved?.phase === 'ready' && Boolean(saved.sessionId) && saved.discussionEntries !== undefined;
  const contactScopeKey = `${replies.state.contactId}:${replies.state.scopeRevision}`;
  const currentContactScope = useRef(contactScopeKey); currentContactScope.current = contactScopeKey;
  const busy = deleting || catalog?.phase === 'loading' || saved?.phase === 'loading'
    || replies.state.sessionDeletion === 'failed' || replies.state.sourceAvailability === 'checking';
  const currentDiscussion = catalog?.phase === 'ready' && !catalog.selectionPending
    && !!saved?.sessionId && catalog.currentSessionId === saved.sessionId;
  const discussionDisabled = Boolean(replies.state.generationBlock) || busy || !!confirmation || saved?.phase !== 'ready'
    || Boolean(replies.state.sourceAvailability)
    || replies.state.sessionDeletion === 'deleted' || replies.state.sessionDeletion === 'missing';
  const sessionRecovery = <button className="button" disabled={!replies.state.contactId || busy}
    onClick={() => void (saved?.sessionId ? replies.viewSavedSession(saved.sessionId) : replies.listSavedSessions())}>
    {saved?.sessionId ? '重新核对讨论' : '刷新讨论列表'}
  </button>;
  useEffect(() => { setConfirmation(null); }, [replies.state.contactId, replies.state.scopeRevision, saved?.sessionId]);
  useEffect(() => {
    if (sqliteDiscussion && saved?.phase === 'ready' && saved.sessionId && (!catalog || catalog.phase === 'idle')) {
      void replies.listSavedSessions();
    }
  }, [sqliteDiscussion, replies.state.contactId, replies.state.scopeRevision, saved?.sessionId, saved?.phase, catalog?.phase]);
  function discussionSubmitted(receipt: SqliteDiscussionReceipt) {
    const scope = contactScopeKey;
    // 回执可指向分段后的新会话或原幂等请求；只通过正式回看操作刷新正文。
    void (async () => {
      await replies.viewSavedSession(receipt.sessionId);
      if (currentContactScope.current === scope) await replies.listSavedSessions();
    })();
  }
  function confirmDelete() {
    if (!confirmation) return;
    const command = confirmation; setConfirmation(null);
    void replies.deleteSavedSession(command);
  }
  return <section className="assistant-session-panel assistant-session-panel-sqlite" aria-label="助手会话">
    {replies.state.contextRefresh && replies.state.contextRefresh.sessionId === saved?.sessionId && <p role="status">已更新当前聊天和有效资料，历史讨论仅作参考。</p>}
    {catalog?.phase === 'loading' && <p role="status">正在核对助手会话…</p>}
    {catalog?.selectionPending && catalog.phase !== 'loading' && <p role="alert">联系人已选中，助手讨论的操作结果尚待核对。{sessionRecovery}</p>}
    {catalog?.phase === 'failed' && !catalog.selectionPending && <p role="alert">助手会话列表暂不可用，请重新核对。{sessionRecovery}</p>}
    {confirmation && <AssistantSessionDeletionConfirmation busy={catalog?.phase === 'loading' || Boolean(catalog?.selectionPending)}
      onConfirm={confirmDelete} onCancel={() => setConfirmation(null)} />}
    {deleting && <p role="status">正在删除并核对助手会话…</p>}
    {replies.state.sessionDeletion === 'failed' && <p role="alert">助手会话删除尚未确认完成，请重试。
      <button disabled={!saved?.sessionId} onClick={() => void replies.deleteSavedSession({ contactId: replies.state.contactId!,
        scopeRevision: replies.state.scopeRevision, sessionId: saved!.sessionId!, confirmed: true })}>重试删除会话</button>
    </p>}
    {replies.state.sessionDeletion === 'deleted' && <p role="status">当前助手会话已删除。</p>}
    {replies.state.sessionDeletion === 'failed' && <UpdateBackupCleanupRecovery />}
    {replies.state.sessionDeletion === 'missing' && <p role="status">当前助手会话已不存在。</p>}
    {saved?.phase === 'loading' && <p role="status">正在读取已保存讨论…</p>}
    {saved?.phase === 'failed' && <p role="alert">已保存讨论暂不可用，请重新核对。
      {!catalog?.selectionPending && catalog?.phase !== 'failed' && sessionRecovery}
    </p>}
    {replies.state.sourceAvailability === 'checking' && <p role="status">正在核对删除后的依据…</p>}
    {replies.state.sourceAvailability === 'failed' && <p role="alert">删除后的依据尚未确认，原候选暂不可用。
      <button className="button" onClick={() => void replies.retrySourceValidation()}>重新核对依据</button>
    </p>}
    {!sqliteDiscussion && !deleting && <div className="session-actions" role="group" aria-label="准备助手讨论">
      <button className="button" disabled={!replies.state.contactId || busy || Boolean(replies.state.generationBlock)} onClick={() => void replies.newSavedSession()}>开始新讨论</button>
    </div>}
    {sqliteDiscussion && <>
      {window.notalone.sqliteDiscussion.candidates&&<SqliteReplyCandidatesPanel bridge={window.notalone.sqliteDiscussion} contactId={replies.state.contactId}
        scopeRevision={replies.state.scopeRevision} sessionId={saved.sessionId} disabled={discussionDisabled} readOnly={!currentDiscussion} initialDraft={initialDraft}
        onDraftChange={onDraftChange} onSubmitted={discussionSubmitted} />}
      <details className="sqlite-discussion-details">
        <summary>与助手讨论</summary>
        <SqliteDiscussionEntries entries={saved.discussionEntries!} recovery={saved.runtimeRecovery} />
        {catalog?.phase === 'ready' && currentDiscussion && <p className="session-view-state session-view-state-current" role="status">当前讨论：后续助手讨论会使用这段内容。</p>}
        {catalog?.phase === 'ready' && !currentDiscussion && <p className="session-view-state session-view-state-history" role="status">历史讨论仅回看，不会自动加入新候选；继续此讨论后才切换当前讨论。</p>}
        <SqliteDiscussionComposer bridge={window.notalone.sqliteDiscussion} contactId={replies.state.contactId}
          scopeRevision={replies.state.scopeRevision} sessionId={saved.sessionId} disabled={discussionDisabled || !currentDiscussion}
          onSubmitted={discussionSubmitted} />
      </details>
    </>}
    <details className="session-browser">
      <summary><span>历史讨论</span><small>仅回看，不会自动加入新候选</small>
      </summary>
      <div className="session-browser-content">
        <div className="session-actions" role="group" aria-label="助手会话操作">
    <button className="button" disabled={!replies.state.contactId || busy} onClick={() => void replies.newSavedSession()}>
      新开讨论
    </button>
    <button className="button" disabled={!replies.state.contactId || busy} onClick={() => void replies.listSavedSessions()}>刷新讨论列表</button>
        </div>
    {catalog?.phase === 'ready' && <ul className="session-catalog" aria-label="助手会话目录">
      {!catalog.items.length && <li>这位联系人还没有助手会话。</li>}
      {catalog.items.map((item, index) => <li className={`session-catalog-item ${item.isCurrent ? 'session-catalog-current' : 'session-catalog-history'}`} key={item.sessionId}>
        <button className="button" aria-label={`查看会话 ${item.sessionId}`} aria-pressed={item.sessionId === saved?.sessionId}
          disabled={busy} onClick={() => void replies.viewSavedSession(item.sessionId)}>查看讨论 {index + 1}</button>
        {item.isCurrent
          ? <span className="session-state session-state-current">当前讨论</span>
          : <span className="session-state session-state-history">历史讨论 · 仅回看</span>}
        {!item.isCurrent && <button className="button" disabled={busy} onClick={() => void replies.resumeSavedSession(item.sessionId)}>继续此讨论</button>}
        {item.sessionId === saved?.sessionId && <span className="session-state session-state-viewing">正在回看</span>}
        <details className="session-metadata"><summary>讨论详情</summary><p>会话编号：{item.sessionId}</p></details>
      </li>)}
    </ul>}
        <div className="session-actions" role="group" aria-label="正在查看的讨论操作">
    {saved?.sessionId && (catalog?.phase === 'failed' || catalog?.phase === 'ready' && !currentDiscussion)
      && <button className="button" disabled={busy} onClick={() => void replies.resumeSavedSession(saved.sessionId!)}>
      {catalog?.phase === 'failed' ? '重试继续此讨论' : '继续此讨论'}
    </button>}
    <button className="button" disabled={!replies.state.contactId || saved?.phase === 'loading' || deleting || catalog?.phase === 'loading' || catalog?.selectionPending} onClick={() => void replies.readSavedSession()}>
      {saved?.phase === 'failed' ? '重试读取已保存讨论' : '查看已保存讨论'}
    </button>
    <button className="button" disabled={!saved?.sessionId || saved.phase === 'loading' || deleting || catalog?.phase === 'loading' || catalog?.selectionPending}
      onClick={() => setConfirmation({ contactId: replies.state.contactId!, scopeRevision: replies.state.scopeRevision,
        sessionId: saved!.sessionId!, confirmed: true })}>删除正在查看的讨论</button>
        </div>
      </div>
    </details>
  </section>;
}
