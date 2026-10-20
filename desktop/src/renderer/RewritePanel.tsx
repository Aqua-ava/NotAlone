import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { AssistantSessionDeletion, ReplyMode, ReplySessionState, RewriteOptions, RewriteTone } from '../shared/reply-bridge';
import { HelperDraft, type ContactSessionView } from './contact-session';
import { Icon } from './icons';
import { useRevisionedSession } from './use-revisioned-session';
import './rewrite.css';
import { ReplyEvidence, useReplyEvidence } from './ReplyEvidence';
import { AssistantSessionBudgetNotice, AssistantSessionPanel } from './AssistantSessionPanel';
import { hasChangedReplyInput } from './ReplyGenerationGuidance';
import { StyleSamples } from './StyleSamples';
import { ExpressionPreferences } from './ExpressionPreferences';
import { CandidateCopyControls } from './CandidateCopyControls';
import { CandidateVersionEditor } from './CandidateVersionEditor';
import type { ReplyCandidateDraftUpdate, ReplyCandidateVersionRead, ReplyCandidateVersionEdit, ReplyCandidateVersionDisplay } from '../shared/assistant-candidate-versions';
import type { RequirementChange } from '../shared/assistant-continuation-clarification';
import { AssistantContinuationControls } from './AssistantContinuationControls';
import { AssistantMessageNoticeActions } from './AssistantMessageNoticeActions';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';
import { ReplySceneInput } from './ReplySceneInput';

export function useReplySession() {
  const { state, error, setError, latest, active, receive } = useRevisionedSession<ReplySessionState>({ revision: -1, scopeRevision: 0, contactId: null, generationBlock: 'foreground-confirmation-required',
    options: { tone: 'original', instruction: '', includeRelationshipContext: false },
    mode: 'rewrite_draft', scene: '', messages: { phase: 'idle', items: [], nextCursor: null }, targetMessageId: null, direction: '', purpose: '',
    correction: '', requirements: '', clarificationAnswer: '', skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], exploration: { phase: 'idle', result: null },
    messageNotice: { phase: 'idle', changed: false, needsRefresh: false },
    phase: 'idle', result: null, selectedCandidateId: null, canRetry: false }, window.notalone.replies);
  async function operate(operation: () => Promise<ReplySessionState | void>) {
    const scopeRevision = latest.current.scopeRevision;
    try { const next = await operation(); if (next) receive(next); if (active.current && scopeRevision === latest.current.scopeRevision) setError(''); }
    catch { if (active.current && scopeRevision === latest.current.scopeRevision) setError('本次表达操作暂时不可用，请重新确认联系人。'); }
  }
  const selection = () => ({ contactId: latest.current.contactId!, scopeRevision: latest.current.scopeRevision });
  async function versionOperation(operation: () => Promise<ReplySessionState>) {
    const scopeRevision = latest.current.scopeRevision;
    try {
      const next = await operation(); receive(next);
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('');
    } catch (error) {
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('本组版本操作尚未确认，请保留编辑后重试。');
      throw error;
    }
  }
  const modeChange = useRef(0);
  function changeMode(mode: ReplyMode, inputKind?: RewriteOptions['inputKind'], preferPasteWhenEmpty = false) {
    const operation = ++modeChange.current;
    const scope = selection();
    const current = () => active.current && operation === modeChange.current
      && latest.current.contactId === scope.contactId && latest.current.scopeRevision === scope.scopeRevision;
    return operate(async () => {
      if (inputKind) {
        receive(await window.notalone.replies.updateOptions({ ...scope, options: { ...latest.current.options, inputKind } }));
        if (!current()) return;
      }
      await window.notalone.replies.setMode({ ...scope, mode });
      if (!current()) return;
      receive(await window.notalone.replies.getState());
      if (!current() || !preferPasteWhenEmpty) return;
      const next = latest.current;
      if (next.mode === 'reply_to_message' && next.messages.phase === 'ready' && !next.messages.items.length) {
        receive(await window.notalone.replies.updateOptions({ ...scope, options: { ...next.options, inputKind: 'current_chat' } }));
        if (current()) await window.notalone.replies.setMode({ ...scope, mode: 'rewrite_draft' });
      }
    });
  }
  return { state, error,
    enterWorkspace: () => operate(() => window.notalone.replies.enterWorkspace(selection())),
    updateCandidateVersionDraft: (request: ReplyCandidateDraftUpdate) => versionOperation(() => window.notalone.replies.updateCandidateVersionDraft(request)),
    readCandidateVersions: (request: ReplyCandidateVersionRead) => versionOperation(() => window.notalone.replies.readCandidateVersions(request)),
    saveCandidateVersion: (request: ReplyCandidateVersionEdit) => versionOperation(() => window.notalone.replies.saveCandidateVersion(request)),
    showCandidateVersion: (request: ReplyCandidateVersionDisplay) => versionOperation(() => window.notalone.replies.showCandidateVersion(request)),
    updateOptions: (options: RewriteOptions) => operate(() => window.notalone.replies.updateOptions({ ...selection(), options })),
    setMode: changeMode,
    loadMessages: (older = false) => operate(() => window.notalone.replies.loadMessages({ ...selection(), older })),
    retrySourceValidation: () => operate(() => window.notalone.replies.retrySourceValidation(selection())),
    readSavedSession: () => operate(() => window.notalone.replies.readSavedSession(selection())),
    listSavedSessions: () => operate(() => window.notalone.replies.listSavedSessions(selection())),
    newSavedSession: () => operate(() => window.notalone.replies.newSavedSession(selection())),
    newSavedSessionWithCandidate: (request: Pick<ReplyCandidateVersionDisplay, 'sessionId' | 'candidateId' | 'versionId'>) => operate(async () => {
      const scope = selection();
      const selected = await window.notalone.replies.selectCandidateVersion({ ...scope, ...request, selectionKey: crypto.randomUUID() });
      receive(selected);
      const choice = selected.explicitCandidateSelection;
      if (!active.current || latest.current.contactId !== scope.contactId || latest.current.scopeRevision !== scope.scopeRevision
        || selected.savedSession?.sessionId !== request.sessionId || choice?.phase !== 'ready'
        || choice.selection?.sessionId !== request.sessionId || choice.selection.candidateId !== request.candidateId
        || choice.selection.versionId !== request.versionId) throw new Error('要携入的回复版本尚未核对，请重试。');
      return window.notalone.replies.newSavedSessionWithCandidate({ ...scope, ...request,
        expectedSelectionId: choice.selection.selectionId });
    }),
    selectSavedSession: (sessionId: string) => operate(() => window.notalone.replies.selectSavedSession({ ...selection(), sessionId })),
    deleteSavedSession: (command: AssistantSessionDeletion) => operate(() => window.notalone.replies.deleteSavedSession(command)),
    reconnectMessages: () => operate(() => window.notalone.replies.reconnectMessages(selection())),
    combineNewMessages: () => operate(() => window.notalone.replies.combineNewMessages(selection())),
    selectMessage: (messageId: string) => operate(() => window.notalone.replies.selectMessage({ ...selection(), messageId })),
    updateDirection: (direction: string) => operate(() => window.notalone.replies.updateDirection({ ...selection(), direction })),
    updateSupplement: (supplement: string) => operate(() => window.notalone.replies.updateSupplement({ ...selection(), supplement })),
    updateCorrection: (correction: string) => operate(() => window.notalone.replies.updateCorrection({ ...selection(), correction })),
    explore: (changeGroup = false) => operate(() => changeGroup ? window.notalone.replies.changeDirections(selection()) : window.notalone.replies.explore(selection())),
    beginClarificationEdit: (inputVersion: string, questionId: string) => operate(() => window.notalone.replies.beginClarificationEdit({ ...selection(), inputVersion, questionId })),
    answerClarification: (answer: string, inputVersion: string, questionId: string) => operate(() => window.notalone.replies.answerClarification({ ...selection(), answer, inputVersion, questionId })),
    stopExploration: () => operate(() => window.notalone.replies.stopExploration(selection())),
    retryExploration: () => operate(() => window.notalone.replies.retryExploration(selection())),
    updateRequirements: (requirements: string) => operate(() => window.notalone.replies.updateRequirements({ ...selection(), requirements })),
    updateSkill: (skill: import('../shared/reply-bridge').ReplySkillChoice) => operate(() => window.notalone.replies.updateSkill({ ...selection(), skill })),
    updateScene: (scene: string) => operate(() => window.notalone.replies.updateScene({ ...selection(), scene })),
    selectDirection: (suggestionId: string, inputVersion: string) => operate(() => window.notalone.replies.selectDirection({ ...selection(), suggestionId, inputVersion })),
    updatePurpose: (purpose: string) => operate(() => window.notalone.replies.updatePurpose({ ...selection(), purpose })),
    retryInterruptedGeneration: (sessionId: string, turnId: string, inputVersionId: string) =>
      operate(() => window.notalone.replies.retryInterruptedGeneration({ ...selection(), sessionId, turnId, inputVersionId })),
    generateWorkspace: (workspaceAction: 'express' | 'suggest', options: RewriteOptions) => operate(async () => {
      const scope = selection();
      await window.notalone.replies.updateOptions({ ...scope, options });
      await window.notalone.replies.generate({ ...scope, newRequest: true, workspaceAction });
    }),
    generate: (newRequest = false) => operate(() => window.notalone.replies.generate({ ...selection(), newRequest })),
    continueSession: (instruction: string, intentionUpdate?: string) => operate(() => window.notalone.replies.continueSession({
      ...selection(), sessionId: latest.current.savedSession!.sessionId!, instruction,
      ...(intentionUpdate === undefined ? {} : { intentionUpdate }) })),
    confirmContinuation: (requirementChanges: readonly RequirementChange[]) => operate(() => window.notalone.replies.confirmContinuation({
      ...selection(), sessionId: latest.current.continuation!.sessionId,
      expectedInputVersionId: latest.current.continuation!.expectedInputVersionId, requirementChanges })),
    retryContinuation: () => operate(() => window.notalone.replies.retryContinuation({ ...selection(),
      sessionId: latest.current.savedSession!.sessionId! })),
    editCandidate: (candidateId: string, text: string) => operate(() => window.notalone.replies.editCandidate({ ...selection(), replyRequestId: latest.current.result!.replyRequestId, candidateId, text })),
  };
}
export type ReplySessionView = ReturnType<typeof useReplySession>;

export function ReplyModePicker({ replies, enabled }: { replies: ReplySessionView; enabled: boolean }) {
  const responding = replies.state.mode === 'reply_to_message'
    || replies.state.mode === 'rewrite_draft' && replies.state.options.inputKind === 'current_chat';
  return <div className="ime-modes" role="group" aria-label="沟通场景与改写">
    <button className={replies.state.mode === 'rewrite_draft' && replies.state.options.inputKind !== 'current_chat' ? 'active' : ''}
      aria-pressed={replies.state.mode === 'rewrite_draft' && replies.state.options.inputKind !== 'current_chat'}
      disabled={!enabled} onClick={() => void replies.setMode('rewrite_draft', 'draft')}>改写</button>
    <button className={responding ? 'active' : ''} aria-pressed={responding}
      disabled={!enabled} onClick={() => { if (!responding) void replies.setMode('reply_to_message', undefined, true); }}>回应消息</button>
    <button className={replies.state.mode === 'initiate_conversation' ? 'active' : ''} aria-pressed={replies.state.mode === 'initiate_conversation'}
      disabled={!enabled} onClick={() => void replies.setMode('initiate_conversation')}>主动聊聊</button>
  </div>;
}

export function ReplySourcePicker({ replies }: { replies: ReplySessionView }) {
  const pasted = replies.state.mode === 'rewrite_draft' && replies.state.options.inputKind === 'current_chat';
  if (!pasted && replies.state.mode !== 'reply_to_message') return null;
  const enabled = Boolean(replies.state.contactId);
  return <div className="reply-source-picker" role="group" aria-label="回复消息来源">
    <span>消息来源</span>
    <button className={pasted ? 'active' : ''} aria-pressed={pasted} disabled={!enabled}
      onClick={() => void replies.setMode('rewrite_draft', 'current_chat')}>粘贴文字</button>
    <button className={!pasted ? 'active' : ''} aria-pressed={!pasted} disabled={!enabled}
      onClick={() => void replies.setMode('reply_to_message')}>从已有消息中选择</button>
  </div>;
}

export function RewriteInput({ contacts, replies }: { contacts: ContactSessionView; replies: ReplySessionView }) {
  const [options, setOptions] = useState(replies.state.options);
  useEffect(() => { setOptions(replies.state.options); }, [replies.state.scopeRevision, replies.state.inputClearRevision, replies.state.options.inputKind]);
  const enabled = Boolean(contacts.state.selectedContactId);
  const currentChat = replies.state.options.inputKind === 'current_chat';
  const update = (value: Partial<RewriteOptions>) => {
    const next = { ...options, ...value }; setOptions(next); void replies.updateOptions(next);
  };
  return <section className="compose-panel" aria-label={currentChat ? "回应粘贴文字输入" : "改写输入"}>
    <header className="compose-heading"><span className="section-eyebrow">输入</span><h2>{currentChat ? "对方说了什么？你想怎么回应？" : "把你的意思，换一种说法"}</h2><p>{currentChat ? "粘贴对方的话，补充表达方向，再生成回复。" : "写下草稿，选择语气，让表达更自然。"}</p></header>
    <div className="ime-input"><HelperDraft session={contacts} currentChat={currentChat} />
</div>
    {enabled && replies.state.generationBlock && <p role="status" className="rewrite-privacy">
      生成前，请先在上方确认本次联系人。
    </p>}
    <div className="rewrite-options">
      {currentChat && <label>表达方向<textarea aria-label="粘贴文字的表达方向" maxLength={4096}
        value={options.pastedDirection ?? ''} disabled={!enabled} placeholder="明确说明你想如何回应，例如简短婉拒，不增加承诺"
        onChange={(event) => update({ pastedDirection: event.target.value })} /></label>}
      <label>本次语气<select aria-label="本次语气" value={options.tone} disabled={!enabled}
        onChange={(event) => update({ tone: event.target.value as RewriteTone })}>
        <option value="original">保留原意</option><option value="warm">自然温和</option>
        <option value="concise">简洁直接</option><option value="polite">礼貌克制</option></select></label>
      <label className="rewrite-context"><input type="checkbox" checked={options.includeRelationshipContext} disabled={!enabled}
        onChange={(event) => update({ includeRelationshipContext: event.target.checked })} />结合关系语境</label>
      <label className="rewrite-instruction">本次要求<input aria-label="本次要求" maxLength={4096}
        value={options.instruction} disabled={!enabled} placeholder="可选，如只说明时间，不增加承诺"
        onChange={(event) => update({ instruction: event.target.value })} /></label>
    </div>
    <details className="compose-settings"><summary>更多设置 · 精确场景</summary><ReplySceneInput replies={replies} /></details>
    <div className="compose-submit"><button className="generate-button" aria-label="生成候选" title="生成候选"
        disabled={!enabled || !contacts.state.draft.trim() || currentChat && !options.pastedDirection?.trim() || replies.state.phase === 'waiting' || Boolean(replies.state.generationBlock)}
        onClick={() => void replies.generate()}><Icon name="sparkle" size={18} /><span>生成候选</span></button></div>
    <p className="rewrite-privacy">{currentChat ? '本次粘贴的对方文字未经渠道核验。' : ''}{options.includeRelationshipContext ? '本次允许使用这位联系人的相关资料。' : '默认只处理本次文字，不读取关系历史。'} 表达方向、语气和要求只作用于本次生成，不自动保存为长期记忆。</p>
    <div className="rewrite-retry">
      {replies.state.canRetry && <button disabled={replies.state.phase === 'waiting' || Boolean(replies.state.generationBlock)} onClick={() => void replies.generate()}>重试同一次生成</button>}
      {replies.state.result && <button disabled={!contacts.state.draft.trim() || replies.state.phase === 'waiting' || Boolean(replies.state.generationBlock)} onClick={() => void replies.generate(true)}>重新生成</button>}
    </div>
  </section>;
}

function CandidateEditor({ text, candidateId, number, edit, copy, validatePaste, disabled }: {
  text: string; candidateId: string; number: number; edit: ReplySessionView['editCandidate']; copy: (text: string) => void;
  validatePaste: (text: string) => Promise<void>; disabled: boolean;
}) {
  const [value, setValue] = useState(text);
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState('');
  const pendingPaste = useRef(false), active = useRef(true);
  const signature = JSON.stringify([candidateId, value]);
  const latest = useRef(signature); latest.current = signature;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setValue(text); }, [candidateId]);
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    if (disabled || pendingPaste.current) return;
    const input = event.currentTarget, pasted = event.clipboardData.getData('text/plain');
    const start = input.selectionStart, end = input.selectionEnd;
    const inserted = pasted.slice(0, Math.max(0, input.maxLength - input.value.length + end - start));
    const next = input.value.slice(0, start) + inserted + input.value.slice(end);
    const operation = signature;
    pendingPaste.current = true; setPasting(true); setError('');
    try {
      await validatePaste(pasted);
      if (active.current && latest.current === operation) { setValue(next); void edit(candidateId, next); }
    } catch {
      if (active.current && latest.current === operation) setError('这段粘贴文字的来源尚未确认，原编辑文字仍保留。请在原来源入口保存。');
    } finally { pendingPaste.current = false; if (active.current) setPasting(false); }
  }
  return <><textarea rows={1} aria-label={`候选${number}编辑文本`} maxLength={65_536} value={value} disabled={disabled || pasting}
    onPaste={(event) => void paste(event)}
    onCopy={(event) => { const input = event.currentTarget; copy(input.value.slice(input.selectionStart, input.selectionEnd)); }}
    onCut={(event) => { const input = event.currentTarget; copy(input.value.slice(input.selectionStart, input.selectionEnd)); }}
    onChange={(event) => { setValue(event.target.value); setError(''); void edit(candidateId, event.target.value); }} />
    {pasting && <p role="status">正在核对粘贴来源…</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}

export function ReplyCandidates({ replies, currentDraft }: { replies: ReplySessionView; currentDraft?: string }) {
  const { state } = replies;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const evidence = useReplyEvidence();
  const usedSkill = state.result?.usedSkill;
  const usedVersion = usedSkill && (usedSkill.versionNumber ?? state.skillChoices.find((item) => item.versionId === usedSkill.versionId)?.versionNumber);
  const recovered = !state.result && state.savedSession?.phase === 'ready'
    ? state.savedSession.turns.filter((turn) => turn.state === 'completed' && turn.reply).at(-1) : undefined;
  const replyRequestId = state.result?.replyRequestId ?? recovered?.reply?.replyRequestId;
  const candidates = state.result?.candidates.map((item) => item.original) ?? recovered?.reply?.candidates ?? [];
  const resultRegion = useRef<HTMLElement>(null);
  const visibleResult = useRef('');
  useEffect(() => {
    if (!replyRequestId || !candidates.length || state.phase === 'waiting' || state.phase === 'failed') return;
    const identity = `${state.contactId}:${state.scopeRevision}:${replyRequestId}`;
    if (visibleResult.current === identity) return;
    const region = resultRegion.current;
    if (!region) return;
    const revealEditor = () => {
      const editor = region.querySelector('article textarea');
      if (!editor) return false;
      visibleResult.current = identity;
      editor.scrollIntoView({ block: 'nearest' });
      return true;
    };
    if (revealEditor()) return;
    // 消息版本异步就绪后才挂载正文；只在本组首次可编辑时滚动。
    const observer = new MutationObserver(() => { if (revealEditor()) observer.disconnect(); });
    observer.observe(region, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [replyRequestId, candidates.length, state.phase, state.contactId, state.scopeRevision]);
  useEffect(() => {
    if (state.phase === 'failed') resultRegion.current?.scrollIntoView({ block: 'start' });
  }, [state.phase, state.errorCode]);
  const [dirtyCandidates, setDirtyCandidates] = useState<Record<string, boolean>>({});
  const reportDirty = useCallback((candidateId: string, dirty: boolean) => {
    setDirtyCandidates((previous) => previous[candidateId] === dirty ? previous : { ...previous, [candidateId]: dirty });
  }, []);
  const hasUnsavedEdits = candidates.some((candidate) => dirtyCandidates[candidate.candidateId]);
  const completedRead = useRef('');
  useEffect(() => {
    const result = state.result;
    // 删除复核暂时清空结果，返回后须重读同一会话的可信完成记录。
    if (!result) { completedRead.current = ''; return; }
    if (result.input.mode === 'rewrite_draft' && result.input.inputKind !== 'workspace' && !result.continuation || state.phase !== 'ready'
      || state.savedSession?.sessionId !== result.assistantSessionId || state.savedSession?.phase !== 'idle') return;
    const identity = `${state.contactId}:${state.scopeRevision}:${result.assistantSessionId}:${result.replyRequestId}`;
    if (completedRead.current === identity) return;
    completedRead.current = identity;
    void replies.readSavedSession();
  }, [state.result, state.phase, state.savedSession?.phase, state.savedSession?.sessionId, state.contactId, state.scopeRevision]);
  function noteCopy(candidateId: string, text: string) {
    if (!text.trim() || text.length > 65_536 || !state.contactId || !replyRequestId) return;
    void window.notalone.styleSamples.noteCandidateCopy({ contactId: state.contactId, scopeRevision: state.scopeRevision,
      replyRequestId, candidateId, text }).catch(() => {});
  }
  return <><section ref={resultRegion} className={`reply-candidates compact-replies${detailsOpen ? ' show-candidate-details' : ''}`} aria-label="候选回复">
    <header className="reply-results-heading"><h2>候选回复</h2>
      {candidates.length > 0 && <span>{candidates.length} 种说法 · 可直接编辑</span>}</header>
    {candidates.length > 0 && (!state.result || state.exploration.result || state.exploration.phase === 'waiting' || state.exploration.phase === 'failed'
      || state.phase === 'waiting' || state.phase === 'failed' || hasChangedReplyInput(state, currentDraft))
      && <p className="reply-generation-guidance" role="status">上一组候选，尚未按当前输入重新生成。</p>}
    {state.contentRestoreNotice && <p role="status">{state.contentRestoreNotice}</p>}
    <AssistantSessionBudgetNotice replies={replies} />
    <ReplyBasisChangeNotice changes={state.result?.basisChanges ?? recovered?.basisChanges ?? recovered?.reply?.basisChanges} />
    {state.sourceAvailability === 'checking' && <p role="status">正在核对删除后的依据…</p>}
    {state.sourceAvailability === 'failed' && <p role="alert">删除后的依据尚未确认，原候选暂不可用。<button onClick={() => void replies.retrySourceValidation()}>重新核对依据</button></p>}
    {state.phase === 'waiting' && <p className="reply-note" role="status">正在等待本次生成结果…</p>}
    {state.phase === 'failed' && <p className="reply-note" role="alert">{state.errorCode === 'connection' ? '未收到生成结果，请用同一次请求重试。'
      : state.errorCode === 'save_failed' ? '本次结果未可靠保存，尚不能确认可恢复。请重试同一次生成。'
      : state.errorCode === 'timeout' ? '本次生成超时，请重试同一次生成。'
      : state.errorCode === 'target_unavailable' ? '待回复消息已失效，请刷新消息重新选择，或使用草稿改写。'
      : state.errorCode === 'source_unavailable' ? (state.mode === 'reply_to_message'
        ? '待回复消息或其来源已失效，请刷新消息重新选择，或使用草稿改写。'
        : '本次回复依据已失效，请重新读取后再试。')
      : state.errorCode === 'rejected' ? '本次生成被拒绝，请重新明确选择联系人，并核对本次输入。'
      : state.errorCode === 'candidates_rejected' ? '本次候选未通过要求与内容核对。草稿已保留，请调整草稿或本次要求后重新生成。'
      : state.errorCode === 'unavailable' ? '回复服务暂不可用，请在管理后台补齐本人身份与模型设置，再重试。'
      : state.errorCode === 'input_budget_exceeded' ? '当前讨论超出模型输入预算，超限调用已停止。请查看已保存讨论或新开助手会话。'
      : state.errorCode === 'input_budget_unavailable' ? '当前模型或接收地址的完整输入预算暂不可核验，本次生成已停止。请在本人和模型设置中核对原配置；如需改用官方默认配置，须明确确认接收方并重新输入对应密钥。已填写内容和讨论仍会保留。'
      : state.errorCode === 'provider_context_limit' ? '模型提示这次内容过长，请新开助手会话。'
      : state.errorCode === 'prepared_context_reprepare_required' ? '旧准备已停止，已填写内容仍会保留。请明确重新准备后生成。'
      : state.errorCode === 'prepared_context_running' ? '旧准备的生成仍在运行，请等待完成后重新读取讨论。'
      : state.errorCode === 'prepared_context_unconfirmed' ? '旧准备的任务终态尚未确认，已填写内容仍会保留，请先核对。'
      : '本次生成失败，请核对本机服务后重试。'}</p>}
    {state.errorCode?.startsWith('prepared_context_') && <button
      disabled={state.phase === 'waiting' || Boolean(state.generationBlock)}
      onClick={() => void replies.generate(true)}>核对旧准备并重新生成</button>}
    {state.phase === 'failed' && (state.errorCode === 'unavailable' || state.errorCode === 'input_budget_unavailable') && <button onClick={() => void window.notalone.openManager()}>打开本人和模型设置</button>}
    {state.phase === 'failed' && state.mode === 'reply_to_message' && <p className="reply-note">可以刷新待回复消息重新选择，或切换到草稿改写。</p>}
    {state.result ? <>
      {state.result.input.mode === 'rewrite_draft' && state.result.input.inputKind !== 'workspace' && !state.result.continuation && <div className="reply-candidate-grid">
        {state.result.candidates.map(({ original, editedText }, index) => <article className="reply-candidate" key={original.candidateId}>
          <h3 className="candidate-strip-label" aria-label={`说法 ${index + 1}`}><span>{String(index + 1).padStart(2, '0')}</span><small>说法</small></h3>
          <div className="candidate-strip-content legacy-candidate-editor"><CandidateEditor text={editedText} candidateId={original.candidateId} number={index + 1} edit={replies.editCandidate}
            disabled={state.phase === 'waiting' || state.sourceAvailability !== undefined}
            validatePaste={(text) => window.notalone.styleSamples.validateCandidatePaste({ contactId: state.contactId!,
              scopeRevision: state.scopeRevision, replyRequestId: state.result!.replyRequestId, candidateId: original.candidateId, text })}
            copy={(text) => noteCopy(original.candidateId, text)} />
          <CandidateCopyControls state={state} candidateId={original.candidateId} /></div>
        </article>)}
      </div>}
    </> : state.phase !== 'waiting' && candidates.length === 0 && <div className="reply-empty"><p>暂无候选</p><small>写下想法让我帮你表达，或点击「帮我想想」获取建议。</small></div>}
    {(state.result?.input.mode !== 'rewrite_draft' || state.result.input.inputKind === 'workspace' || state.result.continuation || !state.result) && candidates.length > 0 && <div className="reply-candidate-grid">
      {candidates.map((candidate, index) => {
        const view = state.candidateVersions?.items.find((item) => item.candidateId === candidate.candidateId);
        return <article className="reply-candidate" key={candidate.candidateId}>
          <h3 className="candidate-strip-label" aria-label={`说法 ${index + 1}`}><span>{String(index + 1).padStart(2, '0')}</span><small>说法</small></h3>
          <div className="candidate-strip-content">{replyRequestId && <CandidateVersionEditor key={`${state.contactId}:${state.scopeRevision}:${state.savedSession?.sessionId}:${candidate.candidateId}:${replyRequestId}`}
              replies={replies} view={view} candidateId={candidate.candidateId} replyRequestId={replyRequestId}
              number={index + 1} restored={!state.result} noteCopy={(text) => noteCopy(candidate.candidateId, text)}
              onDirtyChange={reportDirty} />
          }</div>
        </article>;
      })}
    </div>}
    {candidates.length > 0 && <details className="reply-generation-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
      <summary><span>生成说明与更多操作</span><span>{candidates.some((candidate) => candidate.riskNotes.length) ? '有表达提醒 · 查看依据' : '输入与依据'}</span></summary>
      <p className="reply-note">展开后可查看各条依据，并使用回复旁的更多操作。</p>
      {state.result && <>
      {usedSkill === null ? <p className="reply-note">这组候选使用通用流程。</p> : usedSkill && <p className="reply-note">
        这组候选实际 Skill：{usedSkill.name} · 版本 {usedVersion ?? usedSkill.versionId}{usedSkill.loadState === 'resource_failed' ? '（部分资源读取失败）' : ''}
        {usedSkill.scope && ` · 范围：${usedSkill.scope.kind === 'scene' ? `精确场景「${usedSkill.scope.scene}」` : usedSkill.scope.kind === 'contact' ? '当前联系人' : '本人通用'}`}
        {!!usedSkill.executionView?.policyRevision && ` · 已排除本范围停用方法，允许${usedSkill.executionView.methodIds.length}种做法`}
      </p>}
      <details className="reply-input-snapshot"><summary>这组候选的生成输入 · {state.result.input.contactDisplayName}</summary>
        <p>精确场景：{state.result.input.scene ?? '未声明'}</p>
        {state.result.input.mode === 'rewrite_draft' ? <><p>{state.result.input.inputKind === 'current_chat' ? '本次粘贴的对方文字：' : '本人草稿：'}{state.result.input.draftText}</p>
          {state.result.input.inputKind === 'workspace' && <><p>本次动作：{state.result.input.workspaceAction === 'suggest' ? '帮我想想（建议尚未代表你的立场）' : '帮我表达'}</p>
            {state.result.input.contextText && <p>补充聊天：{state.result.input.contextText}</p>}</>}
          {state.result.input.inputKind === 'current_chat' && <p>表达方向：{state.result.input.pastedDirection}</p>}<p>{state.result.input.userInstruction ?? '没有额外要求'}</p>
          <p>关系语境：{state.result.input.includeRelationshipContext ? '已开启' : '关闭'}</p></>
          : state.result.input.mode === 'initiate_conversation' ? <p>主动目的：{state.result.input.purpose}</p>
          : <><p>待回复消息：{state.result.input.target.text ?? state.result.input.target.mediaPlaceholder}</p>
            <p>表达方向：{state.result.input.direction}</p></>}</details>
      </>}
      {candidates.map((candidate, index) => <section className="candidate-detail" key={candidate.candidateId} aria-label={`说法${index + 1}依据与提醒`}>
        <h3>说法 {index + 1}</h3>
        <div className="candidate-reason"><small>为什么这样建议</small><p className="reply-basis">{candidate.basis}</p></div>
        {candidate.riskNotes.map((note, number) => <p className="reply-risk" key={number}>{note}</p>)}
        <details><summary>查看原候选</summary><p className="reply-original"
          onCopy={() => noteCopy(candidate.candidateId, window.getSelection()?.toString() ?? '')}>{candidate.text}</p></details>
        {replyRequestId && <ReplyEvidence evidence={evidence} candidate={candidate} number={index + 1} waiting={state.phase === 'waiting'}
          selection={{ contactId: state.contactId!, scopeRevision: state.scopeRevision, replyRequestId, candidateId: candidate.candidateId }} />}
      </section>)}
    </details>}
    {replies.error && <p className="reply-note" role="alert">{replies.error}</p>}
    <AssistantContinuationControls key={`${state.contactId}:${state.scopeRevision}:${state.savedSession?.sessionId}:${state.inputClearRevision ?? 0}`}
      replies={replies} hasUnsavedEdits={hasUnsavedEdits} />
    <AssistantMessageNoticeActions replies={replies} hasUnsavedEdits={hasUnsavedEdits} />
  </section>
    <AssistantSessionPanel replies={replies} />
    <section className="reply-expression-settings" aria-label="表达设置">
      <header><h2>表达设置</h2><p>管理你喜欢的说法和长期偏好，不影响本次已生成的文字。</p></header>
      <StyleSamples replies={replies} />
      <ExpressionPreferences replies={replies} />
    </section>
  </>;
}
