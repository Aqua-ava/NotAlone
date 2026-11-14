import { useEffect, useState } from 'react';
import type { RewriteOptions } from '../shared/reply-bridge';
import type { ContactSessionView } from './contact-session';
import { HelperDraft } from './contact-session';
import type { ReplySessionView } from './RewritePanel';
import { Icon } from './icons';

const workspaceOptions = (options: RewriteOptions): RewriteOptions => ({ ...options,
  inputKind: 'workspace', includeRelationshipContext: options.inputKind === 'workspace' ? options.includeRelationshipContext : true });

interface WorkspaceSubmission { contactId: string | null; scopeRevision: number; sessionId: string | null | undefined; }

export function UnifiedReplyWorkspace({ contacts, replies }: { contacts: ContactSessionView; replies: ReplySessionView }) {
  const { state } = replies;
  const options = workspaceOptions(state.options);
  const [submission, setSubmission] = useState<WorkspaceSubmission | null>(null);
  const submitting = submission !== null && submission.contactId === state.contactId
    && submission.scopeRevision === state.scopeRevision && submission.sessionId === state.savedSession?.sessionId;
  const workspaceReady = state.options.inputKind === 'workspace' && state.mode === 'rewrite_draft';
  useEffect(() => {
    if (state.contactId && state.contactId === contacts.state.selectedContactId && state.savedSession?.phase === 'ready'
      && state.sessionCatalog?.phase !== 'loading' && !state.sessionCatalog?.selectionPending
      && state.phase !== 'waiting' && !workspaceReady && state.sourceAvailability === undefined) void replies.enterWorkspace();
  }, [state.contactId, state.scopeRevision, state.inputClearRevision, state.savedSession?.phase,
    state.phase, state.sourceAvailability, state.generationBlock, state.sessionCatalog?.phase,
    state.sessionCatalog?.selectionPending, contacts.state.selectedContactId, workspaceReady]);
  const sameScope = Boolean(state.contactId) && state.contactId === contacts.state.selectedContactId
    && state.scopeRevision === contacts.state.scopeRevision;
  // 讨论加载与工作区准备期间保留独立想法；旧聊天输入仍须经过工作区迁移。
  const localDraftOnly = sameScope && state.mode === 'rewrite_draft' && state.options.inputKind === undefined
    && !state.result && state.sessionCatalog?.phase !== 'loading' && !state.sessionCatalog?.selectionPending;
  const viewingHistory = Boolean(state.sessionCatalog) && Boolean(state.savedSession?.sessionId)
    && state.savedSession?.sessionId !== state.sessionCatalog?.currentSessionId;
  const operationBlocked = !sameScope || submitting || state.phase === 'waiting'
    || state.sessionCatalog?.phase === 'loading' || state.sessionCatalog?.selectionPending === true
    || state.sourceAvailability !== undefined || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed';
  const inputBlocked = viewingHistory || operationBlocked;
  const draftDisabled = inputBlocked || !workspaceReady && !localDraftOnly;
  const disabled = inputBlocked || !workspaceReady || Boolean(state.generationBlock)
    || state.savedSession?.phase !== 'ready' || !state.savedSession.sessionId;
  async function generate(action: 'express' | 'suggest') {
    const pending = { contactId: state.contactId, scopeRevision: state.scopeRevision, sessionId: state.savedSession?.sessionId };
    setSubmission(pending);
    try {
      await replies.generateWorkspace(action, options);
    } finally {
      // 旧范围的迟到完成只能解除自己的提交，不能影响用户切换后的新提交。
      setSubmission(current => current === pending ? null : current);
    }
  }
  if (sameScope && state.savedSession?.phase === 'ready' && state.savedSession.sessionId === null) {
    return <section className="compose-panel unified-workspace" aria-label="表达工作区">
      <header className="compose-heading"><h2>有什么想说的？</h2><p>先开始这位联系人的助手会话，再生成候选。</p></header>
      <HelperDraft key={`${state.contactId}:${state.scopeRevision}`} session={contacts} workspace disabled={inputBlocked} placeholder="写下你的想法或草稿…" />
      {state.generationBlock && <p role="status">请先在上方确认本次联系人。</p>}
      <button className="button" disabled={inputBlocked || Boolean(state.generationBlock)} onClick={() => void replies.newSavedSession()}>开始助手会话</button>
      <p>已写下的想法会保留到新会话。</p>
    </section>;
  }
  return <section className="compose-panel unified-workspace" aria-label="表达工作区">
    <header className="compose-heading"><span className="section-eyebrow">一起想，把话说好</span>
      <h2>有什么想说的？</h2><p>想说什么、希望什么语气，都可以写在这里；没有思路，也可以让我帮你想。</p></header>
    {workspaceReady || localDraftOnly || !contacts.state.selectedContactId ? <HelperDraft
      key={`${contacts.state.selectedContactId}:${contacts.state.scopeRevision}`} session={contacts} workspace disabled={draftDisabled} restoreRevision={state.inputClearRevision} />
      : null}
    {sameScope && state.savedSession?.phase === 'loading' && <p role="status">正在加载上次的助手讨论…</p>}
    {state.workspaceMigrationNotice && <p role="status" className="rewrite-privacy">{state.workspaceMigrationNotice}</p>}
    {state.generationBlock && <p role="status" className="rewrite-privacy">生成前，请先在上方确认本次联系人。</p>}
    {sameScope && state.savedSession?.phase === 'failed' && <p role="alert">上次的助手讨论暂时无法加载。可重试读取，或开始新讨论后继续。
      <button className="button" disabled={operationBlocked} onClick={() => void replies.readSavedSession()}>重新读取助手会话</button>
      <button className="button" disabled={operationBlocked || Boolean(state.generationBlock)} onClick={() => void replies.newSavedSession()}>开始新讨论</button></p>}
    <div className="workspace-actions">
      <button className="generate-button" aria-label="帮我表达" disabled={disabled || !contacts.state.draft.trim()}
        onClick={() => void generate('express')}><Icon name="write" size={18} />帮我表达</button>
      <button className="compose-primary workspace-suggest" aria-label="帮我想想" disabled={disabled}
        onClick={() => void generate('suggest')}><Icon name="sparkle" size={18} />帮我想想</button>
    </div>
    <p className="workspace-action-hint">有想法，帮你组织表达；没思路，给你几种说法和建议理由。</p>
    <p className="rewrite-privacy">候选供你选择和修改，由你亲自发送。想法和要求只作用于本次生成。</p>
    {state.canRetry && <button className="button" disabled={disabled} onClick={() => void replies.generate()}>重试同一次生成</button>}
  </section>;
}
