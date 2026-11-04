import {SqliteReplyCandidatesPanel} from './SqliteReplyCandidatesPanel';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { AssistantSessionDeletion, ReplyGenerationJobState } from '../shared/reply-bridge';
import type { ReplySessionView } from './RewritePanel';
import type { SavedAssistantInput, SavedAssistantTurn } from '../shared/assistant-session';
import { AssistantInputBudgetNotice } from './AssistantInputBudgetNotice';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';
import { ExpressionPreferenceBasis } from './ExpressionPreferenceBasis';
import { UpdateBackupCleanupRecovery } from './UpdateBackupDeletionNotice';
import { SqliteDiscussionEntries } from './SqliteDiscussionEntries';
import { SqliteDiscussionComposer } from './SqliteDiscussionComposer';
import type { SqliteDiscussionReceipt } from '../shared/sqlite-discussion-bridge';

const generationStatusText: Record<ReplyGenerationJobState['phase'], string> = {
  preparing: '正在准备本次生成。',
  queued: '已准备，排队等待生成。', generating: '正在生成。', stopping: '正在停止本次生成…',
  cancelled: '本次生成已由你停止。', completed: '生成已完成。',
  failed: '生成失败，可核对原请求后重试。', unconfirmed: '任务结果待核对，可以先核对并停止本次生成。',
};
const backgroundGenerationStatusText: Partial<Record<ReplyGenerationJobState['phase'], string>> = {
  preparing: '正在另一助手会话中准备生成。',
  queued: '已在另一助手会话中后台排队生成。',
  generating: '正在另一助手会话中后台生成，结果会保存在原助手会话。',
  stopping: '正在停止另一助手会话中的后台生成。',
};

export function AssistantSessionDeletionConfirmation({ busy, onConfirm, onCancel }: {
  busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return <div className="session-confirmation" role="group" aria-label="确认删除助手讨论">
    <p>删除这段助手讨论、候选版本和运行使用痕迹后无法恢复。联系人、原始微信聊天、关系记忆和本人记忆不会删除。</p>
    <button className="button" disabled={busy} onClick={onConfirm}>确认删除讨论</button>
    <button className="button" onClick={onCancel}>取消删除</button>
  </div>;
}

function SavedTurn({ turn, index, retry, busy, showPreferences }: {
  turn: SavedAssistantTurn; index: number; retry?: () => void; busy: boolean; showPreferences: boolean;
}) {
  return <article className="session-entry" aria-label={`第${index + 1}轮讨论`}>
    <details className="session-entry-details"><summary>第{index + 1}轮讨论{turn.state === 'failed' ? ' · 生成未完成' : turn.state === 'running' ? ' · 生成中' : ''}</summary>
    <div className="session-entry-content">
    {turn.placeholder ? <p>{turn.placeholder}</p> : <>
      <ReplyBasisChangeNotice changes={turn.basisChanges} />
      <p>{typeof turn.input?.content.draft_text === 'string' ? turn.input.content.draft_text
        : typeof turn.input?.content.direction === 'string' ? turn.input.content.direction
        : typeof turn.input?.content.purpose === 'string' ? turn.input.content.purpose : '本轮回复输入'}</p>
      {turn.input?.content.input_kind === 'current_chat' && <p>本次粘贴的对方文字，未经渠道核验。表达方向：{String(turn.input.content.pasted_direction ?? '')}</p>}
      {turn.input?.content.input_kind === 'workspace' && <>
        <p>{turn.input.content.workspace_action === 'suggest' ? '帮我想想 · 建议不代表已确认立场' : '帮我表达'}</p>
        {typeof turn.input.content.context_text === 'string' && <p>补充聊天：{turn.input.content.context_text}</p>}
      </>}
      {typeof turn.input?.content.user_instruction === 'string' && <p>{turn.input.content.user_instruction}</p>}
      {turn.input?.allow_incomplete_history === true && <p role="status">历史覆盖不完整：本次已明确选择基于已同步部分继续，不能视为完整语境。</p>}
      <p>原精确场景：{turn.input?.scene ?? '未声明'}</p>
      {turn.reply?.usedSkill && <p>本轮实际 Skill：{turn.reply.usedSkill.name} · 版本 {turn.reply.usedSkill.versionNumber ?? turn.reply.usedSkill.versionId}
        {turn.reply.usedSkill.scope && ` · 范围：${turn.reply.usedSkill.scope.kind === 'scene' ? `精确场景「${turn.reply.usedSkill.scope.scene}」` : turn.reply.usedSkill.scope.kind === 'contact' ? '当前联系人' : '本人通用'}`}
        {!!turn.reply.usedSkill.executionView?.policyRevision && ` · 当时已排除本范围停用方法，允许${turn.reply.usedSkill.executionView.methodIds.length}种做法`}</p>}
      {turn.state === 'running' && <p>本轮生成尚未完成。</p>}
      {turn.state === 'failed' && <p>{turn.interruptionReason === 'user_cancelled' ? '上次生成已由你停止。'
        : turn.interruptionReason === 'configuration_reload' ? '上次生成因设置重载中断。'
        : turn.interruptionReason === 'app_quit' ? '上次生成中断。' : '本轮生成未成功保存。'}</p>}
      {turn.interruptionReason !== null && retry && !turn.requiresReprepare && <button disabled={busy} onClick={retry}>重试上次中断生成</button>}
      {turn.requiresReprepare && <p>这次准备格式已变化，已保存的输入会保留；请明确重新准备。</p>}
      {turn.reply?.inputBudget && <AssistantInputBudgetNotice budget={turn.reply.inputBudget} historical />}
      {showPreferences && <ExpressionPreferenceBasis preferences={turn.reply?.expressionPreferences ?? []} />}
      {turn.reply?.candidates.map((candidate) => <p key={candidate.candidateId}
        data-assistant-candidate-id={candidate.candidateId}
        data-assistant-reply-request-id={turn.reply!.replyRequestId}>{candidate.text}</p>)}
    </>}
    </div></details>
  </article>;
}
function SavedDiscussion({ input }: { input: SavedAssistantInput }) {
  const content = input.content;
  if (content?.type === 'candidate_carry') return <article className="session-entry" aria-label="携入的已选版本">
    <details className="session-entry-details"><summary>携入的已选版本</summary><div className="session-entry-content">
    <p>携入的已选版本，仅作表达参考。</p>
    <ReplyBasisChangeNotice changes={input.basisChanges} />
    {content.messages.map((message) => <p key={message.messageId}>{message.text}</p>)}
    </div></details>
  </article>;
  return <article className="session-entry" aria-label="已保存的方向讨论">
    <details className="session-entry-details"><summary>方向讨论</summary><div className="session-entry-content">
    {input.placeholder ? <p>{input.placeholder}</p> : content && <dl>
      {content.type === 'purpose_exploration' ? <><dt>当时的主动目的</dt><dd>{content.purposeHint}</dd></>
        : <><dt>当时选择的消息</dt><dd>{content.targetMessageId}</dd></>}
      {(content.correction || content.requirements) && <><dt>补充你的想法或要求</dt>
        <dd>{[content.correction, content.requirements].filter(Boolean).join('\n')}</dd></>}
      {content.answer && <><dt>关键问题回答</dt><dd>{content.answer}</dd></>}
      {content.confirmedIntent && <><dt>已确认的本次意愿</dt><dd>{content.confirmedIntent}</dd></>}
      <dt>当时的策略选择</dt><dd>{content.skillMode === 'disabled' ? '使用通用流程'
        : content.skillMode === 'auto' ? '按当时场景选择' : `指定版本 ${content.skillVersionId}`}</dd>
      <dt>当时的精确场景</dt><dd>{content.skillScene ?? '未声明'}</dd>
    </dl>}
    </div></details>
  </article>;
}

export function AssistantSessionBudgetNotice({ replies }: { replies: ReplySessionView }) {
  const { state } = replies;
  const notice = state.inputBudgetNotice;
  const budget = notice?.contactId === state.contactId && notice.scopeRevision === state.scopeRevision
    && notice.sessionId === state.savedSession?.sessionId && !state.sourceAvailability ? notice.decision : undefined;
  if (!budget || budget.state === 'ready' && budget.measurementKind !== 'approximate') return null;
  return budget.state === 'ready'
    ? <details className="reply-budget-details"><summary>输入长度说明</summary><AssistantInputBudgetNotice budget={budget} /></details>
    : <AssistantInputBudgetNotice budget={budget} />;
}

export function AssistantSessionPanel({ replies, initialDraft = '', onInitialDraftTaken, onDraftChange }: {
  replies: ReplySessionView; initialDraft?: string; onInitialDraftTaken?: () => void;
  onDraftChange?: (text: string, scope: { contactId: string; scopeRevision: number }) => void;
}) {
  const saved = replies.state.savedSession;
  const [confirmation, setConfirmation] = useState<AssistantSessionDeletion | null>(null);
  const [copyError, setCopyError] = useState(false);
  const copyScopeKey = `${replies.state.contactId}:${replies.state.scopeRevision}:${saved?.sessionId}`;
  const currentCopyScope = useRef(copyScopeKey); currentCopyScope.current = copyScopeKey;
  const deleting = replies.state.sessionDeletion === 'deleting';
  const catalog = replies.state.sessionCatalog;
  const sqliteDiscussion = saved?.discussionEntries !== undefined;
  const contactScopeKey = `${replies.state.contactId}:${replies.state.scopeRevision}`;
  const currentContactScope = useRef(contactScopeKey); currentContactScope.current = contactScopeKey;
  const currentContactJobs = replies.state.generationJobs?.filter((job) => job.contactId === replies.state.contactId) ?? [];
  const activeContactJobs = currentContactJobs.filter((job) => ['preparing', 'queued', 'generating', 'stopping', 'unconfirmed'].includes(job.phase));
  const visibleJob = activeContactJobs.length === 1 ? activeContactJobs[0] : undefined;
  const displayedJobs = visibleJob
    ? [...currentContactJobs.filter((job) => job.sessionId === saved?.sessionId
      && job.requestKey !== visibleJob.requestKey), visibleJob]
    : saved?.sessionId ? currentContactJobs.filter((job) => job.sessionId === saved.sessionId) : [];
  const stoppedTurn = saved?.phase === 'ready' ? saved.turns.at(-1) : undefined;
  const stoppedNotice = stoppedTurn?.interruptionReason === 'user_cancelled'
    && stoppedTurn.inputVersionId === saved?.currentInputVersionId;
  const busy = deleting || catalog?.phase === 'loading' || saved?.phase === 'loading'
    || replies.state.sessionDeletion === 'failed' || replies.state.sourceAvailability === 'checking';
  const currentDiscussion = catalog?.phase === 'ready' && !catalog.selectionPending
    && !!saved?.sessionId && catalog.currentSessionId === saved.sessionId;
  const discussionDisabled = Boolean(replies.state.generationBlock) || busy || !!confirmation || !currentDiscussion || saved?.phase !== 'ready'
    || Boolean(replies.state.sourceAvailability) || replies.state.phase === 'waiting' || activeContactJobs.length > 0
    || replies.state.sessionDeletion === 'deleted' || replies.state.sessionDeletion === 'missing';
  useEffect(() => { setConfirmation(null); setCopyError(false); }, [replies.state.contactId, replies.state.scopeRevision, saved?.sessionId]);
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
  function noteHistoricalCopy(event: ClipboardEvent<HTMLElement>) {
    const selection = window.getSelection(); const text = selection?.toString() ?? '';
    if (!selection || !text.trim() || !replies.state.contactId) return;
    const nodes = [selection.anchorNode, selection.focusNode];
    const candidate = nodes.map((node) => (node instanceof Element ? node : node?.parentElement)
      ?.closest('[data-assistant-candidate-id]')).find((element) => element && event.currentTarget.contains(element));
    const candidateId = candidate?.getAttribute('data-assistant-candidate-id');
    const replyRequestId = candidate?.getAttribute('data-assistant-reply-request-id');
    if (!candidateId || !replyRequestId) return;
    // 混合或超长选区仍交给唯一来源控制器核验，拒绝后不能粘贴回其他候选。
    void window.notalone.candidateProvenance.noteCandidateCopy({ contactId: replies.state.contactId,
      scopeRevision: replies.state.scopeRevision, replyRequestId, candidateId, text: text.slice(0, 65_536),
      ...(text.length > 65_536 ? { invalidSelection: true as const } : {}) })
      .then(() => { if (currentCopyScope.current === copyScopeKey) setCopyError(false); })
      .catch(() => { if (currentCopyScope.current === copyScopeKey) setCopyError(true); });
  }
  return <section className={`assistant-session-panel${sqliteDiscussion ? ' assistant-session-panel-sqlite' : ''}`} aria-label="助手会话">
    {replies.state.idleRollover?.sessionId === saved?.sessionId && replies.state.contactId && <p role="status">已开启新讨论
      <button disabled={busy} onClick={() => void replies.resumeSavedSession(replies.state.idleRollover!.previousSessionId)}>继续上一段</button>
    </p>}
    {replies.state.contextRefresh?.sessionId === saved?.sessionId && <p role="status">已更新当前聊天和有效资料，历史讨论仅作参考。</p>}
    {catalog?.phase === 'loading' && <p role="status">正在核对助手会话…</p>}
    {catalog?.selectionPending && catalog.phase !== 'loading' && <p role="alert">助手会话操作尚未确认，请刷新列表后明确选择会话。</p>}
    {catalog?.phase === 'failed' && !catalog.selectionPending && <p role="alert">助手会话列表暂不可用，请刷新重试。</p>}
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
    {stoppedNotice && <p role="status">本次生成已停止，没有保存候选。你可以重新生成，或从历史讨论中重试这次中断的输入。</p>}
    {Boolean(replies.state.generationRecoveryPending) && <p>旧连接有 {replies.state.generationRecoveryPending} 项结果待核对，退出时会通过原连接完成核对。累计未核对任务达到 32 项时暂停接纳，请先完成退出核对。</p>}
    {displayedJobs.map(job => <div key={job.requestKey} className="session-generation-status">
      <p role="status">{job === visibleJob && saved?.sessionId && job.sessionId !== saved.sessionId
        ? backgroundGenerationStatusText[job.phase] ?? generationStatusText[job.phase]
        : generationStatusText[job.phase]}</p>
      {(job === visibleJob || job.phase === 'unconfirmed') && job.phase !== 'stopping' && <button
        aria-label="停止本次生成"
        disabled={deleting}
        onClick={() => void replies.stopGeneration(job.sessionId, job.requestKey, job.inputVersionId)}>
        停止本次生成
      </button>}
    </div>)}
    {saved?.phase === 'loading' && <p role="status">正在读取已保存讨论…</p>}
    {saved?.phase === 'failed' && <p role="alert">已保存讨论暂不可用，请重试读取。</p>}
    {copyError && <p role="alert">复制来源暂不可确认，请重新读取讨论后核对。</p>}
    {sqliteDiscussion && <>
      {window.notalone.sqliteDiscussion.candidates&&<SqliteReplyCandidatesPanel bridge={window.notalone.sqliteDiscussion} contactId={replies.state.contactId}
        scopeRevision={replies.state.scopeRevision} sessionId={saved.sessionId} disabled={discussionDisabled} initialDraft={initialDraft}
        onInitialDraftTaken={onInitialDraftTaken} onDraftChange={onDraftChange} onSubmitted={discussionSubmitted} />}
      <details className="sqlite-discussion-details">
        <summary>与助手讨论</summary>
        <SqliteDiscussionEntries entries={saved.discussionEntries!} recovery={saved.runtimeRecovery} />
        {catalog?.phase === 'ready' && currentDiscussion && <p className="session-view-state session-view-state-current" role="status">当前讨论：后续助手讨论会使用这段内容。</p>}
        {catalog?.phase === 'ready' && !currentDiscussion && <p className="session-view-state session-view-state-history" role="status">历史讨论仅回看，不会自动加入新候选；继续此讨论后才切换当前讨论。</p>}
        <SqliteDiscussionComposer bridge={window.notalone.sqliteDiscussion} contactId={replies.state.contactId}
          scopeRevision={replies.state.scopeRevision} sessionId={saved.sessionId} disabled={discussionDisabled}
          onSubmitted={discussionSubmitted} />
      </details>
    </>}
    <details className="session-browser">
      <summary><span>历史讨论</span><small>仅回看，不会自动加入新候选</small>
        {saved?.phase === 'ready' && saved.turns.some((turn) => turn.state === 'failed')
          && <span className="session-attention">历史中有未完成的生成，请展开查看</span>}
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
    {saved?.sessionId && (replies.state.errorCode === 'resume_required' || catalog?.phase === 'failed' || catalog?.phase === 'ready' && !currentDiscussion)
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
    {saved?.phase === 'ready' && !sqliteDiscussion && <section className="session-history" aria-label="已保存的讨论" onCopy={noteHistoricalCopy}>
      {!saved.inputs.length && <p>当前会话还没有讨论。</p>}
      {saved.inputs.map((input) => {
        if (input.type !== 'generation') return <SavedDiscussion key={input.inputVersionId} input={input} />;
        const index = saved.turns.findIndex((turn) => turn.turnId === input.turnId && turn.inputVersionId === input.inputVersionId);
        return index < 0 ? null : <SavedTurn key={input.inputVersionId} turn={saved.turns[index]} index={index}
          showPreferences={!replies.state.sourceAvailability}
          busy={busy || replies.state.phase === 'waiting' || Boolean(replies.state.generationBlock)}
          retry={saved.currentInputVersionId === input.inputVersionId ? () => void replies.retryInterruptedGeneration(
            saved.sessionId!, saved.turns[index].turnId, input.inputVersionId) : undefined} />;
      })}
    </section>}
      </div>
    </details>
  </section>;
}
