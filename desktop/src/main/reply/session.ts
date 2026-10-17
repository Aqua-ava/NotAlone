import { randomUUID } from 'node:crypto';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { AssistantSessionDeletion, GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyCorrectionUpdate, ReplyDirectionChoice, ReplyDirectionUpdate, ReplyGenerationBlock, ReplyInputSnapshot, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, ReplySessionState, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import type { ContactSession } from '../contacts/session';
import { captureAssistantGenerationStopping } from './assistant-generation-interruption';
import { interruptedReplyInput } from './assistant-interrupted-retry';
import { checkPreparationFormat } from './preparation-format';
import { newAssistantSessionWithCandidate } from './assistant-candidate-carry';
import type { AssistantCandidateCarry } from '../../shared/reply-bridge';
import { generateReply, matchesReplyAdoption, replaceReply, retryInterruptedReply, type InterruptedReplyOrigin } from './client';
import type { DirectionExploration, ReplyClarificationAnswer, ReplyClarificationEdit, ReplyRequirementsUpdate, ReplySkillChoice, ReplySkillUpdate } from '../../shared/reply-bridge';
import { actOnExploration, explorationIdentity, openExploration, prepareExplorationAction, type ExplorationRequest, type ExplorationAction } from './exploration-client';
import { readReplyMessages } from './messages';
import { readReplyEvidence } from './evidence-read';
import { defaultAssistantSession, deleteAssistantSession, readAssistantSession } from './assistant-sessions';
import { listAssistantSessions, newAssistantSession, selectAssistantSession } from './assistant-session-catalog';
import type { AssistantInterruptedRetry, AssistantSessionSelection } from '../../shared/reply-bridge';
import type { ReplyCandidateDraftUpdate, ReplyCandidateVersionDisplay, ReplyCandidateVersionEdit, ReplyCandidateVersionRead, ReplyCandidateVersionSelection } from '../../shared/assistant-candidate-versions';
import { AssistantCandidateSourceUnavailable, AssistantCandidateVersionSession } from './assistant-candidate-versions';
import { AssistantGenerationJobs, type AssistantGenerationReceipt, type AssistantGenerationRecovery, type OwnedAssistantGeneration, type OwnedAssistantPreparation, type PendingAssistantGenerationReceipt } from './assistant-generation-jobs';
import type { ReplyContinuation, ReplyContinuationConfirmation } from '../../shared/reply-bridge';
import { continueAssistantSession, requirementChangeFromClarification, type AssistantContinuationCommand } from './assistant-continuation';
import { captureReplyContinuation, continuationInputSnapshot } from './continuation-view';
import { retainContactContent, validateContactInput, removeDependentContent, revalidateRetainedContent, type RetainedContactContent } from './contact-content';
import { readReplyScene, sceneSnapshot } from './scene';

const defaults = () => ({ tone: 'original' as const, instruction: '', includeRelationshipContext: false });
const tones = { original: '', warm: '本次语气自然温和。', concise: '本次表达简洁直接。', polite: '本次语气礼貌克制。' };

type StrategySourceValidation = {
  scope: ContactSelection & { sessionId: string };
  operation: number;
  generation: number;
  phase: 'checking' | 'ready' | 'failed';
  inputs: { inputVersionId: string; state: 'active' | 'redacted' | 'unavailable' }[];
};
type StrategyJob = ({ type: 'open'; request: ExplorationRequest; signature: string; input: ReplyInputSnapshot }
  | { type: 'action'; request: ExplorationAction; input: ReplyInputSnapshot }) & {
    actualInputVersionId?: string;
    sourceValidation?: StrategySourceValidation;
    confirmationOperationKey?: string;
  };
type CandidateSourceCheck = {
  pending: AbortController;
  scope: ContactSelection & { sessionId: string };
  turns: { turnId: string; candidateIds: string[] }[];
  inputIds: string[];
  refreshMessages: boolean;
  confirmedCandidateIds: string[];
  strategyJob: StrategyJob | undefined;
  strategyOperation: number;
  strategyWaiting: boolean;
};

// 助手讨论和原候选由后端保存；当前编辑稿与窗口状态分别处理。
export class ReplySession {
  hasEdits(): boolean {
    return Boolean(this.state.result || this.heldResult || this.state.phase === 'waiting' || this.state.targetMessageId
      || this.state.direction || this.state.purpose || this.state.mode !== 'rewrite_draft' || this.state.options.instruction
      || this.state.options.tone !== 'original' || this.state.options.includeRelationshipContext || this.state.scene);
  }
  private state: ReplySessionState = { revision: 0, scopeRevision: 0, contactId: null, generationBlock: null,
    options: defaults(), mode: 'rewrite_draft', scene: '', messages: { phase: 'idle', items: [], nextCursor: null },
    messageNotice: { phase: 'idle', changed: false, needsRefresh: false },
    targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '', skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], exploration: { phase: 'idle', result: null },
    phase: 'idle', result: null, selectedCandidateId: null, canRetry: false };
  private currentExploration: DirectionExploration | undefined;
  private generationSkillChoice: ReplySkillChoice | undefined;
  private explorationPurpose: string | undefined;
  private strategyJob: StrategyJob | undefined;
  private directionDerived = false;
  private explorationOperation = 0;
  private explorationPending: AbortController | undefined;
  private strategyCandidatePending: AbortController | undefined;
  private automaticExploration: { contactId: string; scopeRevision: number; generation: number;
    sessionId: string; remaining: number; expiresAt: number; queued: boolean } | undefined;
  private automaticExplorationTimer: ReturnType<typeof setTimeout> | undefined;
  private sourceCheck: AbortController | undefined;
  private heldResult: { result: NonNullable<ReplySessionState['result']>; selectedCandidateId: string | null;
    preserveInput?: true } | undefined;
  private draft = '';
  private operation = 0;
  private pending: AbortController | undefined;
  private readonly generationJobs = new AssistantGenerationJobs(() => this.publish({}));
  private helperHidden = false;
  // 复用原操作已捕获的命令引用供显式重试；不向作业元数据复制正文，也不自动执行。
  private readonly retainedRetries = new Map<string, { contactId: string; sessionId: string; run: () => Promise<void> }>();
  private restoredRetry: string | undefined;
  private lastAttempt: { input: ReplyInputSnapshot; requestKey: string; expectedInputVersionId?: string; interrupted?: InterruptedReplyOrigin; adoptNewMessageId?: string } | undefined;
  private continuationAttempt: { scope: ContactSelection; generation: number; command: AssistantContinuationCommand } | undefined;
  private messageOperation = 0;
  private messagePending: AbortController | undefined;
  private noticeStream: AbortController | undefined;
  private noticeVerification: AbortController | undefined;
  private noticeRevision = 0;
  // 只保留消息标识；切回后经认证读取确认，最多保存32个会话提示。
  private readonly retainedNotices = new Map<string, { contactId: string; sessionId: string; messageId: string }>();
  private noticedMessage: { generation: number; contactId: string; scopeRevision: number;
    sessionId: string; messageId: string; revision: number } | undefined;
  private savedRead: AbortController | undefined;
  private sessionDelete: AbortController | undefined;
  private catalogPending: AbortController | undefined;
  private candidateRestoreOperation = 0;
  private candidateSourceCheck: CandidateSourceCheck | undefined;
  private readonly candidateVersions: AssistantCandidateVersionSession;
  private readonly listeners = new Set<(state: ReplySessionState) => void>();
  private readonly sessionDeletionListeners = new Set<(phase: 'started' | 'settled') => void>();
  private readonly inputListeners = new Set<() => void>();
  private readonly retainedContent = new Map<string, RetainedContactContent>();
  private contentGeneration: number | undefined;
  private pendingContent: RetainedContactContent | undefined;
  private retainedSourceValidation: { checking: boolean } | undefined;
  private pendingExpressionPreferenceDeletions = 0;

  constructor(private readonly contacts: ContactSession, private readonly backend: BackendHost,
    private readonly generationBlock: () => ReplyGenerationBlock = () => null) {
    this.candidateVersions = new AssistantCandidateVersionSession(backend);
    this.candidateVersions.onStateChanged((state) => {
      if (state.candidateVersions.sessionId === null) this.candidateRestoreOperation += 1;
      this.publish(state);
    });
    let versionGeneration = backend.getConnectionGeneration();
    this.contentGeneration = versionGeneration;
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation !== versionGeneration) {
        versionGeneration = generation;
        this.retainedContent.clear(); this.retainedNotices.clear(); this.retainedRetries.clear(); this.restoredRetry = undefined; this.pendingContent = undefined; this.retainedSourceValidation = undefined; this.contentGeneration = undefined;
        this.publish({ inputBudgetNotice: undefined, scene: '', inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 });
        this.generationJobs.cancelAll();
        this.cancelPending();
        this.candidateVersions.setScope(null);
      }
    });
    this.state.generationBlock = generationBlock();
    contacts.onStateChanged((state) => this.receiveContact(state));
    this.receiveContact(contacts.getState());
  }
  getState(): ReplySessionState {
    const state = structuredClone(this.state);
    state.generationJobs = this.generationJobs.states(this.backend.getConnectionGeneration());
    state.generationRecoveryPending = this.generationJobs.recoveryPending(this.backend.getConnectionGeneration());
    state.candidateDrafts = state.sourceAvailability || state.savedSession?.phase !== 'ready' ? []
      : state.candidateDrafts?.filter((draft) => state.candidateVersions?.items.some((view) => view.phase === 'ready'
        && view.candidateId === draft.candidateId && view.history?.versions.some((version) => version.versionId === draft.versionId)));
    const notice = state.inputBudgetNotice;
    if (notice && (notice.contactId !== state.contactId || notice.scopeRevision !== state.scopeRevision
      || notice.sessionId !== state.savedSession?.sessionId || notice.operation !== this.operation
      || notice.connectionGeneration !== this.backend.getConnectionGeneration())) state.inputBudgetNotice = undefined;
    if (!this.candidateSourceCheck && !this.pendingContent && !this.retainedSourceValidation?.checking
      && this.pendingExpressionPreferenceDeletions === 0) return state;
    // 完整来源复验期间只隔离现有视图，不另存可恢复正文。
    return { ...state, candidateDrafts: [], inputBudgetNotice: undefined, continuation: undefined, result: null, selectedCandidateId: null, canRetry: false,
      messages: { phase: 'loading', items: [], nextCursor: null }, targetMessageId: null,
      ...(this.directionDerived ? { direction: '', purpose: '' } : {}),
      exploration: { phase: 'idle', result: null },
      savedSession: state.savedSession ? { ...state.savedSession,
        phase: state.savedSession.phase === 'failed' ? 'failed' : 'loading', turns: [], inputs: [], currentInputVersionId: null } : undefined,
      candidateVersions: state.candidateVersions ? { ...state.candidateVersions, phase: 'loading',
        items: state.candidateVersions.items.map((item) => ({ ...item, phase: 'loading', history: null, displayVersionId: null })) } : undefined,
      explicitCandidateSelection: { phase: 'loading', selection: null } };
  }
  refreshGenerationEligibility(): void {
    const generationBlock = this.generationBlock();
    if (generationBlock !== this.state.generationBlock) this.publish({ generationBlock });
  }
  onStateChanged(listener: (state: ReplySessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // 删除生命周期独立于展示联系人，等待原请求和同SID权威核对结算。
  onSessionDeletion(listener: (phase: 'started' | 'settled') => void): () => void {
    this.sessionDeletionListeners.add(listener);
    return () => { this.sessionDeletionListeners.delete(listener); };
  }
  onInputChanged(listener: () => void): () => void {
    this.inputListeners.add(listener); return () => this.inputListeners.delete(listener);
  }
  notifyHelperLifecycle(event: 'focused' | 'blurred' | 'hidden' | 'closed'): void {
    if (event === 'hidden' || event === 'closed') {
      this.stopAutomaticExploration();
      const generating = this.strategyJob?.type === 'action' && this.strategyJob.request.generate === true;
      if (!generating) this.invalidateExploration();
      this.helperHidden = true; this.leaveGenerationView();
      this.lastAttempt = undefined;
      this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false, errorCode: undefined });
    } else if (event === 'focused' && this.helperHidden) {
      this.helperHidden = false;
      if (this.state.contactId) void this.readSavedSession({ contactId: this.state.contactId, scopeRevision: this.state.scopeRevision });
    }
  }
  pendingGenerationReceipts(): PendingAssistantGenerationReceipt[] { return this.generationJobs.pendingReceipts(); }
  async prepareGenerationConnectionChange(): Promise<void> {
    const settling = this.generationJobs.prepareConnectionChange();
    this.leaveGenerationView();
    await settling;
  }

  // 退出调用方接收实际标识后走17的中断协议；hide/close不调用本接口。
  beginGenerationClosing(onReceipt: (receipt: PendingAssistantGenerationReceipt) => void | Promise<void>,
    recoverUnknown?: AssistantGenerationRecovery): Promise<void> {
    const closing = this.generationJobs.beginClosing(onReceipt, recoverUnknown); this.leaveGenerationView(); return closing;
  }

  async continueSession(update: ReplyContinuation): Promise<void> {
    const contacts = this.assertScope(update);
    this.assertSessionSelection();
    if (this.state.generationBlock || this.state.phase === 'waiting' || this.state.exploration.phase === 'waiting') {
      throw new Error('请等待当前操作完成后再继续本次讨论。');
    }
    const generation = this.backend.getConnectionGeneration()!;
    const frame = captureReplyContinuation(this.getState(), update.sessionId);
    const command: AssistantContinuationCommand = Object.freeze({ ...frame, requestKey: randomUUID(),
      instruction: update.instruction.trim(),
      ...(update.intentionUpdate === undefined ? {} : { intentionUpdate: update.intentionUpdate.trim() }),
      ...(update.requirementChanges === undefined ? {} : { requirementChanges: structuredClone(update.requirementChanges) }) });
    await this.runContinuation(update, command,
      contacts.contacts.find((contact) => contact.contactId === update.contactId)!.displayName, generation);
  }
  async confirmContinuation(update: ReplyContinuationConfirmation): Promise<void> {
    const contacts = this.assertScope(update); this.assertSessionSelection();
    const attempt = this.continuationAttempt, continuation = this.state.continuation;
    const generation = this.backend.getConnectionGeneration()!;
    if (!attempt || continuation?.phase !== 'clarification' || !continuation.clarification
      || attempt.generation !== generation || update.contactId !== attempt.scope.contactId
      || update.scopeRevision !== attempt.scope.scopeRevision || update.sessionId !== continuation.sessionId
      || update.expectedInputVersionId !== attempt.command.expectedInputVersionId
      || this.state.savedSession?.currentInputVersionId !== update.expectedInputVersionId
      || this.state.generationBlock || this.state.phase === 'waiting') {
      throw new Error('本次澄清已经失效，请重新提交要求。');
    }
    const frame = captureReplyContinuation(this.getState(), update.sessionId);
    if (JSON.stringify(frame.displayedGroup) !== JSON.stringify(attempt.command.displayedGroup)) {
      throw new Error('候选展示已变化，请重新提交要求。');
    }
    const options = continuation.clarification.requirement_options;
    if (!options.length || options.length !== update.requirementChanges.length) throw new Error('请逐项明确本次要求的处理方式。');
    const seen = new Set<string>();
    const changes = update.requirementChanges.map((change) => {
      const option = options.find((item) => change.action === 'add'
        ? item.origin === 'new' && item.requirement === change.replacement
        : item.origin === 'existing' && item.requirement === change.previous);
      if (!option || seen.has(option.requirement)) throw new Error('本次要求已变化，请重新确认。');
      seen.add(option.requirement);
      return requirementChangeFromClarification(option, change.action, change.action === 'replace' ? change.replacement : undefined);
    });
    // 同一冻结命令的多步澄清保留已确认项；当前选项覆盖同一来源的旧选择。
    const confirmedChanges = new Map<string, (typeof changes)[number]>();
    for (const change of [...(attempt.command.requirementChanges ?? []), ...changes]) {
      const source = change.action === 'add' ? change.replacement : change.previous;
      // 按后端 str.strip 的空白集合生成来源键，保持传输正文不变。
      const normalizedSource = source.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '');
      const key = (change.action === 'add' ? 'new:' : 'existing:') + normalizedSource;
      confirmedChanges.set(key, change);
    }
    await this.runContinuation(update, Object.freeze({ ...attempt.command,
      requirementChanges: Object.freeze([...confirmedChanges.values()]) }),
      contacts.contacts.find((contact) => contact.contactId === update.contactId)!.displayName, generation);
  }
  async retryContinuation(update: AssistantSessionSelection): Promise<void> {
    const contacts = this.assertScope(update); this.assertSessionSelection();
    const attempt = this.continuationAttempt;
    if (!attempt || this.state.continuation?.phase !== 'failed' || !this.state.continuation.canRetry
      || attempt.generation !== this.backend.getConnectionGeneration() || update.contactId !== attempt.scope.contactId
      || update.scopeRevision !== attempt.scope.scopeRevision || update.sessionId !== attempt.command.displayedGroup.sessionId
      || this.state.generationBlock || this.state.phase === 'waiting') throw new Error('本次连续修改已失效，请重新提交要求。');
    await this.runContinuation(update, attempt.command,
      contacts.contacts.find((contact) => contact.contactId === update.contactId)!.displayName, attempt.generation);
  }
  private async runContinuation(update: AssistantSessionSelection, command: AssistantContinuationCommand,
    contactDisplayName: string, generation: number): Promise<void> {
    this.invalidateExploration(); this.notifyInputChanged(); this.cancelPending(); this.lastAttempt = undefined;
    this.continuationAttempt = { scope: { contactId: update.contactId, scopeRevision: update.scopeRevision }, generation, command };
    const pending = new AbortController(); this.pending = pending;
    const operation = this.operation;
    let job: OwnedAssistantGeneration | undefined;
    let generationTerminal = false;
    let receivedPreparation: AssistantGenerationReceipt | undefined;
    const current = () => !pending.signal.aborted && operation === this.operation
      && generation === this.backend.getConnectionGeneration() && update.contactId === this.state.contactId
      && update.scopeRevision === this.state.scopeRevision && update.sessionId === this.state.savedSession?.sessionId
      && !this.state.sessionCatalog?.selectionPending && !this.candidateSourceCheck
      && (!job || this.generationJobs.canPublish(job, { connectionGeneration: generation,
        contactId: update.contactId, sessionId: update.sessionId }));
    const identity = { sessionId: update.sessionId, expectedInputVersionId: command.expectedInputVersionId };
    this.publish({ phase: 'waiting', canRetry: false, errorCode: undefined,
      continuation: { ...identity, phase: 'waiting', canRetry: false } });
    try {
      job = this.generationJobs.begin({ connectionGeneration: generation, contactId: update.contactId,
        sessionId: update.sessionId, requestKey: command.requestKey }, pending,
        captureAssistantGenerationStopping(this.backend, { connectionGeneration: generation,
          contactId: update.contactId, sessionId: update.sessionId }));
      const ownedJob = job;
      this.retainRetry(command.requestKey, update.contactId, update.sessionId, () => this.runContinuation(
        { contactId: update.contactId, scopeRevision: this.state.scopeRevision, sessionId: update.sessionId }, command, contactDisplayName, generation));
      const result = await continueAssistantSession(this.backend, update.contactId, update.sessionId, command, pending.signal,
        async (receipt) => { this.generationJobs.receiveReceipt(ownedJob, receipt); receivedPreparation = receipt;
          await this.generationJobs.acquire(ownedJob); },
        () => this.generationJobs.requestStarted(ownedJob), () => this.generationJobs.prepareStarted(ownedJob),
        (proof) => {
          this.generationJobs.receiveNoGenerationProof(ownedJob, proof, this.backend.getConnectionGeneration());
          generationTerminal = true;
        });
      generationTerminal = result.phase === 'completed';
      if (generationTerminal) this.generationJobs.completed(ownedJob);
      if (result.phase === 'clarification' && result.generation === generation) {
        if (receivedPreparation) throw new Error('本次澄清与实际领取状态不一致，请重新读取讨论。');
        this.generationJobs.completePreparationWithoutGeneration(ownedJob); job = undefined;
      }
      if (!current() || result.generation !== generation) return;
      if (result.phase === 'clarification') {
        this.publish({ phase: this.state.result ? 'ready' : 'idle',
          continuation: { ...identity, phase: 'clarification', canRetry: false,
            clarification: result.clarification, message: result.message } });
        return;
      }
      const beforeRead = this.state.savedSession;
      const saved = await readAssistantSession(this.backend, update.contactId, update.sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      const observed = this.state.savedSession;
      const authoritative = observed !== beforeRead ? observed : saved;
      const completed = authoritative?.turns.find((turn) => turn.inputVersionId === result.inputVersionId
        && turn.requestKey === command.requestKey && turn.state === 'completed'
        && turn.reply?.replyRequestId === result.replyRequestId);
      if (!completed || authoritative?.currentInputVersionId !== result.inputVersionId
        || !authoritative.inputs.some((input) => input.inputVersionId === result.inputVersionId && input.state === 'active')) {
        this.continuationAttempt = undefined;
        this.publish({ phase: this.state.result ? 'ready' : 'idle', continuation: undefined });
        await this.readSavedSession(update); return;
      }
      const frozenScene = readReplyScene(saved.turns.find(turn => turn.inputVersionId === result.inputVersionId)?.input?.scene);
      if (frozenScene !== result.effectiveScene) throw new Error('继续输入的场景与已保存版本不一致。');
      const input = continuationInputSnapshot(result.effectiveInput, this.state, contactDisplayName, frozenScene);
      this.savedRead?.abort(); this.savedRead = undefined;
      this.continuationAttempt = undefined;
      this.publish({ phase: 'ready', savedSession: { phase: 'ready', sessionId: authoritative.sessionId,
        turns: authoritative.turns, inputs: authoritative.inputs, currentInputVersionId: authoritative.currentInputVersionId },
        requirements: result.effectiveRequirements.join('；'),
        ...(input.mode === 'reply_to_message' ? { direction: input.direction }
          : input.mode === 'initiate_conversation' ? { purpose: input.purpose } : {}),
        continuation: { ...identity, phase: 'completed', canRetry: false, effectiveRequirements: result.effectiveRequirements },
        result: { replyRequestId: result.replyRequestId, assistantSessionId: result.assistantSessionId,
          inputVersionId: result.inputVersionId, input, contextEvidenceIds: result.contextEvidenceIds,
          styleSampleIds: result.styleSampleIds, expressionPreferenceIds: result.expressionPreferenceIds,
          expressionPreferences: result.expressionPreferences, usedSkill: result.usedSkill, inputBudget: result.inputBudget,
          basisChanges: completed.basisChanges ?? completed.reply?.basisChanges,
          continuation: { candidateId: result.resolvedCandidateId, versionId: result.resolvedVersionId,
            candidateGroupId: command.displayedGroup.candidateGroupId },
          candidates: result.candidates.map((original) => ({ original, editedText: original.text })) },
        selectedCandidateId: null });
      await this.restoreCandidateVersions(update, update.sessionId, result.candidates.map((candidate) => candidate.candidateId));
    } catch (error) {
      if (job && receivedPreparation && !generationTerminal && error instanceof BackendRequestFailure
        && error.kind === 'response') await this.recordFailedGenerationResponse(job, receivedPreparation, pending.signal, error);
      const failure = error instanceof BackendRequestFailure ? error : undefined;
      if (failure?.kind === 'response' && failure.status === 409 && failure.reason === 'source_deleted'
        && ['assistant_session_rejected', 'assistant_session_conflict'].includes(failure.code ?? '')
        && generation === this.backend.getConnectionGeneration() && update.contactId === this.state.contactId
        && update.scopeRevision === this.state.scopeRevision && update.sessionId === this.state.savedSession?.sessionId) {
        const wasCurrent = current();
        // 明确删除只撤下本次引用的组和输入，不等失败复读来裁定已知来源。
        this.savedRead?.abort(); this.savedRead = undefined;
        this.candidateRestoreOperation += 1;
        const scope = { contactId: update.contactId, scopeRevision: update.scopeRevision, sessionId: update.sessionId };
        this.candidateVersions.setScope(scope);
        this.clearUnavailableCandidateSource(scope, command.displayedGroup.candidates.map((candidate) => candidate.candidateId),
          new Set([command.expectedInputVersionId]));
        if (this.continuationAttempt?.command.requestKey === command.requestKey) this.continuationAttempt = undefined;
        if (wasCurrent) this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
          continuation: { ...identity, phase: 'failed', canRetry: false, message: '本次引用的来源已删除，请重新读取讨论。' } });
        await this.readSavedSession(update);
        return;
      }
      if (!current()) return;
      const providerLimit = failure?.status === 409 && failure.code === 'provider_context_limit';
      const canRetry = failure?.kind === 'connection' || failure?.code === 'reply_timeout'
        || failure?.code === 'assistant_session_save_failed' || Boolean(failure?.status && failure.status >= 500);
      if (!canRetry) this.continuationAttempt = undefined;
      this.publish({ phase: this.state.result ? 'ready' : 'idle',
        continuation: { ...identity, phase: 'failed', canRetry,
          message: providerLimit ? '模型提示这次内容过长，请新开助手会话。'
            : canRetry ? '本次继续的结果尚未确认，请用原请求重试。' : '本次继续尚未可靠确认，请重新读取讨论。' } });
      if (!canRetry && failure) await this.readSavedSession(update);
    } finally { if (job) await this.finishGeneration(job, generationTerminal); if (this.pending === pending) this.pending = undefined; }
  }

  private async restoreGenerationView(selection: ContactSelection,
    saved: Awaited<ReturnType<typeof readAssistantSession>>, signal: AbortSignal, current: () => boolean): Promise<void> {
    const turn = saved.turns.find((item) => item.inputVersionId === saved.currentInputVersionId);
    const job = this.generationJobs.states(saved.generation).find((item) => item.contactId === selection.contactId
      && item.sessionId === saved.sessionId && item.turnId === turn?.turnId && item.requestKey === turn?.requestKey);
    if (turn?.requiresReprepare && turn.input) {
      this.publish({ phase: 'failed', canRetry: false, exploration: { ...this.state.exploration, canRetry: false },
        errorCode: turn.generationActive === true ? 'prepared_context_running'
          : turn.generationActive === false ? 'prepared_context_reprepare_required' : 'prepared_context_unconfirmed' });
      return;
    }
    if (!turn || !job || !turn.input || !saved.inputs.some((item) => item.inputVersionId === turn.inputVersionId && item.state === 'active')) return;
    const retry = turn.state === 'failed' && job.phase === 'failed' && job.canRetry;
    const restoreResult = turn.state === 'completed' && turn.reply && !this.state.result;
    if (!retry && !restoreResult) return;
    const operation = this.operation;
    const input = await interruptedReplyInput(this.backend, turn, {
      contactId: selection.contactId,
      displayName: this.contacts.getState().contacts.find((item) => item.contactId === selection.contactId)!.displayName,
    }, signal, current);
    if (!current() || operation !== this.operation || this.candidateSourceCheck) return;
    if (restoreResult && (input.scene ?? null) !== (this.state.scene || null)) return;
    if (retry) {
      this.restoredRetry = this.retainedRetries.has(turn.requestKey) ? turn.requestKey : undefined;
      this.lastAttempt = { input, requestKey: turn.requestKey };
      this.publish({ phase: 'failed', errorCode: 'generation_failed', canRetry: true });
    } else if (turn.reply) {
      this.publish({ phase: 'ready', canRetry: false, errorCode: undefined, selectedCandidateId: null,
        result: { ...turn.reply, assistantSessionId: saved.sessionId, inputVersionId: turn.inputVersionId, input,
          candidates: turn.reply.candidates.map((original) => ({ original, editedText: original.text })) } });
    }
  }

  private pruneRetries(contactId: string, sessionId: string, turns: import('../../shared/assistant-session').SavedAssistantTurn[]): void {
    for (const [key, retry] of this.retainedRetries) if (retry.contactId === contactId && retry.sessionId === sessionId
      && !turns.some((turn) => turn.requestKey === key && turn.input && ['running', 'failed'].includes(turn.state))) {
      this.retainedRetries.delete(key);
    }
  }
  private async revalidateRetryInputs(): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    const owners = new Map([...this.retainedRetries.values()].map((retry) => [`${retry.contactId}:${retry.sessionId}`, retry]));
    await Promise.all([...owners.values()].map(async (owner) => {
      try {
        const saved = await readAssistantSession(this.backend, owner.contactId, owner.sessionId, new AbortController().signal);
        if (generation === this.backend.getConnectionGeneration() && saved.generation === generation) {
          this.pruneRetries(owner.contactId, owner.sessionId, saved.turns);
        }
      } catch {
        // 删除核验失败时放弃旧命令引用；重读只能恢复仍获权威认可的内容。
        if (generation === this.backend.getConnectionGeneration()) this.pruneRetries(owner.contactId, owner.sessionId, []);
      }
    }));
  }

  private retainRetry(requestKey: string, contactId: string, sessionId: string, run: () => Promise<void>): void {
    this.retainedRetries.delete(requestKey); this.retainedRetries.set(requestKey, { contactId, sessionId, run });
    while (this.retainedRetries.size > 32) this.retainedRetries.delete(this.retainedRetries.keys().next().value!);
  }

  private async finishGeneration(job: OwnedAssistantGeneration, terminal: boolean): Promise<void> {
    const owner = job.identity;
    const selected = owner.connectionGeneration === this.backend.getConnectionGeneration()
      && owner.contactId === this.state.contactId && owner.sessionId === this.state.savedSession?.sessionId;
    const returned = selected && !this.helperHidden && !this.generationJobs.canPublish(job, owner) && !job.signal.aborted;
    this.generationJobs.finish(job, terminal);
    if (terminal) this.retainedRetries.delete(owner.requestKey);
    // 返回原会话后晚到的结果仅触发权威读取，不复用旧视图或重新发起生成。
    if (returned) await this.readSavedSession({ contactId: owner.contactId, scopeRevision: this.state.scopeRevision });
  }

  private async revalidateRejectedPreparation(selection: ContactSelection, receipt: AssistantGenerationReceipt | undefined,
    current: () => boolean): Promise<void> {
    // 清除旧快照的重试引用，独立作业仍由实际终态复验与退出合同持有。
    if (receipt) {
      this.retainedRetries.delete(receipt.requestKey);
      if (this.restoredRetry === receipt.requestKey) this.restoredRetry = undefined;
      if (this.lastAttempt?.requestKey === receipt.requestKey) this.lastAttempt = undefined;
    }
    if (!current()) return;
    await this.readSavedSession(selection);
    if (!current()) return;
    const turn = this.state.savedSession?.turns.find((item) => receipt
      ? item.turnId === receipt.turnId && item.requestKey === receipt.requestKey && item.inputVersionId === receipt.inputVersionId
      : item.inputVersionId === this.state.savedSession?.currentInputVersionId);
    if (turn?.state === 'completed') return;
    this.publish({ phase: 'failed', canRetry: false, inputBudgetNotice: undefined,
      errorCode: turn?.requiresReprepare && turn.generationActive === false ? 'prepared_context_reprepare_required'
        : turn?.generationActive === true ? 'prepared_context_running' : 'prepared_context_unconfirmed' });
  }

  private async recordFailedGenerationResponse(job: OwnedAssistantGeneration, receipt: AssistantGenerationReceipt,
    signal: AbortSignal, failure: BackendRequestFailure): Promise<void> {
    if (signal.aborted || job.identity.connectionGeneration !== this.backend.getConnectionGeneration()) return;
    try {
      const saved = await readAssistantSession(this.backend, job.identity.contactId, job.identity.sessionId, signal);
      const failed = saved.turns.find((turn) =>
          turn.turnId === receipt.turnId && turn.inputVersionId === receipt.inputVersionId
          && turn.requestKey === receipt.requestKey && turn.state === 'failed');
      if (saved.generation === job.identity.connectionGeneration
        && saved.generation === this.backend.getConnectionGeneration() && !signal.aborted
        && this.generationJobs.isActive(job) && failed) {
        this.generationJobs.failedResponseReceived(job, failure.code === 'reply_timeout' || failure.code === 'assistant_session_save_failed' || (failure.status ?? 0) >= 500, failed.generationActive);
      }
    } catch { /* 未知读取不能证明失败；原停止身份仍由实际中断裁定。 */ }
  }

  async readSavedSession(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.pendingExpressionPreferenceDeletions > 0 || this.state.sessionDeletion === 'deleting'
      || this.catalogPending || this.state.sessionCatalog?.selectionPending) return;
    this.candidateRestoreOperation += 1;
    this.savedRead?.abort();
    const pending = new AbortController();
    this.savedRead = pending;
    const generation = this.backend.getConnectionGeneration();
    const content = this.pendingContent, inputOperation = this.operation;
    const current = () => !pending.signal.aborted && selection.scopeRevision === this.state.scopeRevision
      && selection.contactId === this.state.contactId && generation === this.backend.getConnectionGeneration();
    const heldSessionId = this.state.savedSession?.sessionId ?? content?.sessionId;
    this.publish({ savedSession: { phase: 'loading', sessionId: heldSessionId ?? null, turns: [], inputs: [], currentInputVersionId: null } });
    try {
      const sessionId = heldSessionId ?? (await defaultAssistantSession(this.backend, selection.contactId, pending.signal)).sessionId;
      if (!current()) return;
      let saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (current() && saved.generation === generation) {
        this.generationJobs.reconcile({ connectionGeneration: saved.generation, contactId: selection.contactId, sessionId }, saved.turns);
        this.pruneRetries(selection.contactId, sessionId, saved.turns);
        if (this.candidateSourceCheck) {
          const verified = await this.acceptCandidateSourceSnapshot(saved, this.candidateSourceCheck, pending.signal, current);
          if (!verified || !current()) return;
          saved = verified;
        }
        const heldVersion = (this.state.result ?? this.heldResult?.result)?.inputVersionId;
        const invalid = heldVersion && saved.turns.some((turn) => turn.inputVersionId === heldVersion
          && ['redacted', 'unavailable'].includes(turn.state));
        if (invalid) { this.cancelPending(); this.lastAttempt = undefined; }
        const budgetNotice = this.state.inputBudgetNotice;
        const inputBudgetNotice = budgetNotice?.sessionId === saved.sessionId
          && budgetNotice.inputVersionId === saved.currentInputVersionId
          && saved.inputs.some((input) => input.inputVersionId === budgetNotice.inputVersionId && input.state === 'active')
          ? budgetNotice : undefined;
        const result = this.state.result;
        const resultTurn = result?.assistantSessionId === saved.sessionId
          ? saved.turns.find((turn) => turn.inputVersionId === result.inputVersionId
            && turn.state === 'completed' && turn.reply?.replyRequestId === result.replyRequestId) : undefined;
        this.publish({ savedSession: { sessionId: saved.sessionId, turns: saved.turns, inputs: saved.inputs, currentInputVersionId: saved.currentInputVersionId, phase: 'ready' },
          inputBudgetNotice,
          ...(saved.sessionId !== heldSessionId ? { sessionDeletion: undefined } : {}),
          // 只刷新同一结果的无正文提醒，当前候选编辑和本次意图继续由用户持有。
          ...(resultTurn && result ? { result: { ...result,
            basisChanges: resultTurn.basisChanges ?? resultTurn.reply?.basisChanges } } : {}),
          ...(invalid ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false } : {}) });
        await this.restoreCandidateVersions(selection, saved.sessionId,
          saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []), true);
        if (current() && content && this.pendingContent === content && inputOperation === this.operation
          && (content.sessionId === null || content.sessionId === saved.sessionId)) {
          const restoredInput = await validateContactInput(this.backend, selection.contactId, content,
            this.contacts.getState().contacts.find((contact) => contact.contactId === selection.contactId)!.displayName, this.state.savedSession!, pending.signal, current);
          if (!current() || this.pendingContent !== content || inputOperation !== this.operation) return;
          if (this.state.candidateVersions?.phase === 'failed' || this.state.explicitCandidateSelection?.phase === 'failed'
            || this.state.candidateVersions?.items.some((view) => view.phase === 'failed')) {
            throw new Error('候选版本尚未核对，请重新读取讨论。');
          }
          const candidateDrafts = content.candidateDrafts.filter((draft) => this.state.candidateVersions?.items.some((view) =>
            view.phase === 'ready' && view.candidateId === draft.candidateId && view.history?.versions.some((version) =>
              version.versionId === draft.versionId && version.messages.length === draft.messages.length
              && version.messages.every((message, index) => message.messageId === draft.messages[index].messageId))));
          for (const draft of candidateDrafts) this.candidateVersions.show({ ...selection, sessionId: saved.sessionId,
            candidateId: draft.candidateId, versionId: draft.versionId });
          this.pendingContent = undefined;
          this.retainedContent.delete(selection.contactId);
          this.draft = content.draft;
          this.contacts.setDraft({ ...selection, text: content.draft });
          this.directionDerived = content.directionDerived && Boolean(restoredInput.direction || restoredInput.purpose);
          this.publish({ ...restoredInput, candidateDrafts, inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 });
        }
        if (current() && inputOperation === this.operation) {
          await this.restoreGenerationView(selection, saved, pending.signal, current);
          if (current()) await this.restoreMessageNotice(selection, saved.sessionId, pending.signal, current);
        }
      }
    } catch (error) {
      if (current()) {
        const unavailable = error instanceof BackendRequestFailure && error.kind === 'response'
          && (error.status === 404 && error.code === 'not_found'
            || error.status === 409 && ['assistant_session_conflict', 'assistant_session_rejected'].includes(error.code ?? '')
              && ['source_unavailable', 'source_deleted'].includes(error.reason ?? ''));
        if (unavailable) {
          if (heldSessionId) this.pruneRetries(selection.contactId, heldSessionId, []);
          this.retainedContent.delete(selection.contactId); this.pendingContent = undefined;
          if (heldSessionId) {
            this.candidateVersions.setScope({ ...selection, sessionId: heldSessionId });
            this.clearUnavailableCandidateSource({ ...selection, sessionId: heldSessionId });
          }
          this.candidateVersions.setScope(null); this.heldResult = undefined;
        }
        if (unavailable) this.candidateSourceCheck = undefined;
        this.publish({ savedSession: { phase: 'failed', sessionId: heldSessionId ?? null, turns: [], inputs: [], currentInputVersionId: null },
          ...(this.candidateSourceCheck ? { sourceAvailability: 'failed' } : unavailable ? { sourceAvailability: undefined } : {}),
          ...(unavailable ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false } : {}) });
      }
    } finally { if (this.savedRead === pending) this.savedRead = undefined; }
  }

  async listSavedSessions(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.sessionDeletion === 'deleting') return;
    const previous = this.state.sessionCatalog;
    const pending = new AbortController(); this.catalogPending = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.catalogPending === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && generation === this.backend.getConnectionGeneration();
    this.publish({ sessionCatalog: { phase: 'loading', items: previous?.items ?? [],
      currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    try {
      const catalog = await listAssistantSessions(this.backend, selection.contactId, pending.signal);
      if (current() && catalog.generation === generation) this.publish({ sessionCatalog: { phase: 'ready',
        items: catalog.items, currentSessionId: catalog.currentSessionId, selectionPending: previous?.selectionPending } });
    } catch {
      if (current()) this.publish({ sessionCatalog: { phase: 'failed', items: previous?.items ?? [],
        currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    } finally { if (this.catalogPending === pending) this.catalogPending = undefined; }
  }
  async newSavedSession(selection: ContactSelection): Promise<void> { await this.switchSavedSession(selection); }
  async newSavedSessionWithCandidate(command: AssistantCandidateCarry): Promise<void> {
    this.assertScope(command); this.assertSessionSelection();
    const selected = this.state.explicitCandidateSelection;
    const view = this.state.candidateVersions?.items.find((item) => item.candidateId === command.candidateId);
    if (command.sessionId !== this.state.savedSession?.sessionId || selected?.phase !== 'ready'
      || selected.selection?.selectionId !== command.expectedSelectionId
      || selected.selection.candidateId !== command.candidateId || selected.selection.versionId !== command.versionId
      || selected.selection.sessionId !== command.sessionId || view?.phase !== 'ready'
      || view.displayVersionId !== command.versionId) throw new Error('请重新核对并选用要携入的保存版本。');
    await this.switchSavedSession(command, Object.freeze({ ...command }));
  }
  async selectSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection); }
  private async switchSavedSession(selection: ContactSelection & { sessionId?: string }, carry?: AssistantCandidateCarry): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.exploration.phase === 'waiting'
      || this.state.savedSession?.phase === 'loading' || this.state.sessionDeletion === 'deleting'
      || this.state.sessionDeletion === 'failed' || this.state.sourceAvailability === 'checking') {
      throw new Error('请等待当前操作完成后再切换助手会话。');
    }
    const previous = this.state.sessionCatalog;
    this.leaveGenerationView();
    const pending = new AbortController(); this.catalogPending = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.catalogPending === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && generation === this.backend.getConnectionGeneration();
    this.publish({ sessionCatalog: { phase: 'loading', items: previous?.items ?? [],
      currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    try {
      const selected = carry ? await newAssistantSessionWithCandidate(this.backend, carry, pending.signal) : selection.sessionId
        ? await selectAssistantSession(this.backend, selection.contactId, selection.sessionId, pending.signal)
        : await newAssistantSession(this.backend, selection.contactId, pending.signal);
      if (!current() || selected.generation !== generation) return;
      const saved = await readAssistantSession(this.backend, selection.contactId, selected.sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      if (carry && (!('inputVersionId' in selected) || saved.currentInputVersionId !== selected.inputVersionId
        || saved.turns.length !== 0 || saved.inputs.length !== 1
        || saved.inputs[0].type !== 'candidate_carry' || saved.inputs[0].state !== 'active'
        || saved.inputs[0].content?.type !== 'candidate_carry'
        || saved.inputs[0].content.originSessionId !== carry.sessionId
        || saved.inputs[0].content.originCandidateId !== carry.candidateId
        || saved.inputs[0].content.originVersionId !== carry.versionId
        || saved.inputs[0].content.originSelectionId !== carry.expectedSelectionId)) throw new Error('携入版本尚未确认。');
      this.savedRead?.abort(); this.savedRead = undefined;
      this.candidateSourceCheck?.pending.abort();
      this.lastAttempt = undefined;
      this.invalidateExploration(); this.directionDerived = false;
      this.notifyInputChanged(); this.retainedContent.delete(selection.contactId); this.contacts.clearDraft(selection);
      const items = (previous?.items ?? []).map((item) => ({ ...item, isCurrent: item.sessionId === saved.sessionId }));
      if (!items.some((item) => item.sessionId === saved.sessionId)) items.push({ sessionId: saved.sessionId, isCurrent: true });
      this.candidateVersions.setScope(null); this.candidateSourceCheck = undefined;
      this.publish({ savedSession: { phase: 'ready', sessionId: saved.sessionId, turns: saved.turns,
        inputs: saved.inputs, currentInputVersionId: saved.currentInputVersionId },
        sessionCatalog: { phase: 'ready', items, currentSessionId: saved.sessionId, selectionPending: false },
        sessionDeletion: undefined, confirmedSessionDeletion: undefined,
        options: defaults(), inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        mode: 'rewrite_draft', scene: '', targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '',
        skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], contentRestoreNotice: undefined, candidateDrafts: [],
        result: null, selectedCandidateId: null, canRetry: false, phase: 'idle', errorCode: undefined });
      await this.restoreCandidateVersions(selection, saved.sessionId,
        saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []), true);
    } catch (error) {
      if (carry && current() && generation !== undefined && error instanceof BackendRequestFailure
        && error.kind === 'response' && (error.status === 404 && error.code === 'not_found'
          || error.status === 409 && error.code === 'assistant_session_rejected')) {
        // 来源删除也会清除选择回执；拒绝的分类不能代替对原会话的权威重读。
        await this.handleCandidateSourceUnavailable(new AssistantCandidateSourceUnavailable(carry, generation, null));
      }
      // POST 可能已落库；只有显式选择并重读成功才能恢复本次生成。
      if (current()) this.publish({ sessionCatalog: { phase: 'failed', items: [], currentSessionId: null, selectionPending: true } });
    } finally { if (this.catalogPending === pending) this.catalogPending = undefined; }
  }

  async deleteSavedSession(selection: AssistantSessionDeletion): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.sessionCatalog?.selectionPending) throw new Error('请先核对助手会话的选择结果。');
    if (selection.confirmed !== true || selection.sessionId !== this.state.savedSession?.sessionId) {
      throw new Error('本次助手会话已变化，请重新确认。');
    }
    if (this.state.sessionDeletion === 'deleting') return;
    const owningGeneration = this.backend.getConnectionGeneration();
    if (owningGeneration !== undefined) this.generationJobs.cancelSession({ connectionGeneration: owningGeneration,
      contactId: selection.contactId, sessionId: selection.sessionId });
    this.candidateSourceCheck?.pending.abort();
    this.candidateVersions.setScope(null);
    this.savedRead?.abort(); this.savedRead = undefined;
    this.cancelPending(); this.lastAttempt = undefined;
    this.invalidateExploration(); this.directionDerived = false;
    this.notifyInputChanged();
    const pending = new AbortController(); this.sessionDelete = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.sessionDelete === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && selection.sessionId === this.state.savedSession?.sessionId
      && generation === this.backend.getConnectionGeneration();
    try {
      for (const listener of this.sessionDeletionListeners) listener('started');
      this.publish({ sessionDeletion: 'deleting', result: null, selectedCandidateId: null, canRetry: false,
        phase: 'idle', errorCode: undefined, confirmedSessionDeletion: undefined,
        savedSession: { phase: 'idle', sessionId: selection.sessionId, turns: [], inputs: [], currentInputVersionId: null } });
      this.candidateSourceCheck = undefined;
      const result = await deleteAssistantSession(this.backend, selection.contactId, selection.sessionId, pending.signal);
      if (!current() || result.generation !== generation) return;
      this.generationJobs.forget({ connectionGeneration: result.generation, contactId: selection.contactId, sessionId: selection.sessionId });
      this.retainedNotices.delete(`${selection.contactId}:${selection.sessionId}`);
      for (const [key, retry] of this.retainedRetries) if (retry.contactId === selection.contactId && retry.sessionId === selection.sessionId) this.retainedRetries.delete(key);
      this.retainedContent.delete(selection.contactId); this.pendingContent = undefined;
      this.contacts.clearDraft(selection);
      this.publish({ sessionDeletion: result.phase, savedSession: { phase: 'idle', sessionId: null, turns: [], inputs: [], currentInputVersionId: null },
        sessionCatalog: undefined,
        options: defaults(), inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        confirmedSessionDeletion: { sessionId: selection.sessionId, contactId: selection.contactId,
          scopeRevision: selection.scopeRevision, connectionGeneration: result.generation,
          revision: this.state.revision + 1 },
        mode: 'rewrite_draft', scene: '', direction: '', purpose: '', correction: '', requirements: '',
        clarificationAnswer: '', targetMessageId: null, skillChoice: { mode: 'auto', versionId: null }, skillChoices: [],
        candidateDrafts: [], contentRestoreNotice: undefined,
        result: null, selectedCandidateId: null, canRetry: false, phase: 'idle', errorCode: undefined });
    } catch {
      if (current()) this.publish({ sessionDeletion: 'failed' });
    } finally {
      if (this.sessionDelete === pending) this.sessionDelete = undefined;
      for (const listener of this.sessionDeletionListeners) listener('settled');
    }
  }

  private async revalidateRetainedContents(): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    await Promise.all([...this.retainedContent].map(async ([contactId, content]) => {
      const current = () => generation !== undefined && generation === this.backend.getConnectionGeneration()
        && this.retainedContent.get(contactId) === content;
      try {
        const clean = await revalidateRetainedContent(this.backend, contactId, content, new AbortController().signal, current);
        if (current()) {
          this.retainedContent.set(contactId, clean);
          if (this.pendingContent === content) {
            this.pendingContent = clean;
            if (this.state.contactId === contactId) await this.readSavedSession({ contactId, scopeRevision: this.state.scopeRevision });
          }
        }
      } catch (error) {
        if (!current()) return;
        if (error instanceof BackendRequestFailure && error.status === 404) {
          this.retainedContent.delete(contactId);
          if (this.pendingContent === content) {
            this.pendingContent = removeDependentContent(content);
            if (this.state.contactId === contactId) await this.readSavedSession({ contactId, scopeRevision: this.state.scopeRevision });
          }
        } else {
          const clean = removeDependentContent(content);
          this.retainedContent.set(contactId, clean);
          if (this.pendingContent === content) {
            this.pendingContent = clean;
            if (this.state.contactId === contactId) await this.readSavedSession({ contactId, scopeRevision: this.state.scopeRevision });
          }
        }
      }
    }));
  }

  beginExpressionPreferenceDeletion(): void {
    ++this.pendingExpressionPreferenceDeletions;
    this.generationJobs.cancelAll();
    this.retainedRetries.clear(); this.retainedNotices.clear();
    const held = this.heldResult ?? (this.state.result ? { result: this.state.result,
      selectedCandidateId: this.state.selectedCandidateId } : undefined);
    this.savedRead?.abort(); this.savedRead = undefined;
    this.cancelPending(); this.lastAttempt = undefined;
    this.heldResult = held;
    this.candidateVersions.setScope(null);
    this.publish({ result: null, selectedCandidateId: null, phase: 'idle', canRetry: false,
      candidateDrafts: [], sourceAvailability: this.heldResult ? 'checking' : undefined,
      ...(this.state.savedSession ? { savedSession: { ...this.state.savedSession, phase: 'idle' as const,
        turns: [], inputs: [], currentInputVersionId: null } } : {}) });
  }
  async revalidateExpressionPreferences(): Promise<void> {
    this.pendingExpressionPreferenceDeletions = Math.max(0, this.pendingExpressionPreferenceDeletions - 1);
    if (this.pendingExpressionPreferenceDeletions === 0) {
      await this.revalidateDeletedSource(this.state.contactId ?? '', { preserveInput: true });
    }
  }
  // 删除检查点只接收主进程已确认的联系人；跨联系人本人资料也可能影响当前依据。
  async revalidateDeletedSource(contactId: string, options: { preserveInput?: true } = {}): Promise<void> {
    for (const [key, retry] of this.retainedRetries) if (retry.contactId === contactId) this.retainedRetries.delete(key);
    for (const [key, notice] of this.retainedNotices) if (notice.contactId === contactId) this.retainedNotices.delete(key);
    const owningGeneration = this.backend.getConnectionGeneration();
    if (owningGeneration !== undefined) this.generationJobs.cancelContact(owningGeneration, contactId);
    const activeContact = this.state.contactId, activeScope = this.state.scopeRevision;
    const restoring = this.pendingContent;
    const displayedContent = retainContactContent(this.state, this.directionDerived, this.draft);
    const activeContent = restoring ?? displayedContent;
    if (activeContact && activeContent) this.retainedContent.set(activeContact, activeContent);
    const validation = { checking: true }; this.retainedSourceValidation = validation;
    this.pendingContent = undefined; this.savedRead?.abort();
    this.publish({ candidateDrafts: [] });
    const retainedValidation = Promise.all([this.revalidateRetainedContents(), this.revalidateRetryInputs()]).finally(() => {
      if (this.retainedSourceValidation === validation) {
        validation.checking = false;
        this.publish({});
      }
    });
    try {
      let candidateSnapshotAccepted = false;
      if (this.candidateSourceCheck) {
        const { scope } = this.candidateSourceCheck;
        const generation = this.backend.getConnectionGeneration();
        // 先由同范围的公开完整读取接管；未知传输失败保留隔离，供公开重试收尾。
        await this.readSavedSession(scope);
        if (this.candidateSourceCheck || scope.contactId !== this.state.contactId
          || scope.scopeRevision !== this.state.scopeRevision || scope.sessionId !== this.state.savedSession?.sessionId
          || generation !== this.backend.getConnectionGeneration()) return;
        candidateSnapshotAccepted = this.state.savedSession.phase === 'ready';
      }
      if (!candidateSnapshotAccepted) this.candidateVersions.setScope(null);
      if (this.catalogPending) {
        this.catalogPending.abort(); this.catalogPending = undefined;
        this.publish({ sessionCatalog: { phase: 'failed', items: [], currentSessionId: null, selectionPending: true } });
      }
      this.invalidateExploration();
      this.savedRead?.abort();
      this.savedRead = undefined;
      if (this.state.savedSession && !candidateSnapshotAccepted) this.publish({ savedSession: { ...this.state.savedSession, phase: 'idle', turns: [], inputs: [], currentInputVersionId: null } });
      const held = this.heldResult ?? (this.state.result ? {
        result: this.state.result, selectedCandidateId: this.state.selectedCandidateId,
      } : undefined);
      this.cancelPending();
      this.lastAttempt = undefined;
      const scopeRevision = this.state.scopeRevision;
      const currentContact = this.state.contactId;
      const generation = this.backend.getConnectionGeneration();
      this.heldResult = held && { ...held, preserveInput: options.preserveInput };
      const pending = new AbortController();
      this.sourceCheck = pending;
      const current = () => !pending.signal.aborted && this.sourceCheck === pending
        && scopeRevision === this.state.scopeRevision && currentContact === this.state.contactId
        && generation === this.backend.getConnectionGeneration();
      this.publish({ result: null, selectedCandidateId: null, phase: 'idle', canRetry: false,
        errorCode: undefined, sourceAvailability: held ? 'checking' : undefined });
      if (contactId === currentContact && !options.preserveInput) {
        this.cancelMessagePage();
        this.publish({ messages: { phase: 'idle', items: [], nextCursor: null }, targetMessageId: null,
          correction: '', ...(this.directionDerived ? { direction: '', purpose: '' } : {}) });
        this.directionDerived = false;
        if (currentContact && generation !== undefined) {
          await this.loadMessages({ contactId: currentContact, scopeRevision, older: false });
        }
      }
      if (!held || !currentContact || generation === undefined || !current()) return;
      try {
        const evidence = await readReplyEvidence(this.backend, currentContact, held.result.replyRequestId, pending.signal);
        if (!current() || evidence.generation !== generation) return;
        this.heldResult = undefined;
        this.publish({ result: { ...held.result, basisChanges: evidence.basisChanges }, selectedCandidateId: held.selectedCandidateId,
          phase: 'ready', sourceAvailability: undefined });
        if (held.result.assistantSessionId && !this.candidateSourceCheck) await this.restoreCandidateVersions(
          { contactId: currentContact, scopeRevision }, held.result.assistantSessionId,
          held.result.candidates.map((item) => item.original.candidateId));
      } catch (error) {
        if (!current()) return;
        if (error instanceof BackendRequestFailure && error.status === 404) {
          this.heldResult = undefined;
          this.publish({ sourceAvailability: undefined });
        } else this.publish({ sourceAvailability: 'failed' });
      } finally { if (this.sourceCheck === pending) this.sourceCheck = undefined; }
    } finally {
      await retainedValidation;
      if (this.retainedSourceValidation === validation) {
        this.retainedSourceValidation = undefined;
        const clean = activeContact ? this.retainedContent.get(activeContact) : undefined;
        if (activeContact === this.state.contactId && activeScope === this.state.scopeRevision
          && owningGeneration === this.backend.getConnectionGeneration()) {
          this.publish({ candidateDrafts: clean?.candidateDrafts ?? [] });
          if (restoring && clean && activeContact) {
            const latest = retainContactContent(this.state, this.directionDerived, this.draft);
            if (displayedContent && latest) {
              const input = { ...clean.input };
              for (const key of Object.keys(input) as (keyof typeof input)[]) {
                if (JSON.stringify(latest.input[key]) !== JSON.stringify(displayedContent.input[key])) {
                  Object.assign(input, { [key]: latest.input[key] });
                }
              }
              this.pendingContent = { ...clean, input,
                draft: latest.draft !== displayedContent.draft ? latest.draft : clean.draft };
            } else this.pendingContent = clean;
            await this.readSavedSession({ contactId: activeContact, scopeRevision: activeScope });
          }
        }
      }
    }
  }
  async retrySourceValidation(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.state.sourceAvailability === 'failed') await this.revalidateDeletedSource(selection.contactId,
      this.heldResult?.preserveInput ? { preserveInput: true } : {});
  }

  updateOptions(update: RewriteOptionsUpdate): ReplySessionState {
    this.assertScope(update);
    if (JSON.stringify(update.options) !== JSON.stringify(this.state.options)) {
      this.notifyInputChanged();
      this.cancelPending();
      this.lastAttempt = undefined;
      this.publish({ options: { ...update.options }, phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
    }
    return this.getState();
  }

  async setMode(update: ReplyModeUpdate): Promise<void> {
    this.assertScope(update);
    if (update.mode !== this.state.mode) {
      this.invalidateInput();
      this.cancelMessagePage();
      this.publish({ mode: update.mode, messages: { ...this.state.messages,
        phase: this.state.messages.items.length ? 'ready' : 'idle' } });
    }
    if (update.mode === 'reply_to_message' && this.state.messages.phase === 'idle') {
      await this.loadMessages({ ...update, older: false });
    }
  }
  async loadMessages(request: ReplyMessagePageRequest): Promise<void> {
    this.assertScope(request);
    if (this.pendingContent) throw new Error('请等待联系人内容恢复完成，失败时请重新读取讨论。');
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    if (this.state.messages.phase === 'loading') return;
    const before = request.older ? this.state.messages.nextCursor : null;
    if (request.older && !before) return;
    this.cancelMessagePage();
    const operation = this.messageOperation;
    const generation = this.backend.getConnectionGeneration();
    const pending = new AbortController();
    this.messagePending = pending;
    const current = () => operation === this.messageOperation && generation === this.backend.getConnectionGeneration()
      && request.scopeRevision === this.state.scopeRevision && request.contactId === this.state.contactId;
    this.publish({ messages: { ...this.state.messages, phase: 'loading' } });
    const noticeRevision = this.noticeRevision;
    try {
      const page = await readReplyMessages(this.backend, request.contactId, before, pending.signal);
      if (!current() || page.generation !== generation) return;
      const known = new Set(this.state.messages.items.map((item) => item.messageId));
      const items = before ? [...this.state.messages.items, ...page.messages.filter((item) => !known.has(item.messageId))] : page.messages;
      if (this.state.targetMessageId && !items.some((item) => item.messageId === this.state.targetMessageId)) {
        this.invalidateInput();
        this.publish({ targetMessageId: null });
      }
      this.publish({ messages: { phase: 'ready', items, nextCursor: page.nextCursor },
        messageNotice: { ...this.state.messageNotice,
          needsRefresh: before || noticeRevision !== this.noticeRevision ? this.state.messageNotice.needsRefresh : false,
          changed: before || noticeRevision !== this.noticeRevision ? this.state.messageNotice.changed : false } });
    } catch {
      if (current()) this.publish({ messages: { ...this.state.messages, phase: 'failed' } });
    } finally { if (this.messagePending === pending) this.messagePending = undefined; }
  }
  selectMessage(selection: ReplyMessageSelection): ReplySessionState {
    this.assertScope(selection);
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    if (this.state.mode !== 'reply_to_message' || !this.state.messages.items.some((item) => item.messageId === selection.messageId)) {
      throw new Error('待回复消息已失效，请重新选择。');
    }
    if (selection.messageId !== this.state.targetMessageId) {
      const suggested = this.directionDerived;
      this.directionDerived = false;
      this.invalidateInput(); this.publish({ targetMessageId: selection.messageId,
        ...(suggested ? { direction: '' } : {}) });
    }
    return this.getState();
  }
  updateDirection(update: ReplyDirectionUpdate): ReplySessionState {
    this.assertScope(update);
    if (this.state.mode !== 'reply_to_message') throw new Error('请先切换到回复模式。');
    if (update.direction !== this.state.direction) {
      this.directionDerived = false;
      this.invalidateInput(); this.publish({ direction: update.direction });
    }
    return this.getState();
  }
  updatePurpose(update: import('../../shared/reply-bridge').ReplyPurposeUpdate): ReplySessionState {
    this.assertScope(update);
    if (this.state.mode !== 'initiate_conversation') throw new Error('请先选择主动聊聊。');
    if (update.purpose !== this.state.purpose) {
      this.directionDerived = false;
      this.invalidateInput(); this.publish({ purpose: update.purpose });
    }
    return this.getState();
  }

  updateCorrection(update: ReplyCorrectionUpdate): ReplySessionState {
    this.assertScope(update);
    if (this.state.mode === 'rewrite_draft') throw new Error('请先选择聊天场景。');
    if (update.correction !== this.state.correction) {
      this.invalidateInput(true); this.publish({ correction: update.correction });
    }
    return this.getState();
  }

  async explore(selection: ContactSelection, changeGroup = false, automatic = false): Promise<void> {
    this.assertScope(selection); this.refreshGenerationEligibility();
    this.assertSessionSelection();
    if (this.state.generationBlock || this.state.mode === 'rewrite_draft' || this.state.phase === 'waiting'
      || this.state.exploration.phase === 'waiting' || this.state.mode === 'reply_to_message' && !this.state.targetMessageId) return;
    if (!automatic) {
      this.clearAutomaticExplorationTimer();
      if (this.state.exploration.automaticUpdatesPaused) {
        // 明确手动更新建立新任务；不重放失败的自动请求，也不静默延长旧根预算。
        this.currentExploration = undefined; this.explorationPurpose = undefined; this.strategyJob = undefined;
        this.stopAutomaticExploration();
      }
    }
    const signature = JSON.stringify({ mode: this.state.mode, target: this.state.targetMessageId,
      purpose: this.explorationPurpose ?? this.state.purpose, correction: this.state.correction,
      requirements: this.state.requirements, skill: this.state.skillChoice, scene: this.state.scene || null, changeGroup, automatic });
    if (!automatic && this.strategyJob?.type === 'open' && !this.strategyJob.request.automatic
      && this.strategyJob.signature === signature && this.state.exploration.phase === 'failed') {
      await this.runStrategy(this.strategyJob); return;
    }
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) throw new Error('后端连接不可用，请重新连接。');
    const operation = ++this.explorationOperation;
    const pending = new AbortController(); this.explorationPending = pending;
    this.publish({ exploration: { phase: 'waiting', result: null, canRetry: false } });
    try {
      const previous = this.currentExploration;
      const identity = previous ? { sessionId: previous.sessionId, currentInputVersionId: previous.inputVersion, generation }
        : await explorationIdentity(this.backend, selection.contactId, this.state.savedSession?.sessionId ?? undefined, pending.signal);
      if (pending.signal.aborted || operation !== this.explorationOperation || identity.generation !== generation
        || selection.contactId !== this.state.contactId || selection.scopeRevision !== this.state.scopeRevision) return;
      this.explorationPurpose ??= this.state.purpose;
      const request: ExplorationRequest = { contactId: selection.contactId, sessionId: identity.sessionId,
        operationKey: randomUUID(), expectedInputVersionId: identity.currentInputVersionId, previousId: previous?.taskId ?? null,
        scene: this.state.mode as 'reply_to_message' | 'initiate_conversation', targetMessageId: this.state.targetMessageId,
        purposeHint: this.explorationPurpose, correction: this.state.correction.trim(), requirements: this.state.requirements.trim(),
        skill: { ...this.state.skillChoice }, skillScene: this.state.scene || null, changeGroup, automatic };
      if (!automatic && !previous?.confirmedIntent && !this.automaticExploration) {
        this.automaticExploration = { contactId: selection.contactId, scopeRevision: selection.scopeRevision,
          generation, sessionId: identity.sessionId, remaining: 3, expiresAt: Date.now() + 15 * 60_000, queued: false };
      }
      this.strategyJob = { type: 'open', request, signature, input: this.strategySnapshot(selection) };
      await this.runStrategy(this.strategyJob);
    } catch { if (operation === this.explorationOperation && !pending.signal.aborted) this.publish({ exploration: { phase: 'failed', result: null } }); }
    finally { if (this.explorationPending === pending) this.explorationPending = undefined; }
  }

  async selectDirection(selection: ReplyDirectionChoice): Promise<ReplySessionState> {
    this.assertScope(selection);
    const result = this.state.exploration.result;
    const option = result?.directions.find((item) => item.suggestionId === selection.suggestionId);
    if (!result || !option || result.inputVersion !== selection.inputVersion || this.state.exploration.phase !== 'ready') throw new Error('方向建议已失效，请重新探索。');
    this.stopAutomaticExploration();
    this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
      taskId: result.taskId, inputVersion: result.inputVersion, action: 'confirm', suggestionId: option.suggestionId },
      input: this.strategySnapshot(selection) };
    await this.runStrategy(this.strategyJob);
    return this.getState();
  }
  beginClarificationEdit(selection: ReplyClarificationEdit): ReplySessionState {
    this.assertScope(selection); this.assertSessionSelection();
    const result = this.currentExploration;
    if (!result?.question || result.inputVersion !== selection.inputVersion
      || result.question.questionId !== selection.questionId) throw new Error('关键问题已经失效，请更新理解。');
    this.stopAutomaticExploration(!result.confirmedIntent);
    return this.getState();
  }
  async answerClarification(selection: ReplyClarificationAnswer): Promise<void> {
    this.assertScope(selection);
    const result = this.state.exploration.result;
    if (!result?.question || result.inputVersion !== selection.inputVersion || result.question.questionId !== selection.questionId
      || this.state.exploration.phase !== 'ready') throw new Error('关键问题已经失效，请更新理解。');
    this.publish({ clarificationAnswer: selection.answer });
    this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
      taskId: result.taskId, inputVersion: result.inputVersion, action: 'answer', questionId: selection.questionId,
      answer: selection.answer, operationKey: randomUUID() }, input: this.strategySnapshot(selection) };
    await this.runStrategy(this.strategyJob);
  }
  async stopExploration(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    const result = this.currentExploration;
    if (!result || this.state.exploration.phase === 'waiting') return;
    this.stopAutomaticExploration();
    this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
      taskId: result.taskId, inputVersion: result.inputVersion, action: 'stop' }, input: this.strategySnapshot(selection) };
    await this.runStrategy(this.strategyJob);
  }
  async retryExploration(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.strategyJob?.type === 'open' && this.strategyJob.request.automatic) return;
    if (this.strategyJob && this.state.exploration.phase !== 'waiting') await this.runStrategy(this.strategyJob);
  }
  updateRequirements(update: ReplyRequirementsUpdate): ReplySessionState {
    this.assertScope(update);
    if (update.requirements !== this.state.requirements) { this.invalidateInput(true); this.publish({ requirements: update.requirements }); }
    return this.getState();
  }
  updateSkill(update: ReplySkillUpdate): ReplySessionState {
    this.assertScope(update);
    if (JSON.stringify(update.skill) !== JSON.stringify(this.state.skillChoice)) {
      this.generationSkillChoice = undefined;
      this.invalidateInput(true); this.publish({ skillChoice: { ...update.skill } });
    }
    return this.getState();
  }
  updateScene(update: import('../../shared/reply-bridge').ReplySceneUpdate): ReplySessionState {
    this.assertScope(update);
    if (typeof update.scene !== 'string' || update.scene.length > 256) throw new Error('精确场景不可用。');
    const scene = update.scene.trim();
    if (scene !== (this.state.scene ?? '')) {
      this.invalidateInput();
      this.publish({ scene, skillChoices: [] });
    }
    return this.getState();
  }
  private strategySnapshot(selection: ContactSelection): ReplyInputSnapshot {
    const contact = this.contacts.getState().contacts.find((item) => item.contactId === selection.contactId)!;
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName,
      correction: this.state.correction, userInstruction: this.state.requirements, clarificationAnswer: this.state.clarificationAnswer,
      skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) }, ...sceneSnapshot(this.state.scene || null) };
    if (this.state.mode === 'initiate_conversation') return { ...common, mode: 'initiate_conversation', purpose: this.state.purpose };
    const target = this.state.messages.items.find((item) => item.messageId === this.state.targetMessageId);
    if (!target) throw new Error('待回应消息已失效。');
    return { ...common, mode: 'reply_to_message', target: structuredClone(target), direction: this.state.direction };
  }
  private async runStrategy(job: StrategyJob): Promise<void> {
    this.refreshGenerationEligibility();
    this.assertSessionSelection();
    if (this.state.generationBlock) return;
    this.clearAutomaticExplorationTimer();
    this.notifyInputChanged(true); this.cancelPending(); this.lastAttempt = undefined;
    this.explorationPending?.abort();
    const pending = new AbortController(); this.explorationPending = pending;
    const operation = ++this.explorationOperation, scopeRevision = this.state.scopeRevision;
    const viewOperation = this.operation;
    const generation = this.backend.getConnectionGeneration();
    let ownedGeneration: OwnedAssistantGeneration | undefined;
    let ownedPreparation: OwnedAssistantPreparation | undefined;
    let generationReceipt: AssistantGenerationReceipt | undefined;
    let generationTerminal = false;
    const candidateRequest = job.type === 'action' && job.request.generate === true;
    if (candidateRequest) {
      this.strategyCandidatePending = pending;
    }
    const automaticTask = job.type === 'open' && job.request.automatic ? this.automaticExploration : undefined;
    const current = () => (!(job.type === 'open' && job.request.automatic)
      || Boolean(automaticTask && automaticTask === this.automaticExploration))
      && !pending.signal.aborted && operation === this.explorationOperation
      && (!candidateRequest || viewOperation === this.operation)
      && scopeRevision === this.state.scopeRevision && job.request.contactId === this.state.contactId
      && job === this.strategyJob && (!this.state.savedSession?.sessionId || job.request.sessionId === this.state.savedSession.sessionId)
      && generation === this.backend.getConnectionGeneration()
      && (!ownedGeneration || this.generationJobs.canPublish(ownedGeneration, {
        connectionGeneration: ownedGeneration.identity.connectionGeneration,
        contactId: job.request.contactId, sessionId: this.state.savedSession?.sessionId ?? job.request.sessionId }));
    if (job.sourceValidation && generation !== undefined) job.sourceValidation = {
      scope: { contactId: job.request.contactId, scopeRevision, sessionId: job.request.sessionId },
      operation, generation, phase: 'checking', inputs: [],
    };
    this.publish({ exploration: { phase: 'waiting', result: this.state.exploration.result, canRetry: true,
      automaticUpdatesPaused: this.state.exploration.automaticUpdatesPaused } });
    try {
      if (this.strategyCandidatePending === pending) {
        if (generation === undefined) throw new Error('本次生成连接尚未确认。');
        ownedPreparation = this.generationJobs.beginPreparation({ connectionGeneration: generation,
          contactId: job.request.contactId, sessionId: job.request.sessionId }, pending,
          captureAssistantGenerationStopping(this.backend, { connectionGeneration: generation,
            contactId: job.request.contactId, sessionId: job.request.sessionId }),
          job.type === 'action' && job.request.action !== 'stop' ? { taskId: job.request.taskId,
            inputVersionId: job.request.inputVersion, action: job.request.action,
            suggestionId: job.request.action === 'confirm' ? job.request.suggestionId ?? null : null,
            operationKey: job.request.action === 'answer' ? job.request.operationKey
              : (job.confirmationOperationKey ??= randomUUID()) } : undefined);
      }
      const prepared = job.type === 'action' && candidateRequest && job.request.action !== 'stop'
        ? await prepareExplorationAction(this.backend, job.request, pending.signal) : undefined;
      if (prepared?.kind === 'prepared') {
        if (!ownedPreparation || prepared.generation !== generation) throw new Error('本次候选准备归属尚未确认。');
        ownedGeneration = this.generationJobs.receivePrepared(ownedPreparation, prepared.receipt);
        generationReceipt = prepared.receipt;
        if (!pending.signal.aborted && generation === this.backend.getConnectionGeneration()) {
          this.retainRetry(prepared.receipt.requestKey, job.request.contactId, job.request.sessionId, () => { this.strategyJob = job; return this.runStrategy(job); });
        }
        ownedPreparation = undefined;
        if (current()) this.publish({ phase: 'waiting', canRetry: false,
          exploration: { phase: 'ready', result: null, canRetry: true } });
      } else if (prepared && ownedPreparation) {
        this.generationJobs.completePreparationWithoutGeneration(ownedPreparation); ownedPreparation = undefined;
      }
      if (pending.signal.aborted || generation === undefined || generation !== this.backend.getConnectionGeneration()) return;
      if (ownedGeneration) await this.generationJobs.acquire(ownedGeneration);
      const result = job.type === 'open' ? await openExploration(this.backend, job.request, pending.signal)
        : prepared?.kind === 'prepared' ? await (() => {
          if (!ownedGeneration) throw new Error('本次候选生成尚未登记。');
          const execution = actOnExploration(this.backend, job.request, pending.signal, prepared.receipt);
          this.generationJobs.requestStarted(ownedGeneration); return execution;
        })() : prepared ?? await actOnExploration(this.backend, job.request, pending.signal);
      if (prepared?.kind === 'prepared' && (result.kind !== 'generated' || result.taskId !== prepared.taskId)) {
        throw new Error('本次确认结果不属于原准备任务。');
      }
      generationTerminal = result.kind === 'generated';
      if (generationTerminal && ownedGeneration) this.generationJobs.completed(ownedGeneration);
      if (!current() || result.generation !== generation) return;
      const actualInputVersionId = result.kind === 'exploration' ? result.result.inputVersion
        : result.kind === 'generated' ? result.reply.inputVersionId : undefined;
      if (actualInputVersionId) {
        job.actualInputVersionId = actualInputVersionId;
        const sourceState = await this.strategyInputSourceState(job, actualInputVersionId, pending.signal, current);
        if (!current()) return;
        if (sourceState === 'unavailable') {
          this.clearUnavailableCandidateSource({ contactId: job.request.contactId, scopeRevision, sessionId: job.request.sessionId },
            [], new Set([actualInputVersionId]));
          return;
        }
        if (sourceState === 'unknown') throw new Error('本次探索来源尚未核验。');
      }
      if (result.kind === 'exploration') {
        this.currentExploration = result.result;
        this.generationSkillChoice = result.result.usedSkill
          ? { mode: 'user', versionId: result.result.usedSkill.versionId } : { mode: 'disabled', versionId: null };
        const confirmed = result.result.confirmedIntent;
        if (confirmed) { this.directionDerived = true; this.stopAutomaticExploration(); }
        this.publish({ exploration: { phase: 'ready', result: result.result, canRetry: true,
          automaticUpdatesPaused: !confirmed && !this.automaticExploration
            && Boolean(this.state.exploration.automaticUpdatesPaused) },
          savedSession: { phase: 'idle', sessionId: result.result.sessionId, turns: [], inputs: [], currentInputVersionId: null }, skillChoices: result.result.skillChoices,
          ...(confirmed ? this.state.mode === 'reply_to_message' ? { direction: confirmed } : { purpose: confirmed } : {}) });
      } else if (result.kind === 'paused') {
        this.stopAutomaticExploration();
        this.currentExploration = undefined; this.explorationPurpose = undefined;
        this.publish({ exploration: { phase: 'paused', result: null, canRetry: false } });
      } else {
        this.stopAutomaticExploration();
        this.currentExploration = undefined; this.explorationPurpose = undefined;
        const input = job.input.mode === 'rewrite_draft' ? job.input : job.input.mode === 'reply_to_message'
          ? { ...job.input, direction: result.confirmedIntent } : { ...job.input, purpose: result.confirmedIntent };
        this.directionDerived = true;
        this.publish({ exploration: { phase: 'ready', result: null, canRetry: true }, phase: 'ready', errorCode: undefined,
          savedSession: { phase: 'idle', sessionId: result.reply.assistantSessionId, turns: [], inputs: [], currentInputVersionId: null },
          ...(input.mode === 'reply_to_message' ? { direction: input.direction } : input.mode === 'initiate_conversation' ? { purpose: input.purpose } : {}) });
        if (this.state.result?.replyRequestId !== result.reply.replyRequestId) this.publish({ result: {
          ...result.reply, input, candidates: result.reply.candidates.map((original) => ({ original, editedText: original.text })) },
          selectedCandidateId: result.reply.candidates[0].candidateId });
        await this.restoreCandidateVersions({ contactId: job.request.contactId, scopeRevision },
          result.reply.assistantSessionId, result.reply.candidates.map((candidate) => candidate.candidateId));
      }
    } catch (error) {
      if (ownedPreparation && !ownedGeneration && !generationReceipt && error instanceof BackendRequestFailure
        && error.kind === 'response' && error.noGeneration) {
        this.generationJobs.receivePreparationNoGenerationProof(ownedPreparation, error.noGeneration,
          this.backend.getConnectionGeneration());
        generationTerminal = true;
      }
      if (ownedGeneration && generationReceipt && !generationTerminal && error instanceof BackendRequestFailure
        && error.kind === 'response') await this.recordFailedGenerationResponse(ownedGeneration, generationReceipt, pending.signal, error);
      const preparationRejected = error instanceof BackendRequestFailure && error.kind === 'response'
        && error.status === 409 && (error.code === 'expression_preferences_changed'
          || error.reason?.startsWith('prepared_context_') === true);
      if (candidateRequest && preparationRejected) {
        this.stopAutomaticExploration();
        await this.revalidateRejectedPreparation({ contactId: job.request.contactId, scopeRevision }, generationReceipt, current);
        const publishRecovery = current();
        if (this.strategyJob === job) {
          this.strategyJob = undefined; this.currentExploration = undefined; this.explorationPurpose = undefined;
        }
        if (publishRecovery) this.publish({ exploration: { phase: 'failed', result: null, canRetry: false, automaticUpdatesPaused: true } });
        return;
      }
      if (current()) {
        const automatic = job.type === 'open' && Boolean(job.request.automatic);
        const providerLimit = error instanceof BackendRequestFailure
          && error.status === 409 && error.code === 'provider_context_limit';
        this.publish({ ...(providerLimit ? { phase: 'failed' as const, errorCode: 'provider_context_limit' as const,
          canRetry: false, inputBudgetNotice: undefined }
          : ownedGeneration ? { phase: this.state.result ? 'ready' as const : 'failed' as const } : {}),
          exploration: { phase: 'failed', result: null, canRetry: !automatic && !providerLimit,
          automaticUpdatesPaused: automatic } });
        if (providerLimit) {
          this.stopAutomaticExploration();
          this.strategyJob = undefined; this.currentExploration = undefined; this.explorationPurpose = undefined;
        } else if (automatic) this.stopAutomaticExploration(true);
      }
    } finally {
      if (ownedGeneration) await this.finishGeneration(ownedGeneration, generationTerminal);
      if (ownedPreparation) this.generationJobs.finish(ownedPreparation);
      if (this.strategyCandidatePending === pending) this.strategyCandidatePending = undefined;
      if (this.explorationPending === pending) this.explorationPending = undefined;
      if (current() && this.automaticExploration?.queued) this.queueAutomaticExploration();
    }
  }

  private async strategyInputSourceState(job: StrategyJob, inputVersionId: string, signal: AbortSignal,
    current: () => boolean): Promise<'active' | 'unavailable' | 'unknown'> {
    const validation = job.sourceValidation;
    if (!validation) return 'active';
    const valid = () => current() && job.sourceValidation === validation
      && validation.operation === this.explorationOperation && validation.generation === this.backend.getConnectionGeneration()
      && validation.scope.contactId === this.state.contactId && validation.scope.scopeRevision === this.state.scopeRevision
      && validation.scope.sessionId === job.request.sessionId;
    if (!valid()) return 'unknown';
    const known = validation.phase === 'ready' && !this.candidateSourceCheck
      ? validation.inputs.find((input) => input.inputVersionId === inputVersionId) : undefined;
    if (known) return known.state === 'active' ? 'active' : 'unavailable';
    // 首次 open 的实际新输入由响应给出；完整快照未覆盖它时只重新核验，不猜测前版本或复制依据。
    try {
      const saved = await readAssistantSession(this.backend, job.request.contactId, job.request.sessionId, signal);
      if (!valid() || saved.generation !== validation.generation || this.candidateSourceCheck) return 'unknown';
      validation.phase = 'ready';
      validation.inputs = saved.inputs.map(({ inputVersionId, state }) => ({ inputVersionId, state }));
      return saved.inputs.some((input) => input.inputVersionId === inputVersionId && input.state === 'active')
        ? 'active' : 'unavailable';
    } catch (error) {
      if (!valid()) return 'unknown';
      validation.phase = 'failed'; validation.inputs = [];
      if (error instanceof BackendRequestFailure && error.kind === 'response'
        && (error.status === 404 && error.code === 'not_found' || error.status === 409 && error.reason === 'source_unavailable')) {
        this.clearUnavailableCandidateSource(validation.scope);
      }
      return 'unknown';
    }
  }

  async generate(selection: GenerateReply): Promise<void> {
    const contactState = this.assertScope(selection);
    this.assertSessionSelection();
    this.refreshGenerationEligibility();
    if (this.state.generationBlock) throw new Error('请先确认本次联系人。');
    if (this.state.errorCode?.startsWith('prepared_context_') && !selection.newRequest) return;
    if (this.state.errorCode?.startsWith('prepared_context_')
      && !this.state.savedSession?.turns.some((turn) => turn.requiresReprepare
        && turn.inputVersionId === this.state.savedSession?.currentInputVersionId)) {
      await this.readSavedSession(selection);
      this.assertScope(selection); this.assertSessionSelection();
      if (!this.state.savedSession?.turns.some((turn) => turn.requiresReprepare
        && turn.inputVersionId === this.state.savedSession?.currentInputVersionId)) return;
    }
    const savedPreparation = this.state.savedSession;
    const oldPreparation = savedPreparation?.turns.find((turn) => turn.requiresReprepare
      && turn.inputVersionId === savedPreparation.currentInputVersionId);
    let reprepareInputVersion: string | undefined;
    if (oldPreparation && savedPreparation?.sessionId) {
      if (!selection.newRequest) {
        this.publish({ phase: 'failed', canRetry: false,
          errorCode: oldPreparation.generationActive === true ? 'prepared_context_running'
            : oldPreparation.generationActive === false ? 'prepared_context_reprepare_required' : 'prepared_context_unconfirmed' });
        return;
      }
      const originalOperation = this.operation;
      const checked = await checkPreparationFormat(this.backend, selection.contactId, savedPreparation.sessionId,
        oldPreparation, new AbortController().signal);
      this.assertScope(selection); this.assertSessionSelection();
      if (originalOperation !== this.operation || this.state.savedSession?.sessionId !== savedPreparation.sessionId
        || this.state.savedSession.currentInputVersionId !== oldPreparation.inputVersionId) return;
      if (!(checked.formatStatus === 'reprepare_required' && checked.receipt.state === 'failed'
        || checked.formatStatus === 'compatible' && checked.receipt.state === 'completed')) {
        this.publish({ phase: 'failed', canRetry: false,
          errorCode: checked.formatStatus === 'generation_running' ? 'prepared_context_running' : 'prepared_context_unconfirmed' });
        return;
      }
      await this.readSavedSession(selection);
      if (originalOperation !== this.operation || checked.generation !== this.backend.getConnectionGeneration()
        || this.state.savedSession?.sessionId !== savedPreparation.sessionId
        || this.state.savedSession.currentInputVersionId !== oldPreparation.inputVersionId) return;
      reprepareInputVersion = oldPreparation.inputVersionId;
    }
    this.stopAutomaticExploration();
    if (!selection.newRequest && this.restoredRetry && this.state.canRetry) {
      const retry = this.retainedRetries.get(this.restoredRetry);
      if (retry?.contactId === selection.contactId && retry.sessionId === this.state.savedSession?.sessionId) {
        await retry.run(); return;
      }
    }
    if (this.state.mode !== 'rewrite_draft' && this.state.exploration.result) {
      const result = this.state.exploration.result;
      const intent = this.state.mode === 'reply_to_message' ? this.state.direction : this.state.purpose;
      if (!intent.trim() || this.state.exploration.phase !== 'ready') return;
      const selected = result.confirmedIntent === intent.trim()
        ? result.directions.find((item) => item.direction === result.confirmedIntent) : undefined;
      this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
        taskId: result.taskId, inputVersion: result.inputVersion, action: 'confirm', generate: true,
        ...(selected ? { suggestionId: selected.suggestionId } : { directIntent: intent.trim() }) },
        input: this.strategySnapshot(selection) };
      await this.runStrategy(this.strategyJob); return;
    }
    if (this.state.mode !== 'rewrite_draft' && this.currentExploration) return;
    const generation = this.backend.getConnectionGeneration();
    const currentSessionId = this.state.savedSession?.sessionId;
    const activeReceipt = generation !== undefined && currentSessionId ? this.generationJobs.requestReceipt({
      connectionGeneration: generation, contactId: selection.contactId, sessionId: currentSessionId,
    }) : undefined;
    if ((!selection.newRequest && generation !== undefined && currentSessionId && this.generationJobs.hasPending({
      connectionGeneration: generation, contactId: selection.contactId, sessionId: currentSessionId,
    })) || this.state.phase === 'waiting' && (!selection.newRequest || !activeReceipt)) return;
    const replaceable = activeReceipt?.state === 'completed' ? undefined : activeReceipt;
    const contact = contactState.contacts.find((item) => item.contactId === selection.contactId)!;
    const options = this.state.options;
    const target = this.state.messages.items.find((item) => item.messageId === this.state.targetMessageId);
    if (this.state.mode === 'rewrite_draft' ? !contactState.draft.trim()
      : this.state.mode === 'initiate_conversation' ? !this.state.purpose.trim() : !target || !this.state.direction.trim()) return;
    if (this.state.mode === 'rewrite_draft' && options.inputKind === 'current_chat' && !options.pastedDirection?.trim()) return;
    this.notifyInputChanged();
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName, ...sceneSnapshot(this.state.scene || null) };
    const input: ReplyInputSnapshot = this.state.mode === 'rewrite_draft'
      ? { ...common, mode: 'rewrite_draft', draftText: contactState.draft.trim(),
        userInstruction: [tones[options.tone], options.instruction.trim()].filter(Boolean).join('\n') || null,
        includeRelationshipContext: options.includeRelationshipContext,
        ...(options.inputKind === 'current_chat' ? { inputKind: 'current_chat', pastedDirection: options.pastedDirection!.trim() } : {}) }
      : this.state.mode === 'initiate_conversation'
        ? { ...common, mode: 'initiate_conversation', purpose: this.state.purpose.trim(), correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(), clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) } }
        : { ...common, mode: 'reply_to_message', target: structuredClone(target!), direction: this.state.direction.trim(),
        correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(), clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) } };
    await this.generateInput(selection, input, replaceable, reprepareInputVersion);
  }

  async retryInterruptedGeneration(request: AssistantInterruptedRetry): Promise<void> {
    const contactState = this.assertScope(request); this.assertSessionSelection(); this.refreshGenerationEligibility();
    const generation = this.backend.getConnectionGeneration();
    const session = this.state.savedSession;
    if (this.state.generationBlock || this.state.phase === 'waiting' || session?.phase !== 'ready'
      || session.sessionId !== request.sessionId || session.currentInputVersionId !== request.inputVersionId) {
      throw new Error('请重新读取当前会话并确认中断生成。');
    }
    const contact = contactState.contacts.find((item) => item.contactId === request.contactId);
    if (!contact) throw new Error('中断生成联系人已变化。');
    const pending = new AbortController();
    const current = () => generation === this.backend.getConnectionGeneration()
      && request.contactId === this.state.contactId && request.scopeRevision === this.state.scopeRevision
      && request.sessionId === this.state.savedSession?.sessionId
      && request.inputVersionId === this.state.savedSession?.currentInputVersionId
      && !this.candidateSourceCheck && !this.catalogPending && !this.state.sessionCatalog?.selectionPending
      && !['deleting', 'failed'].includes(this.state.sessionDeletion ?? '');
    const saved = await readAssistantSession(this.backend, request.contactId, request.sessionId, pending.signal);
    const turn = saved.turns.find((item) => item.turnId === request.turnId && item.inputVersionId === request.inputVersionId);
    if (!current() || saved.generation !== generation || saved.currentInputVersionId !== request.inputVersionId
      || turn?.state !== 'failed' || !['app_quit', 'configuration_reload'].includes(turn.interruptionReason ?? '') || !turn.input || turn.reply) {
      throw new Error('中断生成或来源已失效，请重新读取。');
    }
    const input = await interruptedReplyInput(this.backend, turn, contact, pending.signal, current);
    this.assertScope(request); this.assertSessionSelection();
    if (!current()) throw new Error('中断生成归属已变化。');
    this.notifyInputChanged();
    await this.generateInput({ contactId: request.contactId, scopeRevision: request.scopeRevision, newRequest: true },
      input, undefined, request.inputVersionId, { turnId: request.turnId, inputVersionId: request.inputVersionId });
  }

  private async generateInput(selection: GenerateReply, input: ReplyInputSnapshot,
    replaceable?: PendingAssistantGenerationReceipt, expectedInputVersionId?: string, interrupted?: InterruptedReplyOrigin, adoptNewMessageId?: string): Promise<void> {
    if (adoptNewMessageId !== undefined && (!isUuid(adoptNewMessageId) || !isUuid(expectedInputVersionId)
      || interrupted !== undefined || input.mode === 'rewrite_draft')) throw new Error('本次新消息采用身份无效。');
    const generation = this.backend.getConnectionGeneration();
    const retryCandidateIds = !selection.newRequest && this.lastAttempt
      ? this.state.result?.candidates.map((candidate) => candidate.original.candidateId) ?? [] : [];
    if (selection.newRequest || !this.lastAttempt) this.lastAttempt = { input, requestKey: randomUUID(),
      ...(expectedInputVersionId === undefined ? {} : { expectedInputVersionId }),
      ...(interrupted === undefined ? {} : { interrupted: Object.freeze({ ...interrupted }) }),
      ...(adoptNewMessageId === undefined ? {} : { adoptNewMessageId: adoptNewMessageId.toLowerCase() }) };
    const attempt = this.lastAttempt;
    if (replaceable && selection.newRequest) this.generationJobs.cancelRequest(replaceable);
    this.cancelPending();
    // 本次输入与请求键已捕获；清理旧预算提示不能丢失本次同键重试身份。
    this.lastAttempt = attempt;
    const operation = this.operation;
    const pending = new AbortController();
    this.pending = pending;
    const selectedSessionId = this.state.savedSession?.sessionId;
    let job: OwnedAssistantGeneration | undefined;
    let generationTerminal = false;
    let budgetReceipt: Parameters<AssistantGenerationJobs['receiveReceipt']>[1] | undefined;
    const current = () => operation === this.operation && generation === this.backend.getConnectionGeneration()
      && !pending.signal.aborted && !this.state.sessionCatalog?.selectionPending
      && selection.scopeRevision === this.state.scopeRevision && selection.contactId === this.state.contactId
      && (!job || this.generationJobs.canPublish(job, { connectionGeneration: job.identity.connectionGeneration,
        contactId: this.state.contactId, sessionId: this.state.savedSession?.sessionId ?? job.identity.sessionId }));
    this.publish({ phase: 'waiting', errorCode: undefined, canRetry: true });
    try {
      const sessionId = selectedSessionId
        ?? (await defaultAssistantSession(this.backend, selection.contactId, pending.signal)).sessionId;
      if (generation === undefined || pending.signal.aborted || generation !== this.backend.getConnectionGeneration()) return;
      job = this.generationJobs.begin({ connectionGeneration: generation, contactId: selection.contactId,
        sessionId, requestKey: attempt.requestKey }, pending,
        captureAssistantGenerationStopping(this.backend, { connectionGeneration: generation, contactId: selection.contactId, sessionId }));
      const ownedJob = job;
      const prepared = async (receipt: Parameters<AssistantGenerationJobs['receiveReceipt']>[1]) => {
        this.generationJobs.receiveReceipt(ownedJob, receipt); budgetReceipt = receipt;
        if (replaceable && selection.newRequest) this.generationJobs.confirmReplacement(replaceable);
        await this.generationJobs.acquire(ownedJob);
      };
      const requested = () => this.generationJobs.requestStarted(ownedJob);
      const prepareRequested = () => this.generationJobs.prepareStarted(ownedJob);
      const notReserved = (proof: import('../../shared/assistant-no-generation').AssistantNoGenerationProof) => {
        this.generationJobs.receiveNoGenerationProof(ownedJob, proof, this.backend.getConnectionGeneration());
        generationTerminal = true;
      };
      const adoptionOptions = attempt.adoptNewMessageId === undefined ? undefined
        : Object.freeze({ adoptNewMessageId: attempt.adoptNewMessageId, expectedInputVersionId: attempt.expectedInputVersionId });
      const result = attempt.interrupted
        ? await retryInterruptedReply(this.backend, selection.contactId, sessionId, attempt.interrupted, attempt.requestKey,
          pending.signal, prepared, requested, prepareRequested, notReserved)
        : replaceable && selection.newRequest
        ? await replaceReply(this.backend, attempt.input, attempt.requestKey, replaceable.requestKey, pending.signal, sessionId, prepared, requested, prepareRequested, notReserved, adoptionOptions)
        : await generateReply(this.backend, attempt.input, attempt.requestKey, pending.signal, sessionId, prepared, requested, attempt.expectedInputVersionId, prepareRequested, notReserved, adoptionOptions);
      generationTerminal = true;
      this.generationJobs.completed(ownedJob);
      if (!current() || result.generation !== generation) return;
      // 可靠完成可作为历史读取；只有仍属当前输入且来源有效的结果才可成为当前候选。
      // 完成确认接管此前在途读取，避免较旧快照仅因晚返回而覆盖本次确认。
      this.savedRead?.abort();
      const beforeRead = this.state.savedSession;
      const saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      const completed = saved.turns.find((turn) => turn.inputVersionId === result.inputVersionId
        && turn.requestKey === attempt.requestKey);
      let observed = this.state.savedSession;
      // 同一判定在异步映射前后使用；任何较晚完整快照均优先。
      const acceptLatestRead = () => {
        observed = this.state.savedSession;
        if (observed === beforeRead || observed?.phase === 'ready'
          && observed.sessionId === sessionId && observed.currentInputVersionId === result.inputVersionId
          && observed.turns.some((turn) => turn.inputVersionId === result.inputVersionId
            && turn.requestKey === attempt.requestKey && turn.state === 'completed'
            && turn.reply?.replyRequestId === result.replyRequestId)
          && observed.inputs.some((input) => input.inputVersionId === result.inputVersionId && input.state === 'active')) return true;
        this.lastAttempt = undefined;
        this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
          errorCode: undefined, inputBudgetNotice: undefined });
        return false;
      };
      if (!acceptLatestRead()) return;
      if (saved.currentInputVersionId !== result.inputVersionId || completed?.state !== 'completed'
        || completed.reply?.replyRequestId !== result.replyRequestId) {
        this.lastAttempt = undefined;
        this.publish({ phase: 'idle', canRetry: false, result: null, selectedCandidateId: null });
        await this.readSavedSession(selection); return;
      }
      let resultInput = attempt.input;
      if ('restoredInput' in result && (!completed.input || JSON.stringify(completed.input) !== JSON.stringify(result.restoredInput))) {
        throw new Error('原输入恢复与已保存结果不一致，请重试同一次生成。');
      }
      if (attempt.adoptNewMessageId !== undefined && (!completed.input || completed.requestKey !== attempt.requestKey
        || !saved.inputs.some((input) => input.inputVersionId === result.inputVersionId && input.state === 'active')
        || !('adoptionSubmission' in result) || !result.adoptionSubmission
        || !matchesReplyAdoption(completed.input, result.adoptionSubmission))) {
        throw new Error('本次新消息输入尚未可靠确认，请重试同一次生成。');
      }
      if ('restoredInput' in result || attempt.adoptNewMessageId !== undefined) {
        resultInput = await interruptedReplyInput(this.backend, completed,
          { contactId: selection.contactId, displayName: attempt.input.contactDisplayName }, pending.signal, current);
        if (!current() || !acceptLatestRead()) return;
      }
      this.savedRead?.abort(); this.savedRead = undefined;
      // 已核实的完成结果先更新回执；后续版本读取不能让它仍成为在途替换目标。
      this.generationJobs.receiveReceipt(ownedJob, { sessionId, requestKey: attempt.requestKey,
        turnId: completed.turnId, inputVersionId: result.inputVersionId, state: 'completed' });
      const inputBudgetNotice = result.inputBudget ? { contactId: selection.contactId,
        scopeRevision: selection.scopeRevision, sessionId: result.assistantSessionId, requestKey: attempt.requestKey,
        inputVersionId: result.inputVersionId, connectionGeneration: generation, operation, decision: result.inputBudget } : undefined;
      const authoritative = observed !== beforeRead ? observed?.turns.find((turn) => turn.inputVersionId === result.inputVersionId
        && turn.requestKey === attempt.requestKey && turn.state === 'completed'
        && turn.reply?.replyRequestId === result.replyRequestId) : completed;
      const basisChanges = authoritative?.basisChanges ?? authoritative?.reply?.basisChanges;
      // 同键重放恢复原结果，保留该候选在本次运行中的编辑和选择。
      if (this.state.result?.replyRequestId === result.replyRequestId) {
        this.publish({ phase: 'ready', inputBudgetNotice, result: { ...this.state.result, basisChanges } }); return;
      }
      this.publish({ phase: 'ready', savedSession: observed !== beforeRead ? observed
        : { phase: 'idle', sessionId: result.assistantSessionId, turns: [], inputs: [], currentInputVersionId: null },
      inputBudgetNotice,
      ...(result.assistantSessionId !== this.state.savedSession?.sessionId ? { sessionDeletion: undefined } : {}),
      result: { replyRequestId: result.replyRequestId, assistantSessionId: result.assistantSessionId,
        inputVersionId: result.inputVersionId, input: resultInput,
        contextEvidenceIds: result.contextEvidenceIds,
        basisChanges,
        styleSampleIds: result.styleSampleIds,
        expressionPreferenceIds: result.expressionPreferenceIds, expressionPreferences: result.expressionPreferences,
        usedSkill: result.usedSkill,
        inputBudget: result.inputBudget,
        candidates: result.candidates.map((original) => ({ original, editedText: original.text })) },
      selectedCandidateId: result.candidates[0].candidateId });
      await this.restoreCandidateVersions(selection, result.assistantSessionId,
        result.candidates.map((candidate) => candidate.candidateId));
    } catch (error) {
      const failure = error instanceof BackendRequestFailure ? error : undefined;
      // 无实际回执时，泛HTTP拒绝不能证明同key既有或在途领取已结束。
      const budgetFailure = failure?.code === 'input_budget_exceeded' || failure?.code === 'input_budget_unavailable';
      const providerLimit = failure?.status === 409 && failure.code === 'provider_context_limit';
      const formatFailure = failure?.reason?.startsWith('prepared_context_') === true;
      const preferencesChanged = failure?.kind === 'response' && failure.status === 409
        && failure.code === 'expression_preferences_changed';
      let receipt = budgetReceipt;
      const beforeRead = this.state.savedSession;
      let saved: Awaited<ReturnType<typeof readAssistantSession>> | undefined;
      let readFailure: BackendRequestFailure | 'unavailable' | undefined;
      // 明确业务响应还须核验原实际身份的终态；断开/取消不能以历史failed快照推断重试租约已结束。
      const terminalProofRequired = Boolean(job && (receipt || budgetFailure) && failure?.kind === 'response' && failure.status !== undefined
        && failure.code && failure.code !== 'assistant_session_in_progress'
        && generation === this.backend.getConnectionGeneration());
      // 同一次实际读取同时证明作业终态和预算归属；离开视图只停止发布，不跳过终态核验。
      const receiptSessionId = receipt?.sessionId ?? (budgetFailure ? job?.identity.sessionId : undefined);
      if (receiptSessionId && (terminalProofRequired || current() && budgetFailure && failure?.inputBudget)) {
        try {
          const verified = await readAssistantSession(this.backend, selection.contactId, receiptSessionId,
            new AbortController().signal);
          if (!receipt && budgetFailure && job && verified.generation === generation) {
            const rejected = verified.turns.find((turn) => turn.requestKey === attempt.requestKey && turn.state === 'failed');
            if (rejected) {
              receipt = { sessionId: receiptSessionId, requestKey: attempt.requestKey,
                turnId: rejected.turnId, inputVersionId: rejected.inputVersionId, state: 'failed' };
              budgetReceipt = receipt;
              this.generationJobs.receiveReceipt(job, receipt);
            }
          }
          if (budgetFailure && failure?.inputBudget) saved = verified;
          if (terminalProofRequired && receipt) {
            const terminalReceipt = receipt;
            const terminal = verified.turns.find((turn) => turn.turnId === terminalReceipt.turnId
              && turn.requestKey === attempt.requestKey && turn.inputVersionId === terminalReceipt.inputVersionId);
            if (job && verified.generation === generation && generation === this.backend.getConnectionGeneration()
              && this.generationJobs.isActive(job) && terminal) {
              generationTerminal = terminal.state === 'completed'
                || ['redacted', 'unavailable'].includes(terminal.state) && terminal.input === null && terminal.reply === null;
              if (terminal.state === 'failed' && job) this.generationJobs.failedResponseReceived(job,
                !budgetFailure && !providerLimit && (failure?.code === 'reply_timeout' || failure?.code === 'assistant_session_save_failed' || (failure?.status ?? 0) >= 500), terminal.generationActive);
            }
          }
        } catch (readError) {
          if (budgetFailure && failure?.inputBudget) readFailure = readError instanceof BackendRequestFailure ? readError : 'unavailable';
          generationTerminal = terminalProofRequired && readError instanceof BackendRequestFailure && readError.kind === 'response'
            && readError.status === 404 && readError.code === 'not_found'
            && generation === this.backend.getConnectionGeneration();
        }
      }
      if (preferencesChanged) {
        await this.revalidateRejectedPreparation(selection, receipt, current);
        return;
      }
      const rejectedSessionId = job?.identity.sessionId ?? selectedSessionId;
      if (failure?.kind === 'response' && failure.status === 409 && failure.reason === 'source_deleted'
        && ['assistant_session_rejected', 'assistant_session_conflict', 'reply_rejected'].includes(failure.code ?? '')
        && generation === this.backend.getConnectionGeneration() && selection.contactId === this.state.contactId
        && selection.scopeRevision === this.state.scopeRevision && rejectedSessionId === this.state.savedSession?.sessionId) {
        const sessionId = rejectedSessionId;
        if (sessionId) {
          const wasCurrent = current();
          // 明确删除响应先撤下同键结果；后续读取失败也不能保留应删正文。
          const affected = this.state.savedSession?.sessionId === sessionId
            ? this.state.savedSession.turns.filter((turn) => turn.requestKey === attempt.requestKey)
              .flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []) : [];
          affected.push(...retryCandidateIds);
          this.savedRead?.abort(); this.savedRead = undefined;
          this.candidateRestoreOperation += 1;
          const scope = { contactId: selection.contactId, scopeRevision: selection.scopeRevision, sessionId };
          this.candidateVersions.setScope(scope);
          this.clearUnavailableCandidateSource(scope, affected,
            new Set(receipt ? [receipt.inputVersionId] : []));
          if (this.lastAttempt?.requestKey === attempt.requestKey) this.lastAttempt = undefined;
          if (wasCurrent) this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
            errorCode: 'source_unavailable', inputBudgetNotice: undefined });
          await this.readSavedSession(selection);
          return;
        }
      }
      if (current()) {
        if (budgetFailure) {
          if (!current()) return;
          const failed = saved?.turns.find((turn) => turn.turnId === receipt?.turnId
            && turn.requestKey === attempt.requestKey && turn.inputVersionId === receipt?.inputVersionId);
          const observed = this.state.savedSession;
          // 迟到复验不能越过更新的公开读取；同一CURRENT仍须保留合法预算错误。
          const superseded = observed !== beforeRead && !(observed?.phase === 'ready'
            && observed.sessionId === receipt?.sessionId && observed.currentInputVersionId === receipt?.inputVersionId
            && observed.turns.some((turn) => turn.turnId === receipt?.turnId && turn.requestKey === attempt.requestKey
              && turn.inputVersionId === receipt?.inputVersionId && turn.state === 'failed')
            && observed.inputs.some((input) => input.inputVersionId === receipt?.inputVersionId
              && input.turnId === receipt?.turnId && input.state === 'active'));
          const sourceUnavailable = readFailure instanceof BackendRequestFailure && readFailure.kind === 'response'
            && (readFailure.status === 404 && readFailure.code === 'not_found'
              || readFailure.status === 409 && ['assistant_session_conflict', 'assistant_session_rejected'].includes(readFailure.code ?? '')
                && ['source_unavailable', 'source_deleted'].includes(readFailure.reason ?? ''));
          if (sourceUnavailable && receiptSessionId) {
            // 已确认同会话不可读时清除既有正文；迟到完整读取不能恢复旧投影。
            this.savedRead?.abort(); this.savedRead = undefined;
            const scope = { contactId: selection.contactId, scopeRevision: selection.scopeRevision, sessionId: receiptSessionId };
            this.candidateVersions.setScope(scope); this.clearUnavailableCandidateSource(scope);
            this.candidateVersions.setScope(null); this.heldResult = undefined; this.candidateSourceCheck = undefined;
            this.publish({ savedSession: { phase: 'failed', sessionId: receiptSessionId, turns: [], inputs: [], currentInputVersionId: null },
              sourceAvailability: undefined, result: null, selectedCandidateId: null, phase: 'idle', canRetry: false,
              errorCode: undefined, inputBudgetNotice: undefined });
            return;
          }
          if (!saved && readFailure && receiptSessionId && failure?.inputBudget && !superseded && !sourceUnavailable) {
            // 无法复验不等于输入已失效；隐藏预算结论，保留本次身份供后端守卫重试。
            this.publish({ phase: 'failed', canRetry: true, inputBudgetNotice: undefined,
              errorCode: readFailure instanceof BackendRequestFailure && readFailure.kind === 'connection'
                ? 'connection' : 'unavailable' });
            return;
          }
          if (!receipt || !saved || saved.generation !== generation || saved.currentInputVersionId !== receipt.inputVersionId
            || superseded || failed?.state !== 'failed' || !saved.inputs.some((input) => input.inputVersionId === receipt.inputVersionId
              && input.turnId === receipt.turnId && input.state === 'active')) {
            this.lastAttempt = undefined;
            this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
              errorCode: undefined, inputBudgetNotice: undefined });
            return;
          }
        }
        const errorCode = failure?.kind === 'connection' ? 'connection'
          : budgetFailure ? failure.inputBudget?.state === 'exceeded' ? 'input_budget_exceeded' : 'input_budget_unavailable'
          : providerLimit ? 'provider_context_limit'
          : formatFailure ? failure?.reason === 'prepared_context_generation_running' ? 'prepared_context_running'
            : failure?.reason === 'prepared_context_generation_unconfirmed' ? 'prepared_context_unconfirmed' : 'prepared_context_reprepare_required'
          : failure?.code === 'reply_timeout' ? 'timeout'
          : failure?.code === 'assistant_session_save_failed' ? 'save_failed'
          : failure?.reason === 'target_message_unavailable' ? 'target_unavailable'
          : ['source_unavailable', 'source_deleted'].includes(failure?.reason ?? '') ? 'source_unavailable'
          : ['reply_rejected', 'assistant_session_rejected'].includes(failure?.code ?? '') ? 'rejected'
          : ['reply_unavailable', 'runtime_stopping'].includes(failure?.code ?? '') ? 'unavailable' : 'generation_failed';
        this.publish({ phase: 'failed', errorCode, ...(budgetFailure || providerLimit || formatFailure ? { canRetry: false } : {}),
          inputBudgetNotice: budgetReceipt && failure?.inputBudget && generation !== undefined ? {
            contactId: selection.contactId, scopeRevision: selection.scopeRevision, sessionId: budgetReceipt.sessionId,
            requestKey: budgetReceipt.requestKey, inputVersionId: budgetReceipt.inputVersionId,
            connectionGeneration: generation, operation, decision: failure.inputBudget,
          } : undefined });
      }
    } finally { if (job) await this.finishGeneration(job, generationTerminal); if (this.pending === pending) this.pending = undefined; }
  }

  selectCandidate(selection: ReplyCandidateSelection): ReplySessionState {
    this.assertCandidate(selection);
    this.notifyInputChanged();
    this.publish({ selectedCandidateId: selection.candidateId });
    return this.getState();
  }
  editCandidate(edit: ReplyCandidateEdit): ReplySessionState {
    const candidate = this.assertCandidate(edit);
    const editingDuringGeneration = this.state.phase === 'waiting';
    // 用户后续编辑接管展示；在途生成仍按原作业保存，完成回执不得覆盖这份编辑。
    if (editingDuringGeneration) { this.leaveGenerationView(); this.lastAttempt = undefined; }
    this.notifyInputChanged();
    candidate.editedText = edit.text;
    this.publish(editingDuringGeneration ? { phase: 'ready', canRetry: false } : {});
    return this.getState();
  }
  async readCandidateVersions(request: ReplyCandidateVersionRead): Promise<ReplySessionState> {
    this.assertVersionScope(request);
    this.candidateRestoreOperation += 1;
    const current = this.candidateVersionOperationCurrent(request);
    try { await this.candidateVersions.read(request, current); }
    catch (error) { await this.handleCandidateSourceUnavailable(error); throw error; }
    return this.getState();
  }
  updateCandidateVersionDraft(update: ReplyCandidateDraftUpdate): ReplySessionState {
    this.beginCandidateVersionEdit(update);
    const version = this.state.candidateVersions!.items.find((item) => item.candidateId === update.candidateId)!
      .history!.versions.find((item) => item.versionId === update.versionId)!;
    if (version.messages.length !== update.messages.length
      || version.messages.some((message, index) => message.messageId !== update.messages[index].messageId)) {
      throw new Error('本组消息身份已变化，请重新读取。');
    }
    const { candidateId, versionId, messages, requirements } = update;
    this.publish({ candidateDrafts: [...(this.state.candidateDrafts ?? []).filter((item) => item.candidateId !== candidateId),
      structuredClone({ candidateId, versionId, messages, requirements })] });
    return this.getState();
  }
  beginCandidateVersionEdit(selection: ReplyCandidateVersionDisplay): ReplySessionState {
    this.assertVersionScope(selection);
    const view = this.state.candidateVersions?.items.find((item) => item.candidateId === selection.candidateId);
    if (this.state.phase === 'waiting' || this.state.savedSession?.phase !== 'ready'
      || this.state.candidateVersions?.phase !== 'ready' || view?.phase !== 'ready'
      || view.displayVersionId !== selection.versionId
      || !view.history?.versions.some((version) => version.versionId === selection.versionId)) {
      throw new Error('本组编辑版本尚未核对，请重新读取。');
    }
    this.notifyInputChanged();
    return this.getState();
  }
  async saveCandidateVersion(edit: ReplyCandidateVersionEdit): Promise<ReplySessionState> {
    this.assertVersionScope(edit);
    this.candidateRestoreOperation += 1;
    this.notifyInputChanged();
    const current = this.candidateVersionOperationCurrent(edit);
    try {
      await this.candidateVersions.save(edit, current);
      if (current() && this.state.candidateVersions?.items.find((item) => item.candidateId === edit.candidateId)?.phase === 'ready') {
        this.publish({ candidateDrafts: this.state.candidateDrafts?.filter((item) => item.candidateId !== edit.candidateId) });
      }
    }
    catch (error) { await this.handleCandidateSourceUnavailable(error); throw error; }
    return this.getState();
  }
  async selectCandidateVersion(selection: ReplyCandidateVersionSelection): Promise<ReplySessionState> {
    this.assertVersionScope(selection);
    this.candidateRestoreOperation += 1;
    this.notifyInputChanged();
    const current = this.candidateVersionOperationCurrent(selection);
    try { await this.candidateVersions.select(selection, current); }
    catch (error) { await this.handleCandidateSourceUnavailable(error); throw error; }
    return this.getState();
  }
  showCandidateVersion(selection: ReplyCandidateVersionDisplay): ReplySessionState {
    this.assertVersionScope(selection);
    this.notifyInputChanged();
    this.candidateVersions.show(selection);
    return this.getState();
  }
  private assertVersionScope(request: ReplyCandidateVersionRead): void {
    this.assertScope(request); this.assertSessionSelection();
    if (request.sessionId !== this.state.savedSession?.sessionId || this.state.sessionDeletion === 'deleting'
      || this.state.sessionDeletion === 'failed' || this.state.sourceAvailability !== undefined) {
      throw new Error('本次候选会话已变化，请重新读取。');
    }
    this.candidateVersions.setScope(request);
  }
  private candidateVersionOperationCurrent(request: ContactSelection & { sessionId: string }): () => boolean {
    const operation = this.candidateRestoreOperation, generation = this.backend.getConnectionGeneration();
    return () => operation === this.candidateRestoreOperation && generation !== undefined
      && generation === this.backend.getConnectionGeneration()
      && request.contactId === this.state.contactId && request.scopeRevision === this.state.scopeRevision
      && request.sessionId === this.state.savedSession?.sessionId && this.state.sessionDeletion !== 'deleting';
  }
  private async handleCandidateSourceUnavailable(error: unknown, refreshSelection = true): Promise<void> {
    if (!(error instanceof AssistantCandidateSourceUnavailable)
      || error.generation !== this.backend.getConnectionGeneration()
      || error.scope.contactId !== this.state.contactId || error.scope.scopeRevision !== this.state.scopeRevision
      || error.scope.sessionId !== this.state.savedSession?.sessionId || this.state.sessionDeletion === 'deleting') return;
    this.candidateRestoreOperation += 1;
    this.savedRead?.abort(); this.savedRead = undefined;
    const pending = new AbortController(); this.savedRead = pending;
    const check: CandidateSourceCheck = { pending, scope: error.scope,
      turns: [...this.state.savedSession.turns.map((turn) => ({ turnId: turn.turnId,
        candidateIds: turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? [] })),
        ...this.candidateVersions.getCachedTurnCandidates(error.scope)],
      inputIds: this.state.savedSession.inputs.map((input) => input.inputVersionId),
      refreshMessages: this.state.messages.items.length > 0 || this.state.targetMessageId !== null,
      confirmedCandidateIds: error.candidateId === null ? [] : [error.candidateId],
      strategyJob: this.strategyJob, strategyOperation: this.explorationOperation,
      strategyWaiting: this.explorationPending !== undefined };
    if (check.strategyJob?.request.sessionId === error.scope.sessionId) check.strategyJob.sourceValidation = {
      scope: { ...error.scope }, operation: check.strategyOperation, generation: error.generation, phase: 'checking', inputs: [],
    };
    this.candidateSourceCheck = check;
    this.cancelMessagePage(); this.cancelPending(true); this.lastAttempt = undefined;
    if (error.candidateId !== null) this.clearUnavailableCandidateSource(error.scope, [error.candidateId]);
    this.publish({ sourceAvailability: 'checking', phase: this.state.result ? 'ready' : 'idle', canRetry: false, errorCode: undefined });
    const current = this.candidateVersionOperationCurrent(error.scope);
    let accepted = false;
    try {
      const saved = await readAssistantSession(this.backend, error.scope.contactId, error.scope.sessionId, pending.signal);
      if (pending.signal.aborted || !current() || saved.generation !== error.generation) return;
      accepted = Boolean(await this.acceptCandidateSourceSnapshot(saved, check, pending.signal, current));
    } catch {
      if (!pending.signal.aborted && current() && this.candidateSourceCheck === check) {
        this.clearUnavailableCandidateSource(error.scope);
        this.candidateSourceCheck = undefined;
        this.publish({ savedSession: { phase: 'failed', sessionId: error.scope.sessionId,
          turns: [], inputs: [], currentInputVersionId: null }, sourceAvailability: undefined });
      }
    } finally { if (this.savedRead === pending) this.savedRead = undefined; }
    if (!accepted || !current() || !refreshSelection) return;
    // 完整快照只证明来源有效性，实际选择仍从后端唯一指针重读，保留无正文占位。
    try {
      await this.candidateVersions.reconcile(error.scope,
        this.candidateVersions.getState().candidateVersions.items.map((item) => item.candidateId), current);
    } catch (selectionError) {
      // 新的选择来源失效再复验一次；持续失败以 failed/null 收尾，不循环读取。
      await this.handleCandidateSourceUnavailable(selectionError, false);
    }
  }
  private async acceptCandidateSourceSnapshot(saved: Awaited<ReturnType<typeof readAssistantSession>>, check: CandidateSourceCheck,
    signal: AbortSignal, operationCurrent: () => boolean): Promise<Awaited<ReturnType<typeof readAssistantSession>> | undefined> {
    const current = () => !signal.aborted && operationCurrent() && this.candidateSourceCheck === check
      && check.scope.sessionId === saved.sessionId && check.scope.contactId === this.state.contactId
      && check.scope.scopeRevision === this.state.scopeRevision && saved.generation === this.backend.getConnectionGeneration();
    if (!current()) return;
    let messages: ReplySessionState['messages'] | undefined;
    if (check.refreshMessages) {
      try {
        const page = await readReplyMessages(this.backend, check.scope.contactId, null, signal);
        if (page.generation !== saved.generation) return;
        const items = [...page.messages], cursors = new Set<string>();
        let nextCursor = page.nextCursor;
        // 已选消息可能来自较早分页；只沿后端实际游标核验，不沿用旧正文证明其仍有效。
        while (this.state.targetMessageId && !items.some((item) => item.messageId === this.state.targetMessageId) && nextCursor) {
          if (!current()) return;
          if (cursors.has(nextCursor)) throw new Error('消息分页游标无效。');
          cursors.add(nextCursor);
          const older = await readReplyMessages(this.backend, check.scope.contactId, nextCursor, signal);
          if (older.generation !== saved.generation) return;
          const known = new Set(items.map((item) => item.messageId));
          items.push(...older.messages.filter((item) => !known.has(item.messageId)));
          nextCursor = older.nextCursor;
        }
        messages = { phase: 'ready', items, nextCursor };
      } catch { messages = { phase: 'failed', items: [], nextCursor: null }; }
      if (!current()) return;
    }
    const confirmed = new Set(check.confirmedCandidateIds);
    const turns = saved.turns.map((turn) => !['redacted', 'unavailable'].includes(turn.state)
      && turn.reply?.candidates.some((candidate) => confirmed.has(candidate.candidateId))
      ? { ...turn, state: 'unavailable' as const, input: null, reply: null, placeholder: '相关来源不可用' } : turn);
    const unavailableTurns = new Set(turns.filter((turn) => ['redacted', 'unavailable'].includes(turn.state)).map((turn) => turn.turnId));
    const availableTurns = new Set(turns.map((turn) => turn.turnId));
    const candidateIds = check.turns.filter((turn) => unavailableTurns.has(turn.turnId) || !availableTurns.has(turn.turnId))
      .flatMap((turn) => turn.candidateIds);
    candidateIds.push(...confirmed);
    const inputs = saved.inputs.map((input) => input.turnId && unavailableTurns.has(input.turnId) && input.state === 'active'
      ? { ...input, state: 'unavailable' as const, content: null, placeholder: '相关来源不可用' } : input);
    const invalidInputs = new Set(inputs.filter((input) => input.state !== 'active').map((input) => input.inputVersionId));
    for (const inputId of check.inputIds) if (!inputs.some((input) => input.inputVersionId === inputId)) invalidInputs.add(inputId);
    const strategyValidation = check.strategyJob?.sourceValidation;
    if (check.strategyJob === this.strategyJob && check.strategyOperation === this.explorationOperation
      && strategyValidation?.operation === check.strategyOperation && strategyValidation.generation === saved.generation
      && strategyValidation.scope.contactId === check.scope.contactId
      && strategyValidation.scope.scopeRevision === check.scope.scopeRevision && strategyValidation.scope.sessionId === saved.sessionId) {
      // 只保留本次 operation 的来源身份/状态，迟到响应须按实际新输入版本匹配。
      strategyValidation.phase = 'ready';
      strategyValidation.inputs = inputs.map(({ inputVersionId, state }) => ({ inputVersionId, state }));
      const actualInputVersionId = check.strategyJob?.actualInputVersionId;
      const actualInput = inputs.find((input) => input.inputVersionId === actualInputVersionId);
      if (actualInputVersionId && (actualInput ? actualInput.state !== 'active' : !check.strategyWaiting)) {
        invalidInputs.add(actualInputVersionId);
      }
    }
    for (const result of [this.state.result, this.heldResult?.result]) {
      if (result?.assistantSessionId === saved.sessionId && result.inputVersionId
        && !inputs.some((input) => input.inputVersionId === result.inputVersionId && input.state === 'active')) {
        invalidInputs.add(result.inputVersionId);
        candidateIds.push(...result.candidates.map((candidate) => candidate.original.candidateId));
      }
    }
    // 首次探索保存的新输入尚未回包；expectedInputVersionId 只是前版本，不能证明目标仍有效。
    const strategyTarget = this.strategyJob?.request.sessionId === saved.sessionId
      && this.strategyJob.input.mode === 'reply_to_message' ? this.strategyJob.input.target.messageId : null;
    const strategyTargetUnavailable = Boolean(messages && strategyTarget
      && !messages.items.some((message) => message.messageId === strategyTarget));
    this.candidateVersions.setScope(check.scope);
    this.clearUnavailableCandidateSource(check.scope, candidateIds, invalidInputs, strategyTargetUnavailable);
    const targetUnavailable = messages && this.state.targetMessageId !== null
      && !messages.items.some((message) => message.messageId === this.state.targetMessageId);
    const clearMessageDirection = targetUnavailable && this.directionDerived && this.state.mode === 'reply_to_message';
    if (clearMessageDirection) this.directionDerived = false;
    this.candidateSourceCheck = undefined;
    check.pending.abort();
    this.publish({ savedSession: { phase: 'ready', sessionId: saved.sessionId, turns, inputs,
      currentInputVersionId: saved.currentInputVersionId },
      ...(messages ? { messages, ...(targetUnavailable ? { targetMessageId: null } : {}) } : {}),
      ...(clearMessageDirection ? { direction: '', purpose: '' } : {}),
      sourceAvailability: this.heldResult ? this.sourceCheck ? 'checking' : 'failed' : undefined });
    return { ...saved, turns, inputs };
  }
  private clearUnavailableCandidateSource(scope: ContactSelection & { sessionId: string }, candidateIds?: string[],
    invalidInputs: Set<string> = new Set(), strategyTargetUnavailable = false): void {
    const affected = candidateIds ? new Set(candidateIds) : null;
    const saved = this.state.savedSession;
    const turns = saved?.turns.filter((turn) => !affected
      || turn.reply?.candidates.some((candidate) => affected.has(candidate.candidateId))) ?? [];
    const turnIds = new Set(turns.map((turn) => turn.turnId));
    const inputIds = new Set([...invalidInputs, ...turns.map((turn) => turn.inputVersionId)]);
    const requestIds = new Set(turns.flatMap((turn) => turn.reply ? [turn.reply.replyRequestId] : []));
    for (const turn of turns) for (const candidate of turn.reply?.candidates ?? []) affected?.add(candidate.candidateId);
    const matches = (result: ReplySessionState['result'] | undefined) => Boolean(result
      && result.assistantSessionId === scope.sessionId && (!affected || requestIds.has(result.replyRequestId)
        || (result.inputVersionId && inputIds.has(result.inputVersionId))
        || result.candidates.some((candidate) => affected.has(candidate.original.candidateId))));
    const clearResult = matches(this.state.result), clearHeld = matches(this.heldResult?.result);
    const clearExploration = this.currentExploration && (!affected || inputIds.has(this.currentExploration.inputVersion));
    const jobInputId = this.strategyJob?.actualInputVersionId
      ?? (this.strategyJob?.type === 'action' ? this.strategyJob.request.inputVersion : undefined);
    const clearStrategy = this.strategyJob?.request.sessionId === scope.sessionId
      && (!affected || clearResult || clearHeld || clearExploration || strategyTargetUnavailable
        || (jobInputId && inputIds.has(jobInputId)));
    const clearDerived = this.directionDerived && (!affected || clearResult || clearHeld || clearExploration || clearStrategy);
    if (!affected || clearResult || clearHeld) {
      const result = clearResult ? this.state.result : this.heldResult?.result;
      if (result?.inputVersionId) inputIds.add(result.inputVersionId);
      for (const candidate of result?.candidates ?? []) affected?.add(candidate.original.candidateId);
      this.notifyInputChanged(); this.cancelPending(); this.lastAttempt = undefined;
    } else if (this.lastAttempt && turns.some((turn) => turn.requestKey === this.lastAttempt?.requestKey)) {
      this.lastAttempt = undefined;
    }
    if (!affected || clearExploration || clearStrategy) {
      this.explorationOperation += 1; this.explorationPending?.abort(); this.explorationPending = undefined;
      this.currentExploration = undefined; this.explorationPurpose = undefined;
      this.generationSkillChoice = undefined; this.strategyJob = undefined;
      this.publish({ exploration: { phase: 'idle', result: null } });
    }
    this.candidateVersions.invalidate(scope, affected ? [...affected] : undefined);
    const placeholder = '相关来源不可用';
    this.publish({ ...(!affected ? { messages: { phase: 'idle' as const, items: [], nextCursor: null }, targetMessageId: null } : {}),
      ...(clearDerived ? { direction: '', purpose: '' } : {}),
      ...(saved ? { savedSession: { ...saved,
      turns: saved.turns.map((turn) => turnIds.has(turn.turnId)
        ? { ...turn, state: 'unavailable', input: null, reply: null, placeholder } : turn),
      inputs: saved.inputs.map((input) => !affected || inputIds.has(input.inputVersionId)
        ? input.state === 'active' ? { ...input, state: 'unavailable', content: null, placeholder } : input : input),
      currentInputVersionId: saved.currentInputVersionId && inputIds.has(saved.currentInputVersionId)
        ? null : saved.currentInputVersionId } } : {}),
      ...(clearResult ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false, errorCode: undefined } : {}) });
    if (clearDerived) this.directionDerived = false;
  }
  private async restoreCandidateVersions(selection: ContactSelection, sessionId: string, candidateIds: string[], complete = false): Promise<void> {
    const operation = ++this.candidateRestoreOperation;
    const generation = this.backend.getConnectionGeneration();
    const current = () => operation === this.candidateRestoreOperation
      && generation !== undefined && generation === this.backend.getConnectionGeneration()
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && sessionId === this.state.savedSession?.sessionId && this.state.sessionDeletion !== 'deleting';
    if (!current()) return;
    this.candidateVersions.setScope({ ...selection, sessionId });
    if (complete) {
      try { await this.candidateVersions.reconcile({ ...selection, sessionId }, candidateIds, current); }
      catch (error) { await this.handleCandidateSourceUnavailable(error); return; }
    }
    for (const candidateId of new Set(candidateIds)) {
      if (!current()) return;
      try { await this.candidateVersions.read({ ...selection, sessionId, candidateId }, current); }
      catch (error) { await this.handleCandidateSourceUnavailable(error); }
    }
  }
  private assertCandidate(selection: ReplyCandidateSelection) {
    if (this.pendingExpressionPreferenceDeletions > 0 || this.retainedSourceValidation?.checking) {
      throw new Error('请等待删除后的来源核验完成。');
    }
    this.assertScope(selection);
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    const result = this.state.result;
    const candidate = result?.candidates.find((item) => item.original.candidateId === selection.candidateId);
    if (!candidate || result?.replyRequestId !== selection.replyRequestId) throw new Error('候选已失效，请重新生成。');
    return candidate;
  }
  private assertScope(selection: ContactSelection): ContactSessionState {
    const state = this.contacts.getState();
    if (this.backend.getConnectionGeneration() === undefined || selection.scopeRevision !== state.scopeRevision
      || selection.contactId !== state.selectedContactId || !['ready', 'loading'].includes(state.directoryPhase)) {
      throw new Error('本次联系人已变化，请重新确认。');
    }
    return state;
  }
  private assertSessionSelection(): void {
    if (this.pendingExpressionPreferenceDeletions > 0 || this.retainedSourceValidation?.checking) {
      throw new Error('请等待删除后的来源核验完成。');
    }
    if (this.pendingContent) throw new Error('请等待联系人内容恢复完成，失败时请重新读取讨论。');
    if (this.state.sessionDeletion === 'deleting' || this.state.sessionDeletion === 'failed') {
      throw new Error('请先核对当前助手会话的删除结果。');
    }
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    if (this.catalogPending || this.state.sessionCatalog?.selectionPending) {
      throw new Error('请刷新会话列表并明确选择本次助手会话。');
    }
  }
  private receiveContact(state: ContactSessionState): void {
    if (state.directoryPhase === 'ready') {
      for (const [key, retry] of this.retainedRetries) if (!state.contacts.some((contact) => contact.contactId === retry.contactId)) this.retainedRetries.delete(key);
      for (const [key, notice] of this.retainedNotices) if (!state.contacts.some((contact) => contact.contactId === notice.contactId)) this.retainedNotices.delete(key);
      const generation = this.backend.getConnectionGeneration();
      if (generation !== undefined) for (const job of this.generationJobs.states(generation)) {
        if (!state.contacts.some((contact) => contact.contactId === job.contactId)) this.generationJobs.forget({
          connectionGeneration: generation, contactId: job.contactId, sessionId: job.sessionId });
      }
      for (const id of this.retainedContent.keys()) {
        if (!state.contacts.some((contact) => contact.contactId === id)) this.retainedContent.delete(id);
      }
    } else if (!['ready', 'loading'].includes(state.directoryPhase)) this.retainedContent.clear();
    if (state.scopeRevision !== this.state.scopeRevision || state.selectedContactId !== this.state.contactId) {
      const generation = this.backend.getConnectionGeneration();
      if (generation !== undefined && generation === this.contentGeneration && this.state.contactId
        && state.contacts.some((contact) => contact.contactId === this.state.contactId)) {
        const content = this.pendingContent ?? retainContactContent(this.getState(), this.directionDerived, this.draft);
        if (content) this.retainedContent.set(this.state.contactId, content);
      }
      this.contentGeneration = generation; this.retainedSourceValidation = undefined;
      this.pendingContent = state.selectedContactId ? this.retainedContent.get(state.selectedContactId) : undefined;
      if (generation !== undefined && this.state.contactId && !state.contacts.some((contact) => contact.contactId === this.state.contactId)) {
        this.generationJobs.cancelContact(generation, this.state.contactId);
      }
      this.candidateSourceCheck?.pending.abort();
      this.candidateVersions.setScope(null);
      this.sessionDelete?.abort(); this.sessionDelete = undefined;
      this.catalogPending?.abort(); this.catalogPending = undefined;
      this.savedRead?.abort(); this.savedRead = undefined;
      this.noticeStream?.abort(); this.noticeVerification?.abort();
      this.noticeStream = undefined; this.noticeVerification = undefined;
      this.leaveGenerationView();
      this.cancelMessagePage();
      this.invalidateExploration();
      this.directionDerived = false;
      this.lastAttempt = undefined;
      this.draft = state.draft;
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.selectedContactId, candidateDrafts: [], contentRestoreNotice: undefined,
        options: defaults(), mode: 'rewrite_draft', scene: '', messages: { phase: 'idle', items: [], nextCursor: null },
        messageNotice: { phase: 'idle', changed: false, needsRefresh: false },
        targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '', skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], exploration: { phase: 'idle', result: null },
        phase: 'idle', errorCode: undefined, result: null, selectedCandidateId: null, canRetry: false,
        savedSession: { phase: 'idle', sessionId: null, turns: [], inputs: [], currentInputVersionId: null }, sessionDeletion: undefined,
        sessionCatalog: undefined,
        confirmedSessionDeletion: undefined });
      this.candidateSourceCheck = undefined;
      this.beginMessageNotice();
      // 同连接恢复前先核验原会话；新连接没有输入缓存，不触发生成。
      if (state.selectedContactId && state.directoryPhase === 'ready') {
        void this.readSavedSession({ contactId: state.selectedContactId, scopeRevision: state.scopeRevision });
      }
    } else if (state.draft !== this.draft) {
      this.draft = state.draft;
      if (this.pendingContent && this.state.contactId) this.retainedContent.delete(this.state.contactId);
      this.pendingContent = undefined;
      this.leaveGenerationView();
      this.lastAttempt = undefined;
      this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
    }
  }
  async reconnectMessages(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.state.messageNotice.phase !== 'interrupted') return;
    this.noticeStream?.abort(); this.noticeVerification?.abort();
    this.beginMessageNotice(true);
  }
  async combineNewMessages(selection: ContactSelection): Promise<void> {
    const contacts = this.assertScope(selection); this.assertSessionSelection(); this.refreshGenerationEligibility();
    const notice = this.noticedMessage;
    const generation = this.backend.getConnectionGeneration();
    const sessionId = this.state.savedSession?.sessionId;
    const mode = this.state.mode;
    const operation = this.operation;
    if (!notice || generation === undefined || notice.generation !== generation
      || notice.contactId !== selection.contactId || notice.scopeRevision !== selection.scopeRevision
      || notice.sessionId !== sessionId || !this.state.messageNotice.changed
      || this.state.generationBlock || mode === 'rewrite_draft') throw new Error('请先核对当前联系人与新消息提醒。');
    const receipt = this.generationJobs.requestReceipt({ connectionGeneration: generation, contactId: selection.contactId, sessionId });
    if (this.state.phase === 'waiting' && !receipt) throw new Error('请等实际生成身份确认后再结合新消息。');
    const expected = receipt?.inputVersionId ?? this.state.savedSession?.currentInputVersionId;
    if (!expected) throw new Error('请先重新读取当前已保存讨论。');
    const pending = new AbortController();
    const current = () => notice === this.noticedMessage && operation === this.operation
      && generation === this.backend.getConnectionGeneration() && selection.contactId === this.state.contactId
      && selection.scopeRevision === this.state.scopeRevision && sessionId === this.state.savedSession?.sessionId
      && mode === this.state.mode && !this.candidateSourceCheck && !this.state.sessionCatalog?.selectionPending;
    const saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
    if (!current() || saved.generation !== generation) throw new Error('新消息或原生成范围已变化。');
    if (saved.currentInputVersionId !== expected || !saved.inputs.some((input) => input.inputVersionId === expected && input.state === 'active')) {
      await this.readSavedSession(selection);
      throw new Error('原生成输入或来源已失效，请重新核对讨论。');
    }
    const page = await readReplyMessages(this.backend, selection.contactId, null, pending.signal);
    const target = page.messages.find((message) => message.messageId === notice.messageId);
    if (!current() || saved.generation !== generation || page.generation !== generation || !target
      || saved.currentInputVersionId !== expected || !saved.inputs.some((input) => input.inputVersionId === expected && input.state === 'active')) {
      throw new Error('新消息或原生成输入已变化，请重新读取讨论。');
    }
    const contact = contacts.contacts.find((item) => item.contactId === selection.contactId)!;
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName,
      correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(),
      clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) }, ...sceneSnapshot(this.state.scene || null) };
    const input: ReplyInputSnapshot = mode === 'reply_to_message'
      ? { ...common, mode, target, direction: this.state.direction.trim() }
      : { ...common, mode, purpose: this.state.purpose.trim() };
    if (input.mode === 'reply_to_message' ? !input.direction : !input.purpose) throw new Error('请明确本次方向或目的。');
    const originalInput = saved.turns.find((turn) => turn.inputVersionId === expected)?.input;
    const originalContent = originalInput?.content;
    const adoptNewMessageId = originalContent?.type === mode
      && (originalContent.user_instruction ?? '') === common.userInstruction
      && (originalInput?.scene ?? null) === (common.scene ?? null) ? notice.messageId : undefined;
    const previousReplyRequestId = this.state.result?.replyRequestId;
    this.invalidateExploration(); this.notifyInputChanged();
    this.publish({ messages: { phase: 'ready', items: page.messages, nextCursor: page.nextCursor },
      ...(mode === 'reply_to_message' ? { targetMessageId: target.messageId } : {}) });
    const generating = this.generateInput({ ...selection, newRequest: true }, input, receipt, expected,
      undefined, adoptNewMessageId);
    const generationOperation = this.operation;
    await generating;
    const result = this.state.result;
    if (notice === this.noticedMessage && generation === this.backend.getConnectionGeneration()
      && generationOperation === this.operation && selection.contactId === this.state.contactId
      && selection.scopeRevision === this.state.scopeRevision && mode === this.state.mode
      && sessionId === this.state.savedSession?.sessionId && result?.assistantSessionId === sessionId
      && result.replyRequestId !== previousReplyRequestId && result.inputVersionId !== expected
      && result.input.mode === mode && result.input.contactId === selection.contactId
      && (result.input.scene ?? null) === (common.scene ?? null)
      && result.input.userInstruction === common.userInstruction
      && (result.input.mode === 'reply_to_message' ? result.input.target.messageId === target.messageId
        : result.input.mode === 'initiate_conversation' && input.mode === 'initiate_conversation'
          && result.input.purpose === input.purpose)
      && this.state.phase === 'ready') {
      this.noticedMessage = undefined;
      this.retainedNotices.delete(`${selection.contactId}:${sessionId}`);
      this.publish({ messageNotice: { ...this.state.messageNotice, changed: false } });
    }
  }
  private retainMessageNotice(contactId: string, sessionId: string, messageId: string): void {
    const key = `${contactId}:${sessionId}`;
    this.retainedNotices.delete(key); this.retainedNotices.set(key, { contactId, sessionId, messageId });
    while (this.retainedNotices.size > 32) this.retainedNotices.delete(this.retainedNotices.keys().next().value!);
  }
  private async restoreMessageNotice(selection: ContactSelection, sessionId: string, signal: AbortSignal,
    current: () => boolean): Promise<void> {
    const key = `${selection.contactId}:${sessionId}`, notice = this.retainedNotices.get(key);
    if (!notice) return;
    const page = await readReplyMessages(this.backend, selection.contactId, null, signal);
    if (!current() || this.retainedNotices.get(key) !== notice || sessionId !== this.state.savedSession?.sessionId
      || page.generation !== this.backend.getConnectionGeneration()) return;
    if (!page.messages.some((message) => message.messageId === notice.messageId)) {
      this.retainedNotices.delete(key); return;
    }
    this.noticedMessage = { ...notice, generation: page.generation, scopeRevision: selection.scopeRevision, revision: ++this.noticeRevision };
    this.publish({ messageNotice: { ...this.state.messageNotice, changed: true } });
  }
  private beginMessageNotice(recovered = false): void {
    const contactId = this.state.contactId;
    const scopeRevision = this.state.scopeRevision;
    const generation = this.backend.getConnectionGeneration();
    if (!contactId || generation === undefined) return;
    const pending = new AbortController();
    this.noticeStream = pending;
    const current = () => !pending.signal.aborted && contactId === this.state.contactId
      && scopeRevision === this.state.scopeRevision && generation === this.backend.getConnectionGeneration();
    this.publish({ messageNotice: { phase: 'connecting', changed: recovered && this.state.messageNotice.changed,
      needsRefresh: recovered } });
    this.backend.subscribeMessages({
      connected: () => { if (current()) this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'connected' } }); },
      interrupted: () => { if (current()) {
        this.noticeVerification?.abort();
        if (this.automaticExploration) this.stopAutomaticExploration(true);
        this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'interrupted' } });
      } },
      message: (event) => {
        if (!current()) return;
        if (event.contactId !== contactId) {
          const sessions = new Set(this.generationJobs.states(generation)
            .filter((job) => job.contactId === event.contactId).map((job) => job.sessionId));
          const retained = this.retainedContent.get(event.contactId)?.sessionId;
          if (retained) sessions.add(retained);
          for (const session of sessions) this.retainMessageNotice(event.contactId, session, event.messageId);
          return;
        }
        const sessionId = this.state.savedSession?.sessionId;
        const revision = ++this.noticeRevision;
        this.noticeVerification?.abort();
        const verification = new AbortController();
        this.noticeVerification = verification;
        // 事件只含标识；用当前认证联系人真实的有界消息投影确认归属，不猜缺失范围。
        void readReplyMessages(this.backend, contactId, null, verification.signal).then((page) => {
          if (!current() || verification.signal.aborted || revision !== this.noticeRevision || page.generation !== generation
            || sessionId !== this.state.savedSession?.sessionId) return;
          if (page.messages.some((message) => message.messageId === event.messageId)) {
            if (sessionId) this.retainMessageNotice(contactId, sessionId, event.messageId);
            this.noticedMessage = sessionId ? { generation, contactId, scopeRevision, sessionId,
              messageId: event.messageId, revision } : undefined;
            this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'connected', changed: true } });
            this.queueAutomaticExploration();
          }
        }).catch(() => {
          if (current() && !verification.signal.aborted) {
            if (this.automaticExploration) this.stopAutomaticExploration(true);
            this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'interrupted' } });
          }
        }).finally(() => { if (this.noticeVerification === verification) this.noticeVerification = undefined; });
      },
    }, pending.signal);
  }
  private clearAutomaticExplorationTimer(): void {
    if (this.automaticExplorationTimer) clearTimeout(this.automaticExplorationTimer);
    this.automaticExplorationTimer = undefined;
  }
  private stopAutomaticExploration(paused = false): void {
    const inFlight = this.state.exploration.phase === 'waiting'
      && this.strategyJob?.type === 'open' && this.strategyJob.request.automatic;
    this.clearAutomaticExplorationTimer(); this.automaticExploration = undefined;
    if (inFlight) {
      ++this.explorationOperation;
      this.explorationPending?.abort(); this.explorationPending = undefined;
      this.strategyJob = undefined; this.currentExploration = undefined; this.explorationPurpose = undefined;
      this.publish({ exploration: { phase: 'failed', result: null, canRetry: false, automaticUpdatesPaused: true } });
    } else if (paused) this.publish({ exploration: { ...this.state.exploration, automaticUpdatesPaused: true } });
  }
  private queueAutomaticExploration(): void {
    const task = this.automaticExploration, result = this.currentExploration;
    if (!task || result?.confirmedIntent || this.state.mode === 'rewrite_draft'
      || task.contactId !== this.state.contactId || task.scopeRevision !== this.state.scopeRevision
      || task.generation !== this.backend.getConnectionGeneration() || result && task.sessionId !== result.sessionId
      || this.state.sessionDeletion === 'deleting' || this.state.sessionDeletion === 'failed'
      || this.state.generationBlock || this.catalogPending
      || this.state.sessionCatalog?.selectionPending) return;
    task.queued = true;
    if (this.state.exploration.phase === 'waiting') return;
    if (task.remaining <= 0 || Date.now() >= task.expiresAt) { this.stopAutomaticExploration(true); return; }
    if (!result || this.state.exploration.phase !== 'ready' || this.automaticExplorationTimer) return;
    this.automaticExplorationTimer = setTimeout(() => {
      this.automaticExplorationTimer = undefined;
      if (this.automaticExploration !== task || this.currentExploration !== result) return;
      task.queued = false; --task.remaining;
      // 唯一后端探索存储仍复验实际 CURRENT、来源、Skill 和根预算；失败不自动重试。
      void this.explore({ contactId: task.contactId, scopeRevision: task.scopeRevision }, false, true)
        .catch(() => { if (this.automaticExploration === task) this.stopAutomaticExploration(true); });
    }, 150);
  }
  private invalidateInput(preserveExploration = false): void {
    this.leaveGenerationView();
    this.invalidateExploration(preserveExploration);
    this.notifyInputChanged();
    this.lastAttempt = undefined;
    this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
  }
  private invalidateExploration(preserve = false): void {
    this.stopAutomaticExploration();
    this.strategyJob = undefined;
    if (!preserve) { this.currentExploration = undefined; this.explorationPurpose = undefined; this.generationSkillChoice = undefined; }
    ++this.explorationOperation;
    this.explorationPending?.abort(); this.explorationPending = undefined;
    this.publish({ exploration: { phase: 'idle', result: null }, clarificationAnswer: '' });
  }
  private notifyInputChanged(preserveAutomatic = false): void {
    if (this.pendingContent && this.state.contactId) this.retainedContent.delete(this.state.contactId);
    this.pendingContent = undefined;
    this.restoredRetry = undefined;
    if (!preserveAutomatic) this.stopAutomaticExploration();
    this.continuationAttempt = undefined;
    if (this.state.continuation) this.publish({ continuation: undefined });
    for (const listener of this.inputListeners) listener();
  }
  private cancelMessagePage(): void { ++this.messageOperation; this.messagePending?.abort(); this.messagePending = undefined; }
  private leaveGenerationView(): void {
    this.generationJobs.leaveView(); ++this.operation; this.pending = undefined;
    this.continuationAttempt = undefined;
    if (this.state.continuation) this.publish({ continuation: undefined });
    // 明确确认/已确认回答已送出；离开视图仍接收真实准备回执，交由同一作业继续或退出中断。
    if (this.explorationPending === this.strategyCandidatePending) this.explorationPending = undefined;
    this.sourceCheck?.abort(); this.sourceCheck = undefined; this.heldResult = undefined;
    if (this.state.sourceAvailability) this.publish({ sourceAvailability: undefined });
  }
  private cancelPending(preserveSourceValidation = false): void {
    ++this.operation; this.pending?.abort(); this.pending = undefined;
    this.continuationAttempt = undefined;
    if (this.state.continuation) this.publish({ continuation: undefined });
    if (this.state.inputBudgetNotice) this.publish({ inputBudgetNotice: undefined });
    if (preserveSourceValidation) return;
    this.sourceCheck?.abort(); this.sourceCheck = undefined; this.heldResult = undefined;
    if (this.state.sourceAvailability) this.publish({ sourceAvailability: undefined });
  }
  private publish(update: Partial<ReplySessionState>): void {
    const state = { ...this.state, ...update, revision: this.state.revision + 1 };
    if (update.savedSession && update.savedSession.sessionId !== this.state.savedSession?.sessionId) {
      this.noticedMessage = undefined; this.noticeVerification?.abort(); this.noticeVerification = undefined;
      state.messageNotice = { ...state.messageNotice, changed: false };
    }
    if (this.state.inputBudgetNotice && !state.inputBudgetNotice
      && (state.errorCode === 'input_budget_exceeded' || state.errorCode === 'input_budget_unavailable')) {
      this.lastAttempt = undefined;
      state.errorCode = undefined; state.canRetry = false;
      if (state.phase === 'failed') state.phase = state.result ? 'ready' : 'idle';
    }
    if (update.savedSession && update.savedSession.sessionId !== this.state.savedSession?.sessionId) state.candidateDrafts = [];
    if (update.savedSession?.phase === 'ready') {
      const valid = new Set(update.savedSession.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []));
      state.candidateDrafts = state.candidateDrafts?.filter((draft) => valid.has(draft.candidateId));
    }
    this.state = state;
    for (const listener of this.listeners) listener(this.getState());
  }
}
