import { useEffect, useState } from 'react';
import type { RewriteOptions, RewriteTone } from '../shared/reply-bridge';
import type { ContactSessionView } from './contact-session';
import { HelperDraft } from './contact-session';
import type { ReplySessionView } from './RewritePanel';
import { Icon } from './icons';

const workspaceOptions = (options: RewriteOptions): RewriteOptions => ({ ...options,
  inputKind: 'workspace', includeRelationshipContext: options.inputKind === 'workspace' ? options.includeRelationshipContext : true });

interface WorkspaceSubmission { contactId: string | null; scopeRevision: number; sessionId: string | null | undefined; }

export function UnifiedReplyWorkspace({ contacts, replies }: { contacts: ContactSessionView; replies: ReplySessionView }) {
  const { state } = replies;
  const [options, setOptions] = useState(() => workspaceOptions(state.options));
  const [submission, setSubmission] = useState<WorkspaceSubmission | null>(null);
  const submitting = submission !== null && submission.contactId === state.contactId
    && submission.scopeRevision === state.scopeRevision && submission.sessionId === state.savedSession?.sessionId;
  const workspaceReady = state.options.inputKind === 'workspace' && state.mode === 'rewrite_draft';
  useEffect(() => { setOptions(workspaceOptions(state.options)); }, [state.scopeRevision, state.inputClearRevision]);
  useEffect(() => {
    if (state.contactId && state.contactId === contacts.state.selectedContactId && state.savedSession?.phase === 'ready'
      && state.sessionCatalog?.phase !== 'loading' && !state.sessionCatalog?.selectionPending
      && state.phase !== 'waiting' && !workspaceReady && state.sourceAvailability === undefined) void replies.enterWorkspace();
  }, [state.contactId, state.scopeRevision, state.inputClearRevision, state.savedSession?.phase,
    state.phase, state.sourceAvailability, state.generationBlock, state.sessionCatalog?.phase,
    state.sessionCatalog?.selectionPending, contacts.state.selectedContactId, workspaceReady]);
  useEffect(() => {
    if (workspaceReady && state.savedSession?.phase === 'ready' && state.contactId
      && state.contactId === contacts.state.selectedContactId && state.messages.phase === 'idle') {
      void replies.loadMessages();
    }
  }, [workspaceReady, state.savedSession?.phase, state.contactId, state.scopeRevision, state.inputClearRevision,
    contacts.state.selectedContactId, state.messages.phase]);
  const sameScope = Boolean(state.contactId) && state.contactId === contacts.state.selectedContactId
    && state.scopeRevision === contacts.state.scopeRevision;
  // 新联系人尚无可读取会话时，只开放其独立本地草稿；不把旧输入迁移或授权为生成上下文。
  const localDraftOnly = sameScope && Boolean(state.generationBlock) && state.savedSession?.phase === 'failed'
    && state.savedSession.sessionId === null && state.mode === 'rewrite_draft' && state.options.inputKind === undefined
    && !state.result && state.sessionCatalog?.phase !== 'loading' && !state.sessionCatalog?.selectionPending;
  const inputBlocked = !sameScope || submitting || state.phase === 'waiting'
    || state.savedSession?.phase === 'loading' || state.sessionCatalog?.phase === 'loading' || state.sessionCatalog?.selectionPending === true
    || state.sourceAvailability !== undefined || state.sessionDeletion === 'deleting';
  const draftDisabled = inputBlocked || !workspaceReady && !localDraftOnly;
  const disabled = inputBlocked || !workspaceReady || Boolean(state.generationBlock);
  const update = (value: Partial<RewriteOptions>) => {
    const next = { ...options, ...value }; setOptions(next); void replies.updateOptions(next);
  };
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
  const latest = state.messages.items.reduce<string | null>((value, message) => {
    const time = message.occurredAt;
    return time && (!value || Date.parse(time) > Date.parse(value)) ? time : value;
  }, null);
  const excluded = options.excludedMessageIds ?? [];
  return <section className="compose-panel unified-workspace" aria-label="表达工作区">
    <header className="compose-heading"><span className="section-eyebrow">一起想，把话说好</span>
      <h2>有什么想说的？</h2><p>写下想法、方向或草稿；没有思路，也可以让我帮你想。</p></header>
    {workspaceReady || localDraftOnly || !contacts.state.selectedContactId ? <HelperDraft
      key={`${contacts.state.selectedContactId}:${contacts.state.scopeRevision}`} session={contacts} workspace disabled={draftDisabled} />
      : <p role="status">正在恢复这位联系人的想法和聊天背景…</p>}
    {state.workspaceMigrationNotice && <p role="status" className="rewrite-privacy">{state.workspaceMigrationNotice}</p>}
    {state.generationBlock && <p role="status" className="rewrite-privacy">生成前，请先在上方确认本次联系人。</p>}
    <div className="workspace-actions">
      <button className="generate-button" aria-label="帮我表达" disabled={disabled || !contacts.state.draft.trim()}
        onClick={() => void generate('express')}><Icon name="write" size={18} />帮我表达</button>
      <button className="compose-primary workspace-suggest" aria-label="帮我想想" disabled={disabled}
        onClick={() => void generate('suggest')}><Icon name="sparkle" size={18} />帮我想想</button>
    </div>
    <p className="workspace-action-hint">有想法，帮你组织表达；没思路，给你几种说法和建议理由。</p>
    <details className="workspace-context">
      <summary>最近聊天 · 查看／补充</summary>
      <div className="workspace-context-body">
        <label className="rewrite-context"><input type="checkbox" checked={options.includeRelationshipContext} disabled={disabled}
          onChange={event => update({ includeRelationshipContext: event.target.checked })} />参考最近聊天和相关关系资料</label>
        {latest && <p className="rewrite-privacy">最近一条：{new Date(latest).toLocaleString('zh-CN')}</p>}
        {state.messages.phase === 'loading' && <p role="status">正在读取最近聊天…</p>}
        {state.messages.phase === 'failed' && <p role="status">最近聊天暂时无法读取，可以刷新或补充聊天内容。</p>}
        {state.messages.phase === 'ready' && !state.messages.items.length && <p>暂无可用的最近聊天。可以补充上下文，或先写下想法。</p>}
        <button disabled={disabled || state.messages.phase === 'loading'} onClick={() => void replies.loadMessages()}>刷新最近聊天</button>
        {state.messages.items.length > 0 && <>
          <p className="rewrite-privacy">以下是最近记录；取消勾选可从本次生成中排除。实际使用的依据会随候选展示。</p>
          {excluded.length > 0 && <p role="status" className="rewrite-privacy">已排除 {excluded.length} 条消息。本次自动背景只参考未排除的最近聊天和补充内容，避免关系资料带回已排除的内容。</p>}
          <div className="workspace-message-list" role="group" aria-label="最近聊天材料">
            {state.messages.items.map(message => <label className="reply-message" key={message.messageId}>
              <input type="checkbox" aria-label={`使用消息：${message.text ?? message.mediaPlaceholder ?? '无文字内容'}`}
                checked={!excluded.includes(message.messageId)} disabled={disabled || !options.includeRelationshipContext}
                onChange={event => update({ excludedMessageIds: event.target.checked
                  ? excluded.filter(id => id !== message.messageId) : [...excluded, message.messageId] })} />
              <span><small>{message.speaker === 'contact' ? '对方' : message.speaker === 'user' ? '我' : '系统'} · {message.occurredAt ? new Date(message.occurredAt).toLocaleString('zh-CN') : '时间未知'}</small>
                <span className="reply-message-text">{message.text ?? message.mediaPlaceholder ?? '无文字内容'}</span></span>
            </label>)}
          </div>
        </>}
        <label>补充聊天上下文<textarea aria-label="补充聊天上下文" rows={3} maxLength={65_536}
          disabled={disabled} value={options.contextText ?? ''} placeholder="只粘贴这位联系人的聊天内容，建议标明是谁说的话。"
          onChange={event => update({ contextText: event.target.value })} /></label>
        <p className="rewrite-privacy">补充内容只作为本次聊天背景，不会被当成你的表达意图。</p>
      </div>
    </details>
    <details className="compose-settings"><summary>语气和本次要求</summary>
      <div className="rewrite-options">
        <label>本次语气<select aria-label="本次语气" value={options.tone} disabled={disabled}
          onChange={event => update({ tone: event.target.value as RewriteTone })}>
          <option value="original">自然表达</option><option value="warm">自然温和</option>
          <option value="concise">简洁直接</option><option value="polite">礼貌克制</option></select></label>
        <label className="rewrite-instruction">本次要求<input aria-label="本次要求" maxLength={4096} disabled={disabled}
          value={options.instruction} placeholder="可选，如简短一点、不增加承诺"
          onChange={event => update({ instruction: event.target.value })} /></label>
      </div>
    </details>
    <p className="rewrite-privacy">候选供你选择和修改，由你亲自发送。想法和要求只作用于本次生成。</p>
    {state.canRetry && <button disabled={disabled} onClick={() => void replies.generate()}>重试同一次生成</button>}
  </section>;
}
