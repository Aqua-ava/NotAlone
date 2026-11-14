import {invalidatedSqliteDiscussion} from './sqlite-discussion-read';
import type { ReplyStateUpdate } from '../../shared/reply-bridge';
import { ordinaryGeneration, type OrdinaryFailureObservation, type OrdinaryGenerationResult } from './assistant-generation-adapters';
import { randomUUID } from 'node:crypto';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { AssistantGenerationStop, AssistantSessionDeletion, GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyCorrectionUpdate, ReplyDirectionUpdate, ReplyGenerationBlock, ReplyInputSnapshot, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, ReplySessionState, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { isUuid } from '../uuid';
import type { ContactSession } from '../contacts/session';
import { captureAssistantGenerationStopping } from './assistant-generation-interruption';
import { interruptedReplyInput, savedReplySkillChoice } from './assistant-interrupted-retry';
import { isRetiredMessageExclusionError } from './pasted-input';
import { checkPreparationFormat } from './preparation-format';
import { newAssistantSessionWithCandidate } from './assistant-candidate-carry';
import type { AssistantCandidateCarry } from '../../shared/reply-bridge';
import { matchesReplyAdoption, type InterruptedReplyOrigin } from './client';
import type { ReplyRequirementsUpdate, ReplySkillUpdate } from '../../shared/reply-bridge';
import { mergeReplyMessages, readReplyMessages } from './messages';
import { readReplyEvidence } from './evidence-read';
import { fitsReplyTextLimit, replyFailureDecision, replyTextLimit } from '../../shared/reply-contract';
import { currentAssistantSession, defaultAssistantSession, deleteAssistantSession, readAssistantSession } from './assistant-sessions';
import { listAssistantSessions, newAssistantSession, selectAssistantSession } from './assistant-session-catalog';
import type { AssistantInterruptedRetry, AssistantSessionSelection } from '../../shared/reply-bridge';
import type { ReplyCandidateDraftUpdate, ReplyCandidateVersionDisplay, ReplyCandidateVersionEdit, ReplyCandidateVersionRead, ReplyCandidateVersionSelection } from '../../shared/assistant-candidate-versions';
import { AssistantCandidateSourceUnavailable, AssistantCandidateVersionSession } from './assistant-candidate-versions';
import { AssistantGenerationJobs, type AssistantGenerationReceipt, type AssistantGenerationRecovery, type OwnedAssistantGeneration, type PendingAssistantGenerationReceipt } from './assistant-generation-jobs';
import { invalidatedIntent, type DerivedIntent, invalidatedSupplement, retainContactContent, restoredWorkspaceRequirementVersion, validateContactInput, removeDependentContent, revalidateRetainedContent, type RetainedContactContent } from './contact-content';
import { readReplyScene, sceneSnapshot } from './scene';
import { AssistantSessionProjection, type AssistantProjectionRead, type AssistantProjectionScope, type AssistantProjectionVerification } from './assistant-session-projection';
import { AssistantMessageNotices, type MessageNoticeAdoption } from './assistant-message-notices';

const defaults = () => ({ includeRelationshipContext: false });

type CandidateSourceCheck = {
  pending: AbortController;
  scope: ContactSelection & { sessionId: string };
  turns: { turnId: string; candidateIds: string[] }[];
  inputIds: string[];
  refreshMessages: boolean;
  confirmedCandidateIds: string[];
};
type MessageAdoptionCommand = Readonly<{ notice: MessageNoticeAdoption; messageId?: string }>;

// 助手讨论和原候选由后端保存；当前编辑稿与窗口状态分别处理。
export class ReplySession {
  hasEdits(): boolean {
    return Boolean(this.state.result || this.heldResult || this.state.phase === 'waiting' || this.state.targetMessageId
      || this.state.direction || this.state.purpose || this.state.mode !== 'rewrite_draft' || this.state.options.includeRelationshipContext || this.state.scene
      || this.state.options.contextText);
  }
  private state: ReplySessionState = { revision: 0, scopeRevision: 0, contactId: null, generationBlock: null,
    options: defaults(), workspaceMigrationNotice: undefined, mode: 'rewrite_draft', scene: '', messages: { phase: 'idle', items: [], nextCursor: null },
    messageNotice: { phase: 'idle', changed: false, needsRefresh: false },
    targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '', skillChoice: { mode: 'auto', versionId: null }, skillChoices: [],
    phase: 'idle', result: null, selectedCandidateId: null, canRetry: false };
  // 只关联未被用户改写要求的权威输入版本，完整累计正文仍由后端回读。
  private workspaceRequirementInputVersion: string | undefined;
  private derivedIntent: DerivedIntent = { direction: false, purpose: false };
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
  private lastAttempt: { input: ReplyInputSnapshot; requestKey: string; expectedInputVersionId?: string;
    interrupted?: InterruptedReplyOrigin; adoptNewMessageId?: string; messageNotice?: MessageNoticeAdoption } | undefined;
  private messageOperation = 0;
  private messagePending: AbortController | undefined;
  private automaticMessageRevision = 0;
  private readonly messageNotices: AssistantMessageNotices;
  private savedRead: AbortController | undefined;
  private contactRestoreTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sessionProjection = new AssistantSessionProjection();
  private sessionDelete: AbortController | undefined;
  private catalogPending: AbortController | undefined;
  private catalogMutation: AbortController | undefined;
  private candidateRestoreOperation = 0;
  private candidateSourceCheck: CandidateSourceCheck | undefined;
  private readonly candidateVersions: AssistantCandidateVersionSession;
  private readonly listeners = new Map<(state: ReplySessionState) => void, readonly (keyof ReplySessionState)[] | undefined>();
  private readonly updateListeners = new Set<(update: ReplyStateUpdate) => void>();
  private publishedState: ReplySessionState | undefined;
  private readonly sessionDeletionListeners = new Set<(phase: 'started' | 'settled') => void>();
  private readonly inputListeners = new Set<() => void>();
  private readonly retainedContent = new Map<string, RetainedContactContent>();
  private contentGeneration: number | undefined;
  private pendingContent: RetainedContactContent | undefined;
  private retainedSourceValidation: { checking: boolean } | undefined;
  private pendingExpressionPreferenceDeletions = 0;
  private pendingOwnerContextChanges = 0;

  constructor(private readonly contacts: ContactSession, private readonly backend: BackendHost,
    private readonly generationBlock: () => ReplyGenerationBlock = () => null) {
    this.messageNotices = new AssistantMessageNotices(backend, (contactId, generation) => {
      const sessions = new Set(this.generationJobs.states(generation)
        .filter((job) => job.contactId === contactId).map((job) => job.sessionId));
      const retained = this.retainedContent.get(contactId)?.sessionId;
      if (retained) sessions.add(retained);
      return [...sessions];
    }, (messageNotice, page) => {
      const messages = page ? this.acceptAutomaticMessagePage(page) : undefined;
      this.publish({ messageNotice, ...(messages ? { messages } : {}) });
    });
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
        this.workspaceRequirementInputVersion = undefined;
        this.cancelContactRestore();
        this.retainedContent.clear(); this.retainedRetries.clear(); this.restoredRetry = undefined; this.pendingContent = undefined; this.retainedSourceValidation = undefined; this.contentGeneration = undefined;
        this.publish({ ...(this.state.savedSession?.discussionEntries === undefined ? {} : {savedSession:{...this.state.savedSession,phase:'idle' as const,...invalidatedSqliteDiscussion(this.state.savedSession)}}), inputBudgetNotice: undefined, scene: '', inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 });
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
    return structuredClone(this.projectState());
  }
  private projectState(): ReplySessionState {
    const state = { ...this.state };
    state.generationJobs = this.generationJobs.states(this.backend.getConnectionGeneration());
    state.generationRecoveryPending = this.generationJobs.recoveryPending(this.backend.getConnectionGeneration());
    state.candidateDrafts = state.sourceAvailability || state.savedSession?.phase !== 'ready' ? []
      : state.candidateDrafts?.filter((draft) => state.candidateVersions?.items.some((view) => view.phase === 'ready'
        && view.candidateId === draft.candidateId && view.history?.versions.some((version) => version.versionId === draft.versionId)));
    if (state.candidateDrafts?.length === this.state.candidateDrafts?.length) state.candidateDrafts = this.state.candidateDrafts;
    const notice = state.inputBudgetNotice;
    if (notice && (notice.contactId !== state.contactId || notice.scopeRevision !== state.scopeRevision
      || notice.sessionId !== state.savedSession?.sessionId || notice.operation !== this.operation
      || notice.connectionGeneration !== this.backend.getConnectionGeneration())) state.inputBudgetNotice = undefined;
    if (!this.candidateSourceCheck && !this.pendingContent && !this.retainedSourceValidation?.checking
      && this.pendingExpressionPreferenceDeletions === 0 && this.pendingOwnerContextChanges === 0) return state;
    // 完整来源复验期间只隔离现有视图，不另存可恢复正文。
    return { ...state, candidateDrafts: [], inputBudgetNotice: undefined, result: null, selectedCandidateId: null, canRetry: false,
      messages: { phase: 'loading', items: [], nextCursor: null }, targetMessageId: null,
      ...invalidatedIntent(this.derivedIntent),
      savedSession: state.savedSession ? { ...state.savedSession, ...invalidatedSqliteDiscussion(state.savedSession),
        phase: state.savedSession.phase === 'failed' ? 'failed' : 'loading', turns: [], inputs: [], currentInputVersionId: null } : undefined,
      candidateVersions: state.candidateVersions ? { ...state.candidateVersions, phase: 'loading',
        items: state.candidateVersions.items.map((item) => ({ ...item, phase: 'loading', history: null, displayVersionId: null })) } : undefined,
      explicitCandidateSelection: { phase: 'loading', selection: null } };
  }
  refreshGenerationEligibility(): void {
    const generationBlock = this.generationBlock();
    if (generationBlock === this.state.generationBlock) return;
    const revokedRead = generationBlock !== null && this.savedRead !== undefined;
    if (revokedRead) this.cancelSavedRead();
    this.publish({ generationBlock,
      ...(revokedRead && this.state.savedSession?.phase === 'loading'
        ? { savedSession: { ...this.state.savedSession, phase: 'failed' as const } } : {}) });
    // 同一联系人重新确认不会改变范围修订；旧的未授权读取需要按新资格重读。
    if (generationBlock === null && this.state.contactId && this.state.savedSession?.phase !== 'ready'
      && this.contactRestoreTimer === undefined) {
      void this.readSavedSession({ contactId: this.state.contactId, scopeRevision: this.state.scopeRevision });
    }
  }
  onStateChanged(listener: (state: ReplySessionState) => void, fields?: readonly (keyof ReplySessionState)[]): () => void {
    this.listeners.set(listener, fields);
    return () => this.listeners.delete(listener);
  }
  onStateUpdated(listener: (update: ReplyStateUpdate) => void): () => void {
    this.publishedState ??= this.projectState();
    this.updateListeners.add(listener);
    return () => { this.updateListeners.delete(listener); };
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
      this.helperHidden = true; this.leaveGenerationView();
      this.lastAttempt = undefined;
      this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false, errorCode: undefined });
    } else if (event === 'focused' && this.helperHidden) {
      this.helperHidden = false;
      if (this.state.contactId) void this.readSavedSession(
        { contactId: this.state.contactId, scopeRevision: this.state.scopeRevision }, true);
    }
  }
  pendingGenerationReceipts(): PendingAssistantGenerationReceipt[] { return this.generationJobs.pendingReceipts(); }
  async prepareGenerationConnectionChange(): Promise<void> {
    this.workspaceRequirementInputVersion = undefined;
    const settling = this.generationJobs.prepareConnectionChange();
    this.leaveGenerationView();
    await settling;
  }

  // 退出调用方接收实际标识后走17的中断协议；hide/close不调用本接口。
  beginGenerationClosing(onReceipt: (receipt: PendingAssistantGenerationReceipt) => void | Promise<void>,
    recoverUnknown?: AssistantGenerationRecovery): Promise<void> {
    const closing = this.generationJobs.beginClosing(onReceipt, recoverUnknown); this.leaveGenerationView(); return closing;
  }

  private showIdleRollover(receipt: AssistantGenerationReceipt, sessionId: string, selection: ContactSelection,
    operation: number, generation: number | undefined, pending: AbortController): boolean {
    if (receipt.previousSessionId && receipt.sessionId !== sessionId
      && operation === this.operation && generation === this.backend.getConnectionGeneration()
      && !pending.signal.aborted && !this.state.sessionCatalog?.selectionPending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && (this.state.savedSession?.sessionId ?? sessionId) === sessionId) {
      this.savedRead?.abort(); this.savedRead = undefined;
      this.candidateVersions.setScope(null);
      const items = (this.state.sessionCatalog?.items ?? []).map(item => ({ ...item, isCurrent: item.sessionId === receipt.sessionId }));
      if (!items.some(item => item.sessionId === receipt.sessionId)) items.push({ sessionId: receipt.sessionId, isCurrent: true });
      this.publish({ savedSession: { phase: 'idle', sessionId: receipt.sessionId, turns: [], inputs: [], currentInputVersionId: receipt.inputVersionId },
        sessionCatalog: { phase: 'ready', items, currentSessionId: receipt.sessionId },
        idleRollover: { sessionId: receipt.sessionId, previousSessionId: receipt.previousSessionId },
        result: null, selectedCandidateId: null, candidateDrafts: [], sessionDeletion: undefined }, 'authoritative');
    }
    return this.state.savedSession?.sessionId === receipt.sessionId;
  }
  private async restoreGenerationView(selection: ContactSelection,
    saved: Awaited<ReturnType<typeof readAssistantSession>>, signal: AbortSignal, current: () => boolean): Promise<void> {
    const turn = saved.turns.find((item) => item.inputVersionId === saved.currentInputVersionId);
    const job = this.generationJobs.states(saved.generation).find((item) => item.contactId === selection.contactId
      && item.sessionId === saved.sessionId && item.turnId === turn?.turnId && item.requestKey === turn?.requestKey);
    if (turn?.requiresReprepare && turn.input) {
      this.publish({ phase: 'failed', canRetry: false,
        errorCode: turn.generationActive === true ? 'prepared_context_running'
          : turn.generationActive === false ? 'prepared_context_reprepare_required' : 'prepared_context_unconfirmed' });
      return;
    }
    if (!turn || !job || !turn.input || !saved.inputs.some((item) => item.inputVersionId === turn.inputVersionId && item.state === 'active')) return;
    const retry = turn.state === 'failed' && job.phase === 'failed' && job.canRetry;
    const restoreResult = turn.state === 'completed' && turn.reply && !this.state.result;
    if (!retry && !restoreResult) return;
    const operation = this.operation;
    let input: ReplyInputSnapshot;
    try {
      input = await interruptedReplyInput(this.backend, turn, {
        contactId: selection.contactId,
        displayName: this.contacts.getState().contacts.find((item) => item.contactId === selection.contactId)!.displayName,
      }, signal, current);
    } catch (error) {
      // 旧输入含已退役的排除设置：不恢复为可比对新输入；旧候选回看仍由已保存轮次提供。
      if (!isRetiredMessageExclusionError(error)) throw error;
      return;
    }
    if (!current() || operation !== this.operation || this.candidateSourceCheck) return;
    if (restoreResult && (input.scene ?? null) !== (this.state.scene || null)) return;
    if (retry) {
      this.restoredRetry = this.retainedRetries.has(turn.requestKey) ? turn.requestKey : undefined;
      // 同键重读继续持有原冻结命令及提醒票据，不丢失采用协议参数。
      if (this.lastAttempt?.requestKey !== turn.requestKey) this.lastAttempt = { input, requestKey: turn.requestKey };
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

  private async generationFinished(job: OwnedAssistantGeneration, settled: boolean, couldPublish: boolean): Promise<void> {
    const owner = job.identity;
    if (settled) this.retainedRetries.delete(owner.requestKey);
    const returned = owner.connectionGeneration === this.backend.getConnectionGeneration()
      && owner.contactId === this.state.contactId && owner.sessionId === this.state.savedSession?.sessionId
      && !this.helperHidden && !couldPublish && !job.signal.aborted;
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

  async readSavedSession(selection: ContactSelection, retainVerifiedDisplay = false): Promise<void> {
    this.assertScope(selection);
    this.cancelContactRestore();
    if (this.pendingExpressionPreferenceDeletions > 0 || this.pendingOwnerContextChanges > 0 || this.state.sessionDeletion === 'deleting'
      || this.catalogPending || this.state.sessionCatalog?.selectionPending) return;
    this.candidateRestoreOperation += 1;
    this.savedRead?.abort();
    const pending = new AbortController();
    this.savedRead = pending;
    const generation = this.backend.getConnectionGeneration();
    const content = this.pendingContent, inputOperation = this.operation;
    const heldSessionId = this.state.savedSession?.sessionId ?? content?.sessionId;
    // 同范围重开小窗保留已核验展示；后台仍走完整恢复和来源核验，失效投影不参与保留。
    if (!retainVerifiedDisplay || this.projectState().savedSession?.phase !== 'ready') {
      this.publish({ savedSession: { phase: 'loading', sessionId: heldSessionId ?? null, turns: [], inputs: [], currentInputVersionId: null } });
    }
    let projectionRead = this.sessionProjection.beginRead(this.projectionScope());
    const current = () => !pending.signal.aborted && selection.scopeRevision === this.state.scopeRevision
      && selection.contactId === this.state.contactId && generation === this.backend.getConnectionGeneration()
      && this.sessionProjection.isReadCurrent(projectionRead);
    try {
      const resolved = heldSessionId ? undefined : await currentAssistantSession(this.backend, selection.contactId, pending.signal);
      if (resolved?.deletionOperationId) {
        if (current() && resolved.generation === generation) {
          this.sessionProjection.invalidateSource();
          this.publish({ sessionDeletion: 'failed', result: null, selectedCandidateId: null, canRetry: false,
            confirmedSessionDeletion: undefined,
            savedSession: { phase: 'failed', sessionId: resolved.sessionId, turns: [], inputs: [], currentInputVersionId: null } });
        }
        return;
      }
      const sessionId = heldSessionId ?? resolved!.sessionId;
      if (!current()) return;
      if (resolved?.catalog) this.publish({ sessionCatalog: { phase: 'ready', items: resolved.catalog.items,
        currentSessionId: resolved.catalog.currentSessionId } });
      if (!sessionId) {
        this.publish({ savedSession: { phase: 'ready', sessionId: null, turns: [], inputs: [], currentInputVersionId: null } });
        return;
      }
      projectionRead = this.sessionProjection.resolveReadSession(projectionRead, sessionId);
      let saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (current() && saved.generation === generation) {
        this.generationJobs.reconcile({ connectionGeneration: saved.generation, contactId: selection.contactId, sessionId }, saved.turns);
        this.pruneRetries(selection.contactId, sessionId, saved.turns);
        if (this.candidateSourceCheck) {
          const verified = await this.acceptCandidateSourceSnapshot(saved, this.candidateSourceCheck, pending.signal, current, projectionRead);
          if (!verified?.read) return;
          projectionRead = verified.read;
          if (!current()) return;
          saved = verified.snapshot;
        }
        const heldVersion = (this.state.result ?? this.heldResult?.result)?.inputVersionId;
        const invalid = heldVersion && saved.turns.some((turn) => turn.inputVersionId === heldVersion
          && ['redacted', 'unavailable'].includes(turn.state));
        if (invalid) {
          this.cancelPending(); this.lastAttempt = undefined;
          this.messageNotices.forget(selection.contactId, saved.sessionId);
        }
        const budgetNotice = this.state.inputBudgetNotice;
        const inputBudgetNotice = budgetNotice?.sessionId === saved.sessionId
          && budgetNotice.inputVersionId === saved.currentInputVersionId
          && saved.inputs.some((input) => input.inputVersionId === budgetNotice.inputVersionId && input.state === 'active')
          ? budgetNotice : undefined;
        const result = this.state.result;
        const resultTurn = result?.assistantSessionId === saved.sessionId
          ? saved.turns.find((turn) => turn.inputVersionId === result.inputVersionId
            && turn.state === 'completed' && turn.reply?.replyRequestId === result.replyRequestId) : undefined;
        const accepted = this.sessionProjection.acceptRead(projectionRead, saved);
        if (accepted.kind !== 'accepted') return;
        projectionRead = accepted.read;
        this.publish({ savedSession: accepted.snapshot,
          inputBudgetNotice,
          ...(saved.sessionId !== heldSessionId ? { sessionDeletion: undefined } : {}),
          // 只刷新同一结果的无正文提醒，当前候选编辑和本次意图继续由用户持有。
          ...(resultTurn && result ? { result: { ...result,
            basisChanges: resultTurn.basisChanges ?? resultTurn.reply?.basisChanges } } : {}),
          ...(invalid ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false } : {}) }, 'authoritative');
        // SQLite实际发言不拥有旧候选选择；不可让未开放的候选端口阻断讨论回看及独立输入恢复。
        if (saved.discussionEntries === undefined) await this.restoreCandidateVersions(selection, saved.sessionId,
          saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []), true);
        else this.candidateVersions.setScope(null);
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
          this.derivedIntent = {
            direction: content.derivedIntent.direction && Boolean(restoredInput.direction),
            purpose: content.derivedIntent.purpose && Boolean(restoredInput.purpose),
          };
          this.workspaceRequirementInputVersion = restoredWorkspaceRequirementVersion(content, this.state.savedSession!, restoredInput.result);
          this.publish({ ...restoredInput, candidateDrafts, inputClearRevision: (this.state.inputClearRevision ?? 0) + 1 });
        }
        if (current() && inputOperation === this.operation) {
          await this.restoreGenerationView(selection, saved, pending.signal, current);
          if (current()) await this.messageNotices.restore();
        }
      }
    } catch (error) {
      if (current()) {
        const unavailable = error instanceof BackendRequestFailure && error.kind === 'response'
          && (error.status === 404 && error.code === 'not_found'
            || error.status === 409 && ['assistant_session_conflict', 'assistant_session_rejected'].includes(error.code ?? '')
              && ['source_unavailable', 'source_deleted'].includes(error.reason ?? ''));
        const rejected = this.sessionProjection.failRead(projectionRead, unavailable ? 'unavailable' : 'unknown');
        if (rejected.kind !== 'failed') return;
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
        this.publish({ savedSession: rejected.snapshot,
          ...(this.candidateSourceCheck ? { sourceAvailability: 'failed' } : unavailable ? { sourceAvailability: undefined } : {}),
          ...(unavailable ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false } : {}) });
      }
    } finally { if (this.savedRead === pending) this.savedRead = undefined; }
  }

  private invalidateSessionCatalog(): void {
    const pending = this.catalogPending;
    if (!pending) return;
    const selectionPending = this.catalogMutation === pending || this.state.sessionCatalog?.selectionPending === true;
    pending.abort(); this.catalogPending = undefined; this.catalogMutation = undefined;
    // 纯读取取消后可重新核对；变更请求已发出则继续保留结果未知的门禁。
    this.publish({ sessionCatalog: { phase: selectionPending ? 'failed' : 'idle', items: [],
      currentSessionId: null, selectionPending } });
  }

  async listSavedSessions(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.sessionDeletion === 'deleting'
      || this.pendingOwnerContextChanges > 0 || this.pendingExpressionPreferenceDeletions > 0
      || this.retainedSourceValidation?.checking) return;
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
  async viewSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection, undefined, true); }
  async resumeSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection); }
  async selectSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection); }
  private async switchSavedSession(selection: ContactSelection & { sessionId?: string }, carry?: AssistantCandidateCarry, viewOnly = false): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending
      || this.state.savedSession?.phase === 'loading' || this.state.sessionDeletion === 'deleting'
      || this.state.sessionDeletion === 'failed' || this.state.sourceAvailability === 'checking'
      || this.pendingOwnerContextChanges > 0 || this.pendingExpressionPreferenceDeletions > 0
      || this.retainedSourceValidation?.checking) {
      throw new Error('请等待当前操作完成后再切换助手会话。');
    }
    this.workspaceRequirementInputVersion = undefined;
    const previous = this.state.sessionCatalog;
    this.leaveGenerationView();
    const pending = new AbortController(); this.catalogPending = pending;
    if (!viewOnly) this.catalogMutation = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && this.catalogPending === pending
      && selection.contactId === this.state.contactId && selection.scopeRevision === this.state.scopeRevision
      && generation === this.backend.getConnectionGeneration();
    this.publish({ sessionCatalog: { phase: 'loading', items: previous?.items ?? [],
      currentSessionId: previous?.currentSessionId ?? null, selectionPending: previous?.selectionPending } });
    try {
      const selected = viewOnly ? { sessionId: selection.sessionId!, generation } : carry ? await newAssistantSessionWithCandidate(this.backend, carry, pending.signal) : selection.sessionId
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
      this.derivedIntent = { direction: false, purpose: false };
      this.notifyInputChanged(); this.retainedContent.delete(selection.contactId);
      // 初次开始或读取失败后明确新开，只保留本联系人的独立想法；旧聊天输入和讨论材料仍清空。
      const independentDraft = this.state.mode === 'rewrite_draft'
        && (this.state.options.inputKind === undefined || this.state.options.inputKind === 'workspace');
      const preserveLocalDraft = !viewOnly && !selection.sessionId && !carry && saved.discussionEntries !== undefined
        && (this.state.savedSession?.phase === 'ready' && this.state.savedSession.sessionId === null
          || this.state.savedSession?.phase === 'failed' && independentDraft);
      if (!viewOnly && !preserveLocalDraft) this.contacts.clearDraft(selection);
      const catalog = viewOnly ? await listAssistantSessions(this.backend, selection.contactId, pending.signal) : undefined;
      if (!current() || catalog && catalog.generation !== generation) return;
      const currentSessionId = viewOnly ? catalog!.currentSessionId : saved.sessionId;
      const items = catalog?.items ?? (previous?.items ?? []).map((item) => ({ ...item, isCurrent: item.sessionId === currentSessionId }));
      if (!items.some((item) => item.sessionId === saved.sessionId)) items.push({ sessionId: saved.sessionId, isCurrent: saved.sessionId === currentSessionId });
      this.candidateVersions.setScope(null); this.candidateSourceCheck = undefined;
      this.publish({ savedSession: { phase: 'ready', sessionId: saved.sessionId, turns: saved.turns,
        inputs: saved.inputs, currentInputVersionId: saved.currentInputVersionId,
        ...(saved.discussionEntries === undefined ? {} : {discussionEntries:saved.discussionEntries,runtimeRecovery:saved.runtimeRecovery}) },
        sessionCatalog: { phase: 'loading', items, currentSessionId, selectionPending: true },
        sessionDeletion: undefined, confirmedSessionDeletion: undefined, idleRollover: undefined,
        contextRefresh: !viewOnly && 'contextRefreshed' in selected && selected.contextRefreshed ? { sessionId: saved.sessionId } : undefined,
        options: defaults(), workspaceMigrationNotice: undefined, inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        mode: 'rewrite_draft', scene: '', targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '',
        skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], contentRestoreNotice: undefined, candidateDrafts: [],
        result: null, selectedCandidateId: null, canRetry: false, phase: 'idle', errorCode: undefined }, 'authoritative');
      if (saved.discussionEntries === undefined) await this.restoreCandidateVersions(selection, saved.sessionId,
        saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []), true);
      if (current()) {
        // 完成通知发出前释放切换锁，接收方才能立即进入新会话的工作区。
        this.catalogPending = undefined;
        this.publish({ sessionCatalog: { phase: 'ready', items, currentSessionId, selectionPending: false } });
      }
    } catch (error) {
      if (carry && current() && generation !== undefined && error instanceof BackendRequestFailure
        && error.kind === 'response' && (error.status === 404 && error.code === 'not_found'
          || error.status === 409 && error.code === 'assistant_session_rejected')) {
        // 来源删除也会清除选择回执；拒绝的分类不能代替对原会话的权威重读。
        await this.handleCandidateSourceUnavailable(new AssistantCandidateSourceUnavailable(carry, generation, null));
      }
      // 只有变更请求可能已落库；只读失败保留既有待核对决定，不制造未知写入。
      if (current()) this.publish({ sessionCatalog: { phase: 'failed', items: [], currentSessionId: null,
        selectionPending: !viewOnly || previous?.selectionPending === true } });
    } finally {
      if (this.catalogPending === pending) this.catalogPending = undefined;
      if (this.catalogMutation === pending) this.catalogMutation = undefined;
    }
  }

  async deleteSavedSession(selection: AssistantSessionDeletion): Promise<void> {
    this.assertScope(selection);
    if (this.catalogPending || this.state.sessionCatalog?.selectionPending) throw new Error('请先核对助手会话的选择结果。');
    if (selection.confirmed !== true || selection.sessionId !== this.state.savedSession?.sessionId) {
      throw new Error('本次助手会话已变化，请重新确认。');
    }
    if (this.state.sessionDeletion === 'deleting') return;
    this.workspaceRequirementInputVersion = undefined;
    const workspaceInput = this.state.options.inputKind === 'workspace';
    this.sessionProjection.invalidateSource();
    const owningGeneration = this.backend.getConnectionGeneration();
    if (owningGeneration !== undefined) this.generationJobs.cancelSession({ connectionGeneration: owningGeneration,
      contactId: selection.contactId, sessionId: selection.sessionId });
    this.candidateSourceCheck?.pending.abort();
    this.candidateVersions.setScope(null);
    this.savedRead?.abort(); this.savedRead = undefined;
    this.cancelPending(); this.lastAttempt = undefined;
    this.derivedIntent = { direction: false, purpose: false };
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
      this.messageNotices.forget(selection.contactId, selection.sessionId);
      for (const [key, retry] of this.retainedRetries) if (retry.contactId === selection.contactId && retry.sessionId === selection.sessionId) this.retainedRetries.delete(key);
      this.retainedContent.delete(selection.contactId); this.pendingContent = undefined;
      this.contacts.clearDraft(selection);
      this.publish({ sessionDeletion: result.phase, savedSession: { phase: 'idle', sessionId: null, turns: [], inputs: [], currentInputVersionId: null },
        sessionCatalog: undefined,
        // 保留工作区的空白入口；删除仍清空所有内容，也不隐式新建助手会话。
        options: { ...defaults(), ...(workspaceInput ? { inputKind: 'workspace' as const } : {}) },
        workspaceMigrationNotice: undefined, inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
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

  // 本人依赖可跨联系人且含不对界面公开的参与资料；由原会话和依据 GET 决定精确撤下范围。
  beginOwnerContextChange(): void {
    const content = this.pendingContent ?? retainContactContent(this.state, this.derivedIntent, this.draft, this.workspaceRequirementInputVersion);
    if (this.state.contactId && content) this.retainedContent.set(this.state.contactId, content);
    const held = this.heldResult ?? (this.state.result ? { result: this.state.result,
      selectedCandidateId: this.state.selectedCandidateId } : undefined);
    ++this.pendingOwnerContextChanges;
    this.sessionProjection.invalidateSource();
    this.generationJobs.cancelAll();
    this.savedRead?.abort(); this.savedRead = undefined;
    this.invalidateSessionCatalog();
    this.cancelPending(); this.lastAttempt = undefined;

    this.pendingContent = content;
    this.heldResult = held;
    this.candidateVersions.setScope(null);
    this.publish({ result: null, selectedCandidateId: null, phase: 'idle', canRetry: false,
      candidateDrafts: [], sourceAvailability: held ? 'checking' : undefined,
      ...(this.state.savedSession ? { savedSession: { ...this.state.savedSession, ...invalidatedSqliteDiscussion(this.state.savedSession), phase: 'idle' as const,
        turns: [], inputs: [], currentInputVersionId: null } } : {}) });
  }
  async revalidateOwnerContextChange(): Promise<void> {
    this.pendingOwnerContextChanges = Math.max(0, this.pendingOwnerContextChanges - 1);
    if (this.pendingOwnerContextChanges === 0) await this.revalidateDeletedSource('', { preserveInput: true });
  }

  /** 清空聊天拥有独立的配对结算；通用本人资料复验不负责清理消息缓存。 */
  beginHistoryClear(contactId: string): () => Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    const withdrawMessages = () => {
      if (generation !== this.backend.getConnectionGeneration()) return;
      this.messageNotices.forget(contactId);
      if (this.state.contactId !== contactId) return;
      this.cancelMessagePage();
      this.publish({ messages: { phase: 'idle', items: [], nextCursor: null }, targetMessageId: null });
    };
    this.beginOwnerContextChange();
    withdrawMessages();
    let settlement: Promise<void> | undefined;
    return () => settlement ??= (async () => {
      // 先撤销清空期间的读取，再解除本次读锁；复验早退或另一操作未结束也不能露出旧正文。
      withdrawMessages();
      await this.revalidateOwnerContextChange();
    })();
  }

  beginExpressionPreferenceDeletion(): void {
    this.sessionProjection.invalidateSource();
    ++this.pendingExpressionPreferenceDeletions;
    this.generationJobs.cancelAll();
    this.retainedRetries.clear(); this.messageNotices.forget();
    const held = this.heldResult ?? (this.state.result ? { result: this.state.result,
      selectedCandidateId: this.state.selectedCandidateId } : undefined);
    this.savedRead?.abort(); this.savedRead = undefined;
    this.invalidateSessionCatalog();
    this.cancelPending(); this.lastAttempt = undefined;
    this.heldResult = held;
    this.candidateVersions.setScope(null);
    this.publish({ result: null, selectedCandidateId: null, phase: 'idle', canRetry: false,
      candidateDrafts: [], sourceAvailability: this.heldResult ? 'checking' : undefined,
      ...(this.state.savedSession ? { savedSession: { ...this.state.savedSession, ...invalidatedSqliteDiscussion(this.state.savedSession), phase: 'idle' as const,
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
    this.sessionProjection.invalidateSource();
    this.invalidateSessionCatalog();
    for (const [key, retry] of this.retainedRetries) if (retry.contactId === contactId) this.retainedRetries.delete(key);
    this.messageNotices.forget(contactId);
    const owningGeneration = this.backend.getConnectionGeneration();
    if (owningGeneration !== undefined) this.generationJobs.cancelContact(owningGeneration, contactId);
    const activeContact = this.state.contactId, activeScope = this.state.scopeRevision;
    const restoring = this.pendingContent;
    const displayedContent = retainContactContent(this.state, this.derivedIntent, this.draft, this.workspaceRequirementInputVersion);
    const activeContent = restoring ?? displayedContent;
    if (activeContact && activeContent) this.retainedContent.set(activeContact, activeContent);
    const validation = { checking: true }; this.retainedSourceValidation = validation;
    this.pendingContent = undefined; this.savedRead?.abort();
    this.publish({ candidateDrafts: [], ...(this.state.savedSession?.discussionEntries === undefined ? {} : {savedSession:{...this.state.savedSession,...invalidatedSqliteDiscussion(this.state.savedSession)}}) });
    const retainedValidation = Promise.all([this.revalidateRetainedContents(), this.revalidateRetryInputs()]).finally(() => {
      if (this.retainedSourceValidation === validation) {
        validation.checking = false;
        this.publish({});
      }
    });
    const refreshCatalog = this.state.sessionCatalog?.phase === 'idle' && !this.state.sessionCatalog.selectionPending;
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
      this.savedRead?.abort();
      this.savedRead = undefined;
      if (this.state.savedSession && !candidateSnapshotAccepted) this.publish({ savedSession: { ...this.state.savedSession, ...invalidatedSqliteDiscussion(this.state.savedSession), phase: 'idle', turns: [], inputs: [], currentInputVersionId: null } });
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
          correction: '', ...invalidatedSupplement(this.state),
          ...invalidatedIntent(this.derivedIntent) });
        this.derivedIntent = { direction: false, purpose: false };
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
            const latest = retainContactContent(this.state, this.derivedIntent, this.draft, this.workspaceRequirementInputVersion);
            if (displayedContent && latest) {
              const input = { ...clean.input };
              for (const key of Object.keys(input) as (keyof typeof input)[]) {
                if (JSON.stringify(latest.input[key]) !== JSON.stringify(displayedContent.input[key])) {
                  Object.assign(input, { [key]: latest.input[key] });
                }
              }
              const requirementsChanged = latest.input.options.inputKind !== displayedContent.input.options.inputKind
                || latest.input.mode !== displayedContent.input.mode;
              this.pendingContent = { ...clean, input,
                workspaceRequirementInputVersion: requirementsChanged ? undefined : clean.workspaceRequirementInputVersion,
                draft: latest.draft !== displayedContent.draft ? latest.draft : clean.draft };
            } else this.pendingContent = clean;
            await this.readSavedSession({ contactId: activeContact, scopeRevision: activeScope });
          }
          if (refreshCatalog && activeContact && activeContact === this.state.contactId && activeScope === this.state.scopeRevision
            && owningGeneration === this.backend.getConnectionGeneration()
            && this.pendingOwnerContextChanges === 0 && this.pendingExpressionPreferenceDeletions === 0) {
            const selection = { contactId: activeContact, scopeRevision: activeScope };
            await this.listSavedSessions(selection);
            if (!restoring && activeContact === this.state.contactId && activeScope === this.state.scopeRevision
              && owningGeneration === this.backend.getConnectionGeneration()) await this.readSavedSession(selection);
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

  // 只迁移当前编辑输入；历史轮次与原候选继续保持原输入来历。
  enterWorkspace(selection: ContactSelection): ReplySessionState {
    const contact = this.assertScope(selection); this.assertSessionSelection();
    if (this.state.mode === 'rewrite_draft' && this.state.options.inputKind === 'workspace') return this.getState();
    this.workspaceRequirementInputVersion = undefined;
    if (this.state.savedSession?.phase !== 'ready') throw new Error('请等待联系人内容恢复完成。');
    const previous = this.state.options, mode = this.state.mode;
    const pasted = mode === 'rewrite_draft' && previous.inputKind === 'current_chat';
    const scenario = mode !== 'rewrite_draft';
    const derived = mode === 'reply_to_message' ? this.derivedIntent.direction
      : mode === 'initiate_conversation' && this.derivedIntent.purpose;
    const mixedSupplement = scenario && Boolean(this.state.correction
      || this.state.requirements && this.state.supplementInput !== false);
    const intention = pasted ? previous.pastedDirection ?? '' : mode === 'reply_to_message'
      ? derived ? '' : this.state.direction : mode === 'initiate_conversation' ? derived ? '' : this.state.purpose : contact.draft;
    const draft = [intention, scenario && this.state.supplementInput === false ? this.state.requirements : ''].filter(Boolean).join('\n');
    const { pastedDirection: _legacyDirection, workspaceAction: _legacyAction, ...options } = previous;
    this.invalidateInput();
    // 同一同步命令先更新内部草稿，避免联系人通知把这次迁移当成独立编辑。
    this.draft = draft;
    this.contacts.setDraft({ ...selection, text: draft });
    this.publish({ mode: 'rewrite_draft', targetMessageId: null,
      options: { ...options, inputKind: 'workspace', includeRelationshipContext: true,
        ...(pasted ? { contextText: contact.draft } : {}) },
      inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
      workspaceMigrationNotice: derived || mixedSupplement
        ? '旧模式的方向建议和依赖原讨论的补充已保留在历史中，查看后可明确采用。' : undefined });
    return this.getState();
  }

  updateOptions(update: RewriteOptionsUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (JSON.stringify(update.options) !== JSON.stringify(this.state.options)) {
      if (update.options.inputKind !== this.state.options.inputKind) {
        this.workspaceRequirementInputVersion = undefined;
      }
      this.notifyInputChanged();
      this.cancelPending();
      this.lastAttempt = undefined;
      this.publish({ options: { ...update.options }, phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
    }
    return snapshot ? this.getState() : undefined;
  }

  async setMode(update: ReplyModeUpdate): Promise<void> {
    this.assertScope(update);
    if (update.mode !== this.state.mode) {
      this.workspaceRequirementInputVersion = undefined;
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
    const automaticRevision = this.automaticMessageRevision;
    const pending = new AbortController();
    this.messagePending = pending;
    const current = () => operation === this.messageOperation && generation === this.backend.getConnectionGeneration()
      && request.scopeRevision === this.state.scopeRevision && request.contactId === this.state.contactId;
    this.publish({ messages: { ...this.state.messages, phase: 'loading' } });
    const noticeRefresh = !before ? this.messageNotices.captureRefresh() : undefined;
    try {
      const page = await readReplyMessages(this.backend, request.contactId, before, pending.signal);
      if (!current() || page.generation !== generation) return;
      const automaticallyUpdated = automaticRevision !== this.automaticMessageRevision;
      const items = before || automaticallyUpdated ? mergeReplyMessages(this.state.messages.items, page.messages) : page.messages;
      const nextCursor = automaticallyUpdated && (!before || this.state.messages.nextCursor !== before)
        ? this.state.messages.nextCursor : page.nextCursor;
      if (this.state.targetMessageId && !items.some((item) => item.messageId === this.state.targetMessageId)) {
        this.invalidateInput();
        this.publish({ targetMessageId: null });
      }
      this.publish({ messages: { phase: 'ready', items, nextCursor } });
      if (noticeRefresh) this.messageNotices.confirmRefresh(noticeRefresh);
    } catch {
      if (current()) {
        this.invalidateInput();
        this.publish({ messages: { phase: 'failed', items: [], nextCursor: null }, targetMessageId: null });
      }
    } finally { if (this.messagePending === pending) this.messagePending = undefined; }
  }
  private acceptAutomaticMessagePage(page: Awaited<ReturnType<typeof readReplyMessages>>): ReplySessionState['messages'] | undefined {
    if (page.generation !== this.backend.getConnectionGeneration() || this.pendingContent || this.candidateSourceCheck) return;
    const previous = this.state.messages;
    const known = new Set(previous.items.map((item) => item.messageId));
    const overlaps = page.messages.some((message) => known.has(message.messageId));
    ++this.automaticMessageRevision;
    return { phase: previous.phase === 'loading' ? 'loading' : 'ready',
      items: mergeReplyMessages(previous.items, page.messages),
      nextCursor: previous.items.length && overlaps ? previous.nextCursor : page.nextCursor };
  }
  selectMessage(selection: ReplyMessageSelection): ReplySessionState {
    this.assertScope(selection);
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    if (this.state.mode !== 'reply_to_message' || !this.state.messages.items.some((item) => item.messageId === selection.messageId)) {
      throw new Error('待回复消息已失效，请重新选择。');
    }
    if (selection.messageId !== this.state.targetMessageId) {
      const suggested = this.derivedIntent.direction;
      this.derivedIntent.direction = false;
      this.invalidateInput(); this.publish({ targetMessageId: selection.messageId,
        ...(suggested ? { direction: '' } : {}) });
    }
    return this.getState();
  }
  updateDirection(update: ReplyDirectionUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (this.state.mode !== 'reply_to_message') throw new Error('请先切换到回复模式。');
    if (update.direction !== this.state.direction) {
      // 手动修改不解除已确认建议的来源依赖，删除来源时仍须清理派生文字。
      this.invalidateInput(); this.publish({ direction: update.direction });
    }
    return snapshot ? this.getState() : undefined;
  }
  updatePurpose(update: import('../../shared/reply-bridge').ReplyPurposeUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (this.state.mode !== 'initiate_conversation') throw new Error('请先选择主动聊聊。');
    if (update.purpose !== this.state.purpose) {
      // 手动修改不解除已确认建议的来源依赖，删除来源时仍须清理派生文字。
      this.invalidateInput(); this.publish({ purpose: update.purpose });
    }
    return snapshot ? this.getState() : undefined;
  }

  updateSupplement(update: import('../../shared/reply-bridge').ReplySupplementUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (this.state.mode === 'rewrite_draft') throw new Error('请先选择聊天场景。');
    const previousLength = Array.from([this.state.correction, this.state.requirements].filter(Boolean).join('\n')).length;
    // 旧双框可能合计超限，允许逐步缩短，但超限内容不能提交给模型。
    if (!fitsReplyTextLimit(update.supplement) && Array.from(update.supplement).length > previousLength) throw new Error(`补充内容最多${replyTextLimit}个字符。`);
    if (update.supplement !== this.state.requirements || this.state.correction || this.state.supplementInput !== true) {
      // 统一补充沿用请求级要求槽；一次更新清掉旧纠正，避免隐藏文字继续影响回复。
      this.invalidateInput(); this.publish({ requirements: update.supplement, correction: '', supplementInput: true });
    }
    return snapshot ? this.getState() : undefined;
  }

  updateCorrection(update: ReplyCorrectionUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (this.state.mode === 'rewrite_draft') throw new Error('请先选择聊天场景。');
    if (update.correction !== this.state.correction) {
      this.invalidateInput(); this.publish({ correction: update.correction });
    }
    return snapshot ? this.getState() : undefined;
  }

  updateRequirements(update: ReplyRequirementsUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (update.requirements !== this.state.requirements || this.state.supplementInput !== false) { this.invalidateInput(); this.publish({ requirements: update.requirements, supplementInput: false }); }
    return snapshot ? this.getState() : undefined;
  }
  updateSkill(update: ReplySkillUpdate): ReplySessionState {
    this.assertScope(update);
    if (JSON.stringify(update.skill) !== JSON.stringify(this.state.skillChoice)) {
      this.invalidateInput(); this.publish({ skillChoice: { ...update.skill } });
    }
    return this.getState();
  }
  updateScene(update: import('../../shared/reply-bridge').ReplySceneUpdate, snapshot = true): ReplySessionState | void {
    this.assertScope(update);
    if (typeof update.scene !== 'string' || update.scene.length > 256) throw new Error('精确场景不可用。');
    const scene = update.scene.trim();
    if (scene !== (this.state.scene ?? '')) {
      this.invalidateInput();
      this.publish({ scene, skillChoices: [] });
    }
    return snapshot ? this.getState() : undefined;
  }
  async generate(selection: GenerateReply): Promise<void> {
    this.assertCurrentSession();
    let contactState = this.assertScope(selection);
    if (selection.workspaceAction === undefined && this.state.mode !== 'rewrite_draft' && !fitsReplyTextLimit([this.state.correction, this.state.requirements].filter(Boolean).join('\n'))) throw new Error(`请将补充内容缩短至${replyTextLimit}个字符以内再生成。`);
    this.assertSessionSelection();
    this.refreshGenerationEligibility();
    if (this.state.generationBlock) throw new Error('请先确认本次联系人。');
    if (this.state.savedSession?.phase !== 'ready' || !this.state.savedSession.sessionId
      || this.state.savedSession.discussionEntries !== undefined) {
      throw new Error('请先核对当前助手会话，再从当前会话生成候选。');
    }
    // 点击动作与本次输入一起冻结，恢复旧场景也不再走选消息或确认方向的门禁。
    if (selection.workspaceAction !== undefined) {
      this.enterWorkspace(selection);
      contactState = this.assertScope(selection);
      if (selection.workspaceAction === 'express' && !contactState.draft.trim()) return;
      const previous = this.state.options;
      if (this.state.mode !== 'rewrite_draft' || this.state.targetMessageId !== null || previous.inputKind !== 'workspace'
        || previous.workspaceAction !== selection.workspaceAction) {
        this.invalidateInput();
        const { pastedDirection: _legacyDirection, ...options } = previous;
        this.publish({ mode: 'rewrite_draft', targetMessageId: null, options: { ...options,
          inputKind: 'workspace', workspaceAction: selection.workspaceAction,
          includeRelationshipContext: previous.inputKind === 'workspace' ? previous.includeRelationshipContext : true } });
      }
    }
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

    if (!selection.newRequest && this.restoredRetry && this.state.canRetry) {
      const retry = this.retainedRetries.get(this.restoredRetry);
      if (retry?.contactId === selection.contactId && retry.sessionId === this.state.savedSession?.sessionId) {
        await retry.run(); return;
      }
    }
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
    if (this.state.mode === 'rewrite_draft' ? !contactState.draft.trim() && !(options.inputKind === 'workspace' && options.workspaceAction === 'suggest')
      : this.state.mode === 'initiate_conversation' ? !this.state.purpose.trim() : !target || !this.state.direction.trim()) return;
    if (this.state.mode === 'rewrite_draft' && options.inputKind === 'current_chat' && !options.pastedDirection?.trim()) return;
    this.notifyInputChanged();
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName, ...sceneSnapshot(this.state.scene || null),
      ...(selection.allowIncompleteHistory === true ? { allowIncompleteHistory: true } : {}) };
    const input: ReplyInputSnapshot = this.state.mode === 'rewrite_draft'
      ? { ...common, mode: 'rewrite_draft', draftText: contactState.draft.trim(),
        userInstruction: null,
        includeRelationshipContext: options.includeRelationshipContext,
        ...(options.inputKind === 'workspace' ? { inputKind: 'workspace', workspaceAction: options.workspaceAction,
          skillChoice: { ...this.state.skillChoice },
          ...(options.contextText?.trim() ? { contextText: options.contextText.trim() } : {}) } : {}),
        ...(options.inputKind === 'current_chat' ? { inputKind: 'current_chat', pastedDirection: options.pastedDirection!.trim() } : {}) }
      : this.state.mode === 'initiate_conversation'
        ? { ...common, mode: 'initiate_conversation', purpose: this.state.purpose.trim(), correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(), clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...this.state.skillChoice } }
        : { ...common, mode: 'reply_to_message', target: structuredClone(target!), direction: this.state.direction.trim(),
        correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(), clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...this.state.skillChoice } };
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
      || turn?.state !== 'failed' || !['app_quit', 'configuration_reload', 'user_cancelled'].includes(turn.interruptionReason ?? '') || !turn.input || turn.reply) {
      throw new Error('中断生成或来源已失效，请重新读取。');
    }
    const input = await interruptedReplyInput(this.backend, turn, contact, pending.signal, current);
    this.assertScope(request); this.assertSessionSelection();
    if (!current()) throw new Error('中断生成归属已变化。');
    this.notifyInputChanged();
    await this.generateInput({ contactId: request.contactId, scopeRevision: request.scopeRevision, newRequest: true },
      input, undefined, request.inputVersionId, { turnId: request.turnId, inputVersionId: request.inputVersionId });
  }

  async stopGeneration(request: AssistantGenerationStop): Promise<void> {
    this.assertScope(request); this.assertSessionSelection(true);
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) throw new Error('这次生成已经结束或不再属于当前联系人。');
    const displayedSessionId = this.state.savedSession?.sessionId;
    await this.generationJobs.cancelUserGeneration({ connectionGeneration: generation,
      contactId: request.contactId, sessionId: request.sessionId, requestKey: request.requestKey },
    request.inputVersionId);
    if (generation !== this.backend.getConnectionGeneration() || request.contactId !== this.state.contactId
      || request.scopeRevision !== this.state.scopeRevision || request.sessionId !== displayedSessionId
      || request.sessionId !== this.state.savedSession?.sessionId) return;
    this.leaveGenerationView();
    await this.readSavedSession({ contactId: request.contactId, scopeRevision: request.scopeRevision });
    if (generation === this.backend.getConnectionGeneration() && request.contactId === this.state.contactId
      && request.scopeRevision === this.state.scopeRevision && request.sessionId === this.state.savedSession?.sessionId) {
      this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false, errorCode: undefined });
    }
  }

  private async generateInput(selection: GenerateReply, input: ReplyInputSnapshot,
    replaceable?: PendingAssistantGenerationReceipt, expectedInputVersionId?: string, interrupted?: InterruptedReplyOrigin,
    messageAdoption?: MessageAdoptionCommand): Promise<void> {
    this.assertCurrentSession();
    const adoptNewMessageId = messageAdoption?.messageId;
    if (selection.newRequest && adoptNewMessageId === undefined) this.workspaceRequirementInputVersion = undefined;
    if (adoptNewMessageId !== undefined && (!isUuid(adoptNewMessageId) || !isUuid(expectedInputVersionId)
      || interrupted !== undefined || input.mode === 'rewrite_draft' && input.inputKind !== 'workspace')) throw new Error('本次新消息采用身份无效。');
    const generation = this.backend.getConnectionGeneration();
    const retryCandidateIds = !selection.newRequest && this.lastAttempt
      ? this.state.result?.candidates.map((candidate) => candidate.original.candidateId) ?? [] : [];
    if (selection.newRequest || !this.lastAttempt) this.lastAttempt = { input, requestKey: randomUUID(),
      ...(expectedInputVersionId === undefined ? {} : { expectedInputVersionId }),
      ...(interrupted === undefined ? {} : { interrupted: Object.freeze({ ...interrupted }) }),
      ...(messageAdoption === undefined ? {} : { messageNotice: messageAdoption.notice }),
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
    let budgetReceipt: AssistantGenerationReceipt | undefined;
    const current = () => operation === this.operation && generation === this.backend.getConnectionGeneration()
      && !pending.signal.aborted && !this.state.sessionCatalog?.selectionPending
      && selection.scopeRevision === this.state.scopeRevision && selection.contactId === this.state.contactId
      && (!job || this.generationJobs.canPublish(job, { connectionGeneration: job.identity.connectionGeneration,
        contactId: this.state.contactId, sessionId: this.state.savedSession?.sessionId ?? job.identity.sessionId }));
    this.publish({ phase: 'waiting', errorCode: undefined, canRetry: true });
    let failureVerification: AssistantProjectionVerification | undefined;
    const confirmMessageNotice = (result: OrdinaryGenerationResult) => {
      if (current() && attempt.messageNotice && result.assistantSessionId === attempt.messageNotice.sessionId
        && result.inputVersionId !== attempt.expectedInputVersionId) this.messageNotices.confirmAdoption(attempt.messageNotice);
    };
    const consume = async (sessionId: string, result: OrdinaryGenerationResult) => {
      if (!current() || result.generation !== generation) return;
      // 可靠完成可作为历史读取；只有仍属当前输入且来源有效的结果才可成为当前候选。
      // 完成确认接管此前在途读取，避免较旧快照仅因晚返回而覆盖本次确认。
      this.savedRead?.abort();
      const verification = this.sessionProjection.beginVerification(this.projectionScope(sessionId));
      const saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      const completionIdentity = { requestKey: attempt.requestKey, inputVersionId: result.inputVersionId,
        replyRequestId: result.replyRequestId };
      let accepted = this.sessionProjection.acceptCompletion(verification, saved, completionIdentity);
      const rejectCompletion = async () => {
        this.lastAttempt = undefined;
        if (accepted.kind === 'unavailable') {
          this.publish({ phase: 'idle', canRetry: false, result: null, selectedCandidateId: null });
          await this.readSavedSession(selection);
        } else this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
          errorCode: undefined, inputBudgetNotice: undefined });
      };
      if (accepted.kind !== 'accepted') { await rejectCompletion(); return; }
      const completed = accepted.verifiedTurn;
      let resultInput = attempt.input;
      if ('restoredInput' in result && (!completed.input || JSON.stringify(completed.input) !== JSON.stringify(result.restoredInput))) {
        throw new Error('原输入恢复与已保存结果不一致，请重试同一次生成。');
      }
      if (attempt.adoptNewMessageId !== undefined && (!completed.input || completed.requestKey !== attempt.requestKey
        || !('adoptionSubmission' in result) || !result.adoptionSubmission
        || !matchesReplyAdoption(completed.input, result.adoptionSubmission))) {
        throw new Error('本次新消息输入尚未可靠确认，请重试同一次生成。');
      }
      if ('restoredInput' in result || attempt.adoptNewMessageId !== undefined) {
        resultInput = await interruptedReplyInput(this.backend, completed,
          { contactId: selection.contactId, displayName: attempt.input.contactDisplayName }, pending.signal, current);
        if (!current()) return;
        accepted = this.sessionProjection.acceptCompletion(verification, saved, completionIdentity);
        if (accepted.kind !== 'accepted') { await rejectCompletion(); return; }
      }
      if (attempt.adoptNewMessageId !== undefined && resultInput.mode === 'rewrite_draft' && resultInput.inputKind === 'workspace') {
        this.workspaceRequirementInputVersion = result.inputVersionId;
      }
      this.savedRead?.abort(); this.savedRead = undefined;
      const inputBudgetNotice = result.inputBudget ? { contactId: selection.contactId,
        scopeRevision: selection.scopeRevision, sessionId: result.assistantSessionId, requestKey: attempt.requestKey,
        inputVersionId: result.inputVersionId, connectionGeneration: generation, operation, decision: result.inputBudget } : undefined;
      const basisChanges = accepted.turn.basisChanges ?? accepted.turn.reply?.basisChanges;
      // 同键重放恢复原结果，保留该候选在本次运行中的编辑和选择。
      if (this.state.result?.replyRequestId === result.replyRequestId) {
        this.publish({ phase: 'ready', inputBudgetNotice, result: { ...this.state.result, basisChanges } });
        confirmMessageNotice(result); return;
      }
      // 完成核验已取得可信完整快照；保留它，避免页面再次全量读取并抢占本轮候选版本加载。
      this.publish({ phase: 'ready', savedSession: accepted.snapshot,
      ...(this.state.sessionCatalog?.phase === 'ready' && this.state.sessionCatalog.currentSessionId === null
        ? { sessionCatalog: { phase: 'ready' as const, currentSessionId: result.assistantSessionId,
          items: [...this.state.sessionCatalog.items.filter(item => item.sessionId !== result.assistantSessionId),
            { sessionId: result.assistantSessionId, isCurrent: true }] } } : {}),
      inputBudgetNotice,
      ...(result.assistantSessionId !== this.state.savedSession?.sessionId ? { sessionDeletion: undefined } : {}),
      result: { replyRequestId: result.replyRequestId, assistantSessionId: result.assistantSessionId,
        inputVersionId: result.inputVersionId, input: resultInput,
        contextEvidenceIds: result.contextEvidenceIds,
        basisChanges,
        expressionPreferenceIds: result.expressionPreferenceIds, expressionPreferences: result.expressionPreferences,
        usedSkill: result.usedSkill,
        inputBudget: result.inputBudget,
        candidates: result.candidates.map((original) => ({ original, editedText: original.text })) },
      selectedCandidateId: result.candidates[0].candidateId }, 'authoritative');
      await this.restoreCandidateVersions(selection, result.assistantSessionId,
        result.candidates.map((candidate) => candidate.candidateId));
      confirmMessageNotice(result);
    };
    const failed = async (error: unknown, observation?: OrdinaryFailureObservation) => {
      const failure = error instanceof BackendRequestFailure ? error : undefined;
      // 无实际回执时，泛HTTP拒绝不能证明同key既有或在途领取已结束。
      const budgetFailure = failure?.code === 'input_budget_exceeded' || failure?.code === 'input_budget_unavailable';
      const providerLimit = failure?.status === 409 && failure.code === 'provider_context_limit';
      const formatFailure = failure?.reason?.startsWith('prepared_context_') === true;
      const preferencesChanged = failure?.kind === 'response' && failure.status === 409
        && failure.code === 'expression_preferences_changed';
      const receipt = observation?.receipt ?? budgetReceipt;
      if (observation?.receipt) budgetReceipt = observation.receipt;
      const saved = observation?.saved, readFailure = observation?.readFailure;
      const receiptSessionId = observation?.receiptSessionId ?? receipt?.sessionId;
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
          const sourceUnavailable = readFailure instanceof BackendRequestFailure && readFailure.kind === 'response'
            && (readFailure.status === 404 && readFailure.code === 'not_found'
              || readFailure.status === 409 && ['assistant_session_conflict', 'assistant_session_rejected'].includes(readFailure.code ?? '')
                && ['source_unavailable', 'source_deleted'].includes(readFailure.reason ?? ''));
          const verification = failureVerification ?? this.sessionProjection.beginVerification(
            this.projectionScope(receiptSessionId ?? selectedSessionId ?? null));
          const read = saved ? { kind: 'snapshot' as const, snapshot: saved }
            : { kind: sourceUnavailable ? 'unavailable' as const : readFailure ? 'unknown' as const : 'missing' as const };
          const decision = this.sessionProjection.acceptBudgetFailure(verification,
            receipt && receipt.requestKey === attempt.requestKey ? { kind: 'received', identity: receipt, read }
              : { kind: 'unconfirmed', read });
          if (decision.kind === 'unavailable' && decision.reason === 'source' && receiptSessionId) {
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
          if (decision.kind === 'unknown' && receiptSessionId && failure?.inputBudget) {
            // 无法复验不等于输入已失效；隐藏预算结论，保留本次身份供后端守卫重试。
            this.publish({ phase: 'failed', canRetry: true, inputBudgetNotice: undefined,
              errorCode: readFailure instanceof BackendRequestFailure && readFailure.kind === 'connection'
                ? 'connection' : 'unavailable' });
            return;
          }
          if (decision.kind !== 'accepted') {
            this.lastAttempt = undefined;
            this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
              errorCode: undefined, inputBudgetNotice: undefined });
            return;
          }
        }
        const decision = replyFailureDecision({ kind: failure?.kind, code: failure?.code, reason: failure?.reason,
          inputBudgetState: budgetFailure ? (failure?.inputBudget?.state === 'exceeded' ? 'exceeded' : 'unavailable') : undefined,
          providerLimit, formatFailure });
        if (!decision.known) {
          // 未知错误码不再静默折叠：按既有可重试策略处理，只记录非敏感协议字段以便定位。
          console.warn('reply_generation_unknown_failure', { kind: failure?.kind, code: failure?.code, reason: failure?.reason });
        }
        this.publish({ phase: 'failed', errorCode: decision.errorCode, ...(decision.canRetry ? {} : { canRetry: false }),
          inputBudgetNotice: budgetReceipt && failure?.inputBudget && generation !== undefined ? {
            contactId: selection.contactId, scopeRevision: selection.scopeRevision, sessionId: budgetReceipt.sessionId,
            requestKey: budgetReceipt.requestKey, inputVersionId: budgetReceipt.inputVersionId,
            connectionGeneration: generation, operation, decision: failure.inputBudget,
          } : undefined });
      }
    };
    try {
      const sessionId = selectedSessionId
        ?? (await defaultAssistantSession(this.backend, selection.contactId, pending.signal)).sessionId;
      if (generation === undefined || pending.signal.aborted || generation !== this.backend.getConnectionGeneration()) return;
      const owner = { connectionGeneration: generation, contactId: selection.contactId, sessionId };
      await this.generationJobs.execute({ identity: { ...owner, requestKey: attempt.requestKey }, controller: pending,
        stopping: captureAssistantGenerationStopping(this.backend, owner),
        adapter: ordinaryGeneration(this.backend, owner, attempt,
          replaceable && selection.newRequest ? replaceable.requestKey : undefined, current),
        replacement: replaceable && selection.newRequest ? replaceable : undefined,
        registered: (registered) => { job = registered; },
        prepared: (_registered, receipt) => {
          budgetReceipt = receipt;
          this.showIdleRollover(receipt, sessionId, selection, operation, generation, pending);
        },
        beforeFailure: () => { failureVerification = this.sessionProjection.beginVerification(this.projectionScope(budgetReceipt?.sessionId ?? sessionId)); },
        consume: (result) => consume(result.assistantSessionId, result), failed,
        finished: (finished, settled, couldPublish) => this.generationFinished(finished, settled, couldPublish),
      });
    } catch (error) { await failed(error);
    } finally { if (this.pending === pending) this.pending = undefined; }
  }

  selectCandidate(selection: ReplyCandidateSelection): ReplySessionState {
    this.assertCandidate(selection);
    this.notifyInputChanged();
    this.publish({ selectedCandidateId: selection.candidateId });
    return this.getState();
  }
  editCandidate(edit: ReplyCandidateEdit, snapshot = true): ReplySessionState | void {
    const candidate = this.assertCandidate(edit);
    const editingDuringGeneration = this.state.phase === 'waiting';
    // 用户后续编辑接管展示；在途生成仍按原作业保存，完成回执不得覆盖这份编辑。
    if (editingDuringGeneration) { this.leaveGenerationView(); this.lastAttempt = undefined; }
    this.notifyInputChanged();
    this.publish({ result: { ...this.state.result!, candidates: this.state.result!.candidates.map(item =>
      item === candidate ? { ...item, editedText: edit.text } : item) },
      ...(editingDuringGeneration ? { phase: 'ready' as const, canRetry: false } : {}) });
    return snapshot ? this.getState() : undefined;
  }
  async readCandidateVersions(request: ReplyCandidateVersionRead): Promise<ReplySessionState> {
    this.assertVersionScope(request);
    this.candidateRestoreOperation += 1;
    const current = this.candidateVersionOperationCurrent(request);
    try { await this.candidateVersions.read(request, current); }
    catch (error) { await this.handleCandidateSourceUnavailable(error); throw error; }
    return this.getState();
  }
  updateCandidateVersionDraft(update: ReplyCandidateDraftUpdate, snapshot = true): ReplySessionState | void {
    this.assertVersionScope(update);
    const view = this.state.candidateVersions?.items.find((item) => item.candidateId === update.candidateId);
    const version = view?.history?.versions.find((item) => item.versionId === update.versionId);
    if (this.state.phase === 'waiting' || this.state.savedSession?.phase !== 'ready'
      || this.state.candidateVersions?.phase !== 'ready' || view?.phase !== 'ready'
      || view.displayVersionId !== update.versionId || !version) {
      throw new Error('本组编辑版本尚未核对，请重新读取。');
    }
    if (version.messages.length !== update.messages.length
      || version.messages.some((message, index) => message.messageId !== update.messages[index].messageId)) {
      throw new Error('本组消息身份已变化，请重新读取。');
    }
    const { candidateId, versionId, messages, requirements } = update;
    const previousDraft = this.state.candidateDrafts?.find((item) => item.candidateId === candidateId
      && item.versionId === versionId);
    const previousMessages = previousDraft?.messages ?? version.messages;
    const bodyChanged = previousMessages.some((message, index) => message.text !== messages[index].text);
    const turn = this.state.savedSession.turns.find((item) => item.turnId === view.history!.turnId);
    const result = this.state.result;
    const matchingResult = bodyChanged && result && turn?.reply?.replyRequestId === result.replyRequestId;
    this.notifyInputChanged();
    this.publish({ candidateDrafts: [...(this.state.candidateDrafts ?? []).filter((item) => item.candidateId !== candidateId),
      structuredClone({ candidateId, versionId, messages, requirements })],
      ...(matchingResult ? { result: { ...result, candidates: result.candidates.map((item) =>
        item.original.candidateId === candidateId ? { ...item, editedText: messages.map((message) => message.text).join('\n\n') } : item) } } : {}) });
    return snapshot ? this.getState() : undefined;
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
    this.sessionProjection.invalidateSource();
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
    signal: AbortSignal, operationCurrent: () => boolean, read?: AssistantProjectionRead): Promise<{
      snapshot: Awaited<ReturnType<typeof readAssistantSession>>; read?: AssistantProjectionRead } | undefined> {
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
    for (const result of [this.state.result, this.heldResult?.result]) {
      if (result?.assistantSessionId === saved.sessionId && result.inputVersionId
        && !inputs.some((input) => input.inputVersionId === result.inputVersionId && input.state === 'active')) {
        invalidInputs.add(result.inputVersionId);
        candidateIds.push(...result.candidates.map((candidate) => candidate.original.candidateId));
      }
    }
    this.candidateVersions.setScope(check.scope);
    const ownedRead = this.clearUnavailableCandidateSource(check.scope, candidateIds, invalidInputs, read);
    const targetUnavailable = messages && this.state.targetMessageId !== null
      && !messages.items.some((message) => message.messageId === this.state.targetMessageId);
    const clearMessageDirection = targetUnavailable && this.derivedIntent.direction;
    if (clearMessageDirection) this.derivedIntent.direction = false;
    this.candidateSourceCheck = undefined;
    check.pending.abort();
    const snapshot = { phase: 'ready' as const, sessionId: saved.sessionId, turns, inputs,
      currentInputVersionId: saved.currentInputVersionId,
      ...(saved.discussionEntries === undefined ? {} : {discussionEntries:saved.discussionEntries,runtimeRecovery:saved.runtimeRecovery}) };
    this.publish({ savedSession: snapshot,
      ...(messages ? { messages, ...(targetUnavailable ? { targetMessageId: null } : {}) } : {}),
      ...(clearMessageDirection ? { direction: '' } : {}),
      sourceAvailability: this.heldResult ? this.sourceCheck ? 'checking' : 'failed' : undefined }, 'authoritative');
    return { snapshot: { ...saved, turns, inputs },
      read: ownedRead ? this.sessionProjection.acceptSourceProjection(ownedRead, snapshot) : undefined };
  }
  private clearUnavailableCandidateSource(scope: ContactSelection & { sessionId: string }, candidateIds?: string[],
    invalidInputs: Set<string> = new Set(),
    read?: AssistantProjectionRead): AssistantProjectionRead | undefined {
    const ownedRead = this.sessionProjection.invalidateSource(read);
    this.messageNotices.forget(scope.contactId, scope.sessionId);
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
    const clearDerived = (this.derivedIntent.direction || this.derivedIntent.purpose) && (!affected || clearResult || clearHeld);
    if (!affected || clearResult || clearHeld) {
      const result = clearResult ? this.state.result : this.heldResult?.result;
      if (result?.inputVersionId) inputIds.add(result.inputVersionId);
      for (const candidate of result?.candidates ?? []) affected?.add(candidate.original.candidateId);
      this.notifyInputChanged(); this.cancelPending(); this.lastAttempt = undefined;
    } else if (this.lastAttempt && turns.some((turn) => turn.requestKey === this.lastAttempt?.requestKey)) {
      this.lastAttempt = undefined;
    }
    this.candidateVersions.invalidate(scope, affected ? [...affected] : undefined);
    const placeholder = '相关来源不可用';
    this.publish({ ...(!affected ? { messages: { phase: 'idle' as const, items: [], nextCursor: null }, targetMessageId: null } : {}),
      ...(clearDerived ? invalidatedIntent(this.derivedIntent) : {}),
      ...(saved ? { savedSession: { ...saved, ...invalidatedSqliteDiscussion(saved),
      turns: saved.turns.map((turn) => turnIds.has(turn.turnId)
        ? { ...turn, state: 'unavailable', input: null, reply: null, placeholder } : turn),
      inputs: saved.inputs.map((input) => !affected || inputIds.has(input.inputVersionId)
        ? input.state === 'active' ? { ...input, state: 'unavailable', content: null, placeholder } : input : input),
      currentInputVersionId: saved.currentInputVersionId && inputIds.has(saved.currentInputVersionId)
        ? null : saved.currentInputVersionId } } : {}),
      ...(clearResult ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false, errorCode: undefined } : {}) });
    if (clearDerived) this.derivedIntent = { direction: false, purpose: false };
    return ownedRead;
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
    if (this.pendingExpressionPreferenceDeletions > 0 || this.pendingOwnerContextChanges > 0 || this.retainedSourceValidation?.checking) {
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
  private assertCurrentSession(): void {
    const saved = this.state.savedSession?.sessionId, catalog = this.state.sessionCatalog;
    if (saved && catalog && saved !== catalog.currentSessionId) {
      throw new Error('请先明确继续此讨论，或返回当前讨论后生成。');
    }
  }
  private assertSessionSelection(allowFailedDeletionStop = false): void {
    if (this.pendingExpressionPreferenceDeletions > 0 || this.pendingOwnerContextChanges > 0 || this.retainedSourceValidation?.checking) {
      throw new Error('请等待删除后的来源核验完成。');
    }
    if (this.pendingContent) throw new Error('请等待联系人内容恢复完成，失败时请重新读取讨论。');
    if (this.state.sessionDeletion === 'deleting' || this.state.sessionDeletion === 'failed' && !allowFailedDeletionStop) {
      throw new Error('请先核对当前助手会话的删除结果。');
    }
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    if (this.catalogPending || this.state.sessionCatalog?.selectionPending) {
      throw new Error('请刷新讨论列表并明确选择本次助手讨论。');
    }
  }
  private cancelContactRestore(): void {
    clearTimeout(this.contactRestoreTimer); this.contactRestoreTimer = undefined;
  }
  private receiveContact(state: ContactSessionState): void {
    if (state.directoryPhase === 'ready') {
      for (const [key, retry] of this.retainedRetries) if (!state.contacts.some((contact) => contact.contactId === retry.contactId)) this.retainedRetries.delete(key);
      this.messageNotices.retainContacts(state.contacts.map((contact) => contact.contactId));
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
      this.cancelContactRestore();
      const generation = this.backend.getConnectionGeneration();
      if (generation !== undefined && generation === this.contentGeneration && this.state.contactId
        && state.contacts.some((contact) => contact.contactId === this.state.contactId)) {
        const content = this.pendingContent ?? retainContactContent(this.getState(), this.derivedIntent, this.draft, this.workspaceRequirementInputVersion);
        if (content) this.retainedContent.set(this.state.contactId, content);
      }
      this.workspaceRequirementInputVersion = undefined;
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
      this.leaveGenerationView();
      this.cancelMessagePage();

      this.derivedIntent = { direction: false, purpose: false };
      this.lastAttempt = undefined;
      this.draft = state.draft;
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.selectedContactId, candidateDrafts: [], contentRestoreNotice: undefined,
        options: defaults(), workspaceMigrationNotice: undefined, mode: 'rewrite_draft', scene: '', messages: { phase: 'idle', items: [], nextCursor: null },
        targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '', skillChoice: { mode: 'auto', versionId: null }, skillChoices: [],
        phase: 'idle', errorCode: undefined, result: null, selectedCandidateId: null, canRetry: false,
        savedSession: { phase: 'idle', sessionId: null, turns: [], inputs: [], currentInputVersionId: null }, sessionDeletion: undefined,
        sessionCatalog: undefined,
        confirmedSessionDeletion: undefined });
      this.candidateSourceCheck = undefined;
      // 同连接恢复前先核验原会话；新连接没有输入缓存，不触发生成。
      if (state.selectedContactId && state.directoryPhase === 'ready') {
        const selection = { contactId: state.selectedContactId, scopeRevision: state.scopeRevision };
        this.publish({ savedSession: { phase: 'loading', sessionId: null, turns: [], inputs: [], currentInputVersionId: null } });
        // 身份已立即发布；短暂途经的联系人不启动完整恢复，显式读取仍立即执行。
        this.contactRestoreTimer = setTimeout(() => {
          this.contactRestoreTimer = undefined;
          if (generation !== this.backend.getConnectionGeneration() || selection.contactId !== this.state.contactId
            || selection.scopeRevision !== this.state.scopeRevision) return;
          void this.readSavedSession(selection);
        }, 150);
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
    this.messageNotices.reconnect();
  }
  async combineNewMessages(selection: ContactSelection): Promise<void> {
    const contacts = this.assertScope(selection); this.assertSessionSelection(); this.refreshGenerationEligibility();
    const notice = this.messageNotices.captureAdoption();
    const generation = this.backend.getConnectionGeneration();
    const sessionId = this.state.savedSession?.sessionId;
    const mode = this.state.mode;
    const options = this.state.options;
    const workspace = mode === 'rewrite_draft' && options.inputKind === 'workspace';
    const operation = this.operation;
    if (!notice || generation === undefined || !sessionId || notice.sessionId !== sessionId
      || this.state.generationBlock || mode === 'rewrite_draft' && !workspace) throw new Error('请先核对当前联系人与新消息提醒。');
    if (workspace && !options.includeRelationshipContext) throw new Error('请先启用联系人上下文，再结合新消息。');
    const receipt = this.generationJobs.requestReceipt({ connectionGeneration: generation, contactId: selection.contactId, sessionId });
    if (this.state.phase === 'waiting' && !receipt) throw new Error('请等实际生成身份确认后再结合新消息。');
    // 已完成生成的本地展示可尚未加载讨论快照；随后仍须回读并核验权威 CURRENT。
    const result = this.state.result;
    const completedInputVersion = result?.assistantSessionId === sessionId && result.input.contactId === selection.contactId
      ? result.inputVersionId : undefined;
    const expected = receipt?.inputVersionId ?? this.state.savedSession?.currentInputVersionId ?? completedInputVersion;
    if (!expected) throw new Error('请先重新读取当前已保存讨论。');
    const pending = new AbortController();
    const current = () => this.messageNotices.isAdoptionCurrent(notice) && operation === this.operation
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
      clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...this.state.skillChoice }, ...sceneSnapshot(this.state.scene || null) };
    const input: ReplyInputSnapshot = mode === 'rewrite_draft'
      ? { contactId: common.contactId, contactDisplayName: common.contactDisplayName, ...sceneSnapshot(this.state.scene || null),
        mode, inputKind: 'workspace', workspaceAction: options.workspaceAction,
        draftText: contacts.draft.trim(),
        userInstruction: null,
        includeRelationshipContext: options.includeRelationshipContext,
        skillChoice: { ...this.state.skillChoice },
        ...(options.contextText?.trim() ? { contextText: options.contextText.trim() } : {}) }
      : mode === 'reply_to_message'
      ? { ...common, mode, target, direction: this.state.direction.trim() }
      : { ...common, mode, purpose: this.state.purpose.trim() };
    if (input.mode === 'rewrite_draft'
      ? !input.draftText && input.workspaceAction !== 'suggest'
      : input.mode === 'reply_to_message' ? !input.direction : !input.purpose) throw new Error('请明确本次想法、方向或目的。');
    const originalInput = saved.turns.find((turn) => turn.inputVersionId === expected)?.input;
    const originalContent = originalInput?.content;
    if (input.mode === 'rewrite_draft' && this.workspaceRequirementInputVersion === expected
      && originalContent?.type === 'rewrite_draft' && originalContent.input_kind === 'workspace') {
      const requirements = originalContent.user_instruction;
      if (requirements !== undefined && requirements !== null && typeof requirements !== 'string') {
        throw new Error('已保存的本次要求无法核验，请重新读取讨论。');
      }
      input.userInstruction = requirements ?? null;
    }
    const adoptNewMessageId = originalContent?.type === mode
      && (mode !== 'rewrite_draft' || originalContent.input_kind === 'workspace')
      && (originalContent.user_instruction ?? '') === (input.userInstruction ?? '')
      && (workspace || (originalInput?.scene ?? null) === (common.scene ?? null)) ? notice.messageId : undefined;
    this.notifyInputChanged();
    this.publish({ messages: { phase: 'ready', items: page.messages, nextCursor: page.nextCursor },
      ...(mode === 'reply_to_message' ? { targetMessageId: target.messageId } : {}) });
    await this.generateInput({ ...selection, newRequest: true }, input, receipt, expected,
      undefined, { notice, messageId: adoptNewMessageId });
  }
  private invalidateInput(): void {
    this.leaveGenerationView();
    this.notifyInputChanged();
    this.lastAttempt = undefined;
    this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
  }
  private notifyInputChanged(): void {
    if (this.pendingContent && this.state.contactId) this.retainedContent.delete(this.state.contactId);
    this.pendingContent = undefined;
    this.restoredRetry = undefined;
    for (const listener of this.inputListeners) listener();
  }
  private cancelMessagePage(): void { ++this.messageOperation; this.messagePending?.abort(); this.messagePending = undefined; }
  private cancelSavedRead(): void { this.savedRead?.abort(); this.savedRead = undefined; }
  private leaveGenerationView(): void {
    this.generationJobs.leaveView(); ++this.operation; this.pending = undefined;
    this.sourceCheck?.abort(); this.sourceCheck = undefined; this.heldResult = undefined;
    if (this.state.sourceAvailability) this.publish({ sourceAvailability: undefined });
  }
  private cancelPending(preserveSourceValidation = false): void {
    ++this.operation; this.pending?.abort(); this.pending = undefined;
    if (this.state.inputBudgetNotice) this.publish({ inputBudgetNotice: undefined });
    if (preserveSourceValidation) return;
    this.sourceCheck?.abort(); this.sourceCheck = undefined; this.heldResult = undefined;
    if (this.state.sourceAvailability) this.publish({ sourceAvailability: undefined });
  }
  private projectionScope(sessionId = this.state.savedSession?.sessionId ?? null): AssistantProjectionScope {
    return { connectionGeneration: this.backend.getConnectionGeneration(), contactId: this.state.contactId,
      scopeRevision: this.state.scopeRevision, sessionId };
  }
  private publish(update: Partial<ReplySessionState>, savedOrigin: 'authoritative' | 'local' = 'local'): void {
    const state = { ...this.state, ...update, revision: this.state.revision + 1 };
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
    this.sessionProjection.registerDisplay({ connectionGeneration: this.backend.getConnectionGeneration(), contactId: state.contactId,
      scopeRevision: state.scopeRevision, sessionId: state.savedSession?.sessionId ?? null }, update.savedSession, savedOrigin);
    this.state = state;
    state.messageNotice = this.messageNotices.setScope(this.projectionScope());
    const previous = this.publishedState;
    const projected = this.projectState();
    this.publishedState = projected;
    const changes: Partial<ReplySessionState> = {};
    for (const key of Object.keys(projected) as (keyof ReplySessionState)[]) {
      if (Object.is(projected[key], previous?.[key])) continue;
      if (key === 'generationJobs' && JSON.stringify(projected[key]) === JSON.stringify(previous?.[key])) continue;
      Object.assign(changes, { [key]: projected[key] });
    }
    if (this.updateListeners.size) {
      const event: ReplyStateUpdate = !previous || previous.contactId !== projected.contactId || previous.scopeRevision !== projected.scopeRevision
        ? { kind: 'snapshot', state: structuredClone(projected) }
        : { kind: 'patch', baseRevision: previous.revision, revision: projected.revision,
          contactId: projected.contactId, scopeRevision: projected.scopeRevision, changes: structuredClone(changes) };
      for (const listener of this.updateListeners) listener(event);
    }
    let snapshot: ReplySessionState | undefined;
    for (const [listener, fields] of this.listeners) {
      if (previous && fields && !fields.some(key => Object.hasOwn(changes, key))) continue;
      snapshot ??= structuredClone(projected);
      listener(snapshot);
    }
  }
}
