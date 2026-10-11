import { randomUUID } from 'node:crypto';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { AssistantSessionDeletion, GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyCorrectionUpdate, ReplyDirectionChoice, ReplyDirectionUpdate, ReplyGenerationBlock, ReplyInputSnapshot, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, ReplySessionState, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { generateReply, replaceReply } from './client';
import type { DirectionExploration, ReplyClarificationAnswer, ReplyClarificationEdit, ReplyRequirementsUpdate, ReplySkillChoice, ReplySkillUpdate } from '../../shared/reply-bridge';
import { actOnExploration, explorationIdentity, openExploration, type ExplorationRequest, type ExplorationAction } from './exploration-client';
import { readReplyMessages } from './messages';
import { readReplyEvidence } from './evidence-read';
import { defaultAssistantSession, deleteAssistantSession, readAssistantSession } from './assistant-sessions';
import { listAssistantSessions, newAssistantSession, selectAssistantSession } from './assistant-session-catalog';
import type { AssistantSessionSelection } from '../../shared/reply-bridge';
import type { ReplyCandidateVersionDisplay, ReplyCandidateVersionEdit, ReplyCandidateVersionRead, ReplyCandidateVersionSelection } from '../../shared/assistant-candidate-versions';
import { AssistantCandidateSourceUnavailable, AssistantCandidateVersionSession } from './assistant-candidate-versions';
import { AssistantGenerationJobs, type OwnedAssistantGeneration, type PendingAssistantGenerationReceipt } from './assistant-generation-jobs';

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
      || this.state.options.tone !== 'original' || this.state.options.includeRelationshipContext);
  }
  private state: ReplySessionState = { revision: 0, scopeRevision: 0, contactId: null, generationBlock: null,
    options: defaults(), mode: 'rewrite_draft', messages: { phase: 'idle', items: [], nextCursor: null },
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
  private automaticExploration: { contactId: string; scopeRevision: number; generation: number;
    sessionId: string; remaining: number; expiresAt: number; queued: boolean } | undefined;
  private automaticExplorationTimer: ReturnType<typeof setTimeout> | undefined;
  private sourceCheck: AbortController | undefined;
  private heldResult: { result: NonNullable<ReplySessionState['result']>; selectedCandidateId: string | null } | undefined;
  private draft = '';
  private operation = 0;
  private pending: AbortController | undefined;
  private readonly generationJobs = new AssistantGenerationJobs();
  private helperHidden = false;
  private lastAttempt: { input: ReplyInputSnapshot; requestKey: string } | undefined;
  private messageOperation = 0;
  private messagePending: AbortController | undefined;
  private noticeStream: AbortController | undefined;
  private noticeVerification: AbortController | undefined;
  private noticeRevision = 0;
  private savedRead: AbortController | undefined;
  private sessionDelete: AbortController | undefined;
  private catalogPending: AbortController | undefined;
  private candidateRestoreOperation = 0;
  private candidateSourceCheck: CandidateSourceCheck | undefined;
  private readonly candidateVersions: AssistantCandidateVersionSession;
  private readonly listeners = new Set<(state: ReplySessionState) => void>();
  private readonly inputListeners = new Set<() => void>();

  constructor(private readonly contacts: ContactSession, private readonly backend: BackendHost,
    private readonly generationBlock: () => ReplyGenerationBlock = () => null) {
    this.candidateVersions = new AssistantCandidateVersionSession(backend);
    this.candidateVersions.onStateChanged((state) => {
      if (state.candidateVersions.sessionId === null) this.candidateRestoreOperation += 1;
      this.publish(state);
    });
    let versionGeneration = backend.getConnectionGeneration();
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation !== versionGeneration) {
        versionGeneration = generation;
        this.publish({ inputBudgetNotice: undefined });
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
    const notice = state.inputBudgetNotice;
    if (notice && (notice.contactId !== state.contactId || notice.scopeRevision !== state.scopeRevision
      || notice.sessionId !== state.savedSession?.sessionId || notice.operation !== this.operation
      || notice.connectionGeneration !== this.backend.getConnectionGeneration())) state.inputBudgetNotice = undefined;
    if (!this.candidateSourceCheck) return state;
    // 完整来源复验期间只隔离现有视图，不另存可恢复正文。
    return { ...state, inputBudgetNotice: undefined, result: null, selectedCandidateId: null, canRetry: false,
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
  onInputChanged(listener: () => void): () => void {
    this.inputListeners.add(listener); return () => this.inputListeners.delete(listener);
  }
  notifyHelperLifecycle(event: 'focused' | 'blurred' | 'hidden' | 'closed'): void {
    if (event === 'hidden' || event === 'closed') {
      this.stopAutomaticExploration();
      const generating = this.strategyJob?.type === 'action' && (this.strategyJob.request.action === 'confirm'
        || this.strategyJob.request.action === 'answer' && Boolean(this.currentExploration?.confirmedIntent));
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
  // 退出调用方接收实际标识后走17的中断协议；hide/close不调用本接口。
  beginGenerationClosing(onReceipt: (receipt: PendingAssistantGenerationReceipt) => void): void {
    this.generationJobs.beginClosing(onReceipt); this.leaveGenerationView();
  }

  async readSavedSession(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.state.sessionDeletion === 'deleting' || this.catalogPending || this.state.sessionCatalog?.selectionPending) return;
    this.candidateRestoreOperation += 1;
    this.savedRead?.abort();
    const pending = new AbortController();
    this.savedRead = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && selection.scopeRevision === this.state.scopeRevision
      && selection.contactId === this.state.contactId && generation === this.backend.getConnectionGeneration();
    const heldSessionId = this.state.savedSession?.sessionId;
    this.publish({ savedSession: { phase: 'loading', sessionId: heldSessionId ?? null, turns: [], inputs: [], currentInputVersionId: null } });
    try {
      const sessionId = heldSessionId ?? (await defaultAssistantSession(this.backend, selection.contactId, pending.signal)).sessionId;
      if (!current()) return;
      let saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (current() && saved.generation === generation) {
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
        this.publish({ savedSession: { sessionId: saved.sessionId, turns: saved.turns, inputs: saved.inputs, currentInputVersionId: saved.currentInputVersionId, phase: 'ready' },
          inputBudgetNotice,
          ...(saved.sessionId !== heldSessionId ? { sessionDeletion: undefined } : {}),
          ...(invalid ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false } : {}) });
        await this.restoreCandidateVersions(selection, saved.sessionId,
          saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []), true);
      }
    } catch (error) {
      if (current()) {
        const unavailable = error instanceof BackendRequestFailure && (error.status === 404 || error.reason === 'source_unavailable');
        if (unavailable) {
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
  async selectSavedSession(selection: AssistantSessionSelection): Promise<void> { await this.switchSavedSession(selection); }
  private async switchSavedSession(selection: ContactSelection & { sessionId?: string }): Promise<void> {
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
      const selected = selection.sessionId
        ? await selectAssistantSession(this.backend, selection.contactId, selection.sessionId, pending.signal)
        : await newAssistantSession(this.backend, selection.contactId, pending.signal);
      if (!current() || selected.generation !== generation) return;
      const saved = await readAssistantSession(this.backend, selection.contactId, selected.sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      this.savedRead?.abort(); this.savedRead = undefined;
      this.candidateSourceCheck?.pending.abort();
      this.lastAttempt = undefined;
      this.invalidateExploration(); this.directionDerived = false;
      this.notifyInputChanged(); this.contacts.clearDraft(selection);
      const items = (previous?.items ?? []).map((item) => ({ ...item, isCurrent: item.sessionId === saved.sessionId }));
      if (!items.some((item) => item.sessionId === saved.sessionId)) items.push({ sessionId: saved.sessionId, isCurrent: true });
      this.candidateVersions.setScope(null); this.candidateSourceCheck = undefined;
      this.publish({ savedSession: { phase: 'ready', sessionId: saved.sessionId, turns: saved.turns,
        inputs: saved.inputs, currentInputVersionId: saved.currentInputVersionId },
        sessionCatalog: { phase: 'ready', items, currentSessionId: saved.sessionId, selectionPending: false },
        sessionDeletion: undefined, confirmedSessionDeletion: undefined,
        options: defaults(), inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        mode: 'rewrite_draft', targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '',
        result: null, selectedCandidateId: null, canRetry: false, phase: 'idle', errorCode: undefined });
      await this.restoreCandidateVersions(selection, saved.sessionId,
        saved.turns.flatMap((turn) => turn.reply?.candidates.map((candidate) => candidate.candidateId) ?? []), true);
    } catch {
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
    this.publish({ sessionDeletion: 'deleting', result: null, selectedCandidateId: null, canRetry: false,
      phase: 'idle', errorCode: undefined, confirmedSessionDeletion: undefined,
      savedSession: { phase: 'idle', sessionId: selection.sessionId, turns: [], inputs: [], currentInputVersionId: null } });
    this.candidateSourceCheck = undefined;
    try {
      const result = await deleteAssistantSession(this.backend, selection.contactId, selection.sessionId, pending.signal);
      if (!current() || result.generation !== generation) return;
      this.contacts.clearDraft(selection);
      this.publish({ sessionDeletion: result.phase, savedSession: { phase: 'idle', sessionId: null, turns: [], inputs: [], currentInputVersionId: null },
        sessionCatalog: undefined,
        options: defaults(), inputClearRevision: (this.state.inputClearRevision ?? 0) + 1,
        confirmedSessionDeletion: { sessionId: selection.sessionId, contactId: selection.contactId,
          scopeRevision: selection.scopeRevision, connectionGeneration: result.generation,
          revision: this.state.revision + 1 },
        mode: 'rewrite_draft', direction: '', purpose: '', correction: '', requirements: '',
        clarificationAnswer: '', targetMessageId: null,
        result: null, selectedCandidateId: null, canRetry: false, phase: 'idle', errorCode: undefined });
    } catch {
      if (current()) this.publish({ sessionDeletion: 'failed' });
    } finally { if (this.sessionDelete === pending) this.sessionDelete = undefined; }
  }

  // 删除检查点只接收主进程已确认的联系人；跨联系人本人资料也可能影响当前依据。
  async revalidateDeletedSource(contactId: string): Promise<void> {
    const owningGeneration = this.backend.getConnectionGeneration();
    if (owningGeneration !== undefined) this.generationJobs.cancelContact(owningGeneration, contactId);
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
    this.heldResult = held;
    const pending = new AbortController();
    this.sourceCheck = pending;
    const current = () => !pending.signal.aborted && this.sourceCheck === pending
      && scopeRevision === this.state.scopeRevision && currentContact === this.state.contactId
      && generation === this.backend.getConnectionGeneration();
    this.publish({ result: null, selectedCandidateId: null, phase: 'idle', canRetry: false,
      errorCode: undefined, sourceAvailability: held ? 'checking' : undefined });
    if (contactId === currentContact) {
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
      this.publish({ result: held.result, selectedCandidateId: held.selectedCandidateId,
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
  }
  async retrySourceValidation(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    if (this.state.sourceAvailability === 'failed') await this.revalidateDeletedSource(selection.contactId);
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
      requirements: this.state.requirements, skill: this.state.skillChoice, changeGroup, automatic });
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
        skill: { ...this.state.skillChoice }, changeGroup, automatic };
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
  private strategySnapshot(selection: ContactSelection): ReplyInputSnapshot {
    const contact = this.contacts.getState().contacts.find((item) => item.contactId === selection.contactId)!;
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName,
      correction: this.state.correction, userInstruction: this.state.requirements, clarificationAnswer: this.state.clarificationAnswer,
      skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) } };
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
    const generation = this.backend.getConnectionGeneration();
    const automaticTask = job.type === 'open' && job.request.automatic ? this.automaticExploration : undefined;
    const current = () => (!(job.type === 'open' && job.request.automatic)
      || Boolean(automaticTask && automaticTask === this.automaticExploration))
      && !pending.signal.aborted && operation === this.explorationOperation
      && scopeRevision === this.state.scopeRevision && job.request.contactId === this.state.contactId
      && job === this.strategyJob && (!this.state.savedSession?.sessionId || job.request.sessionId === this.state.savedSession.sessionId)
      && generation === this.backend.getConnectionGeneration();
    if (job.sourceValidation && generation !== undefined) job.sourceValidation = {
      scope: { contactId: job.request.contactId, scopeRevision, sessionId: job.request.sessionId },
      operation, generation, phase: 'checking', inputs: [],
    };
    this.publish({ exploration: { phase: 'waiting', result: this.state.exploration.result, canRetry: true,
      automaticUpdatesPaused: this.state.exploration.automaticUpdatesPaused } });
    try {
      const result = job.type === 'open' ? await openExploration(this.backend, job.request, pending.signal)
        : await actOnExploration(this.backend, job.request, pending.signal);
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
    } catch {
      if (current()) {
        const automatic = job.type === 'open' && Boolean(job.request.automatic);
        this.publish({ exploration: { phase: 'failed', result: null, canRetry: !automatic,
          automaticUpdatesPaused: automatic } });
        if (automatic) this.stopAutomaticExploration(true);
      }
    } finally {
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
    this.stopAutomaticExploration();
    if (this.state.mode !== 'rewrite_draft' && this.state.exploration.result) {
      const result = this.state.exploration.result;
      const intent = this.state.mode === 'reply_to_message' ? this.state.direction : this.state.purpose;
      if (!intent.trim() || this.state.exploration.phase !== 'ready') return;
      this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
        taskId: result.taskId, inputVersion: result.inputVersion, action: 'confirm', directIntent: intent.trim() },
        input: this.strategySnapshot(selection) };
      await this.runStrategy(this.strategyJob); return;
    }
    if (this.state.mode !== 'rewrite_draft' && this.currentExploration) return;
    const generation = this.backend.getConnectionGeneration();
    const currentSessionId = this.state.savedSession?.sessionId;
    const activeReceipt = generation !== undefined && currentSessionId ? this.generationJobs.requestReceipt({
      connectionGeneration: generation, contactId: selection.contactId, sessionId: currentSessionId,
    }) : undefined;
    if (this.state.phase === 'waiting' && (!selection.newRequest || !activeReceipt)) return;
    const replaceable = activeReceipt?.state === 'completed' ? undefined : activeReceipt;
    const contact = contactState.contacts.find((item) => item.contactId === selection.contactId)!;
    const options = this.state.options;
    const target = this.state.messages.items.find((item) => item.messageId === this.state.targetMessageId);
    if (this.state.mode === 'rewrite_draft' ? !contactState.draft.trim()
      : this.state.mode === 'initiate_conversation' ? !this.state.purpose.trim() : !target || !this.state.direction.trim()) return;
    this.notifyInputChanged();
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName };
    const input: ReplyInputSnapshot = this.state.mode === 'rewrite_draft'
      ? { ...common, mode: 'rewrite_draft', draftText: contactState.draft.trim(),
        userInstruction: [tones[options.tone], options.instruction.trim()].filter(Boolean).join('\n') || null,
        includeRelationshipContext: options.includeRelationshipContext }
      : this.state.mode === 'initiate_conversation'
        ? { ...common, mode: 'initiate_conversation', purpose: this.state.purpose.trim(), correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(), clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) } }
        : { ...common, mode: 'reply_to_message', target: structuredClone(target!), direction: this.state.direction.trim(),
        correction: this.state.correction.trim(), userInstruction: this.state.requirements.trim(), clarificationAnswer: this.state.clarificationAnswer.trim(), skillChoice: { ...(this.generationSkillChoice ?? this.state.skillChoice) } };
    if (selection.newRequest || !this.lastAttempt) this.lastAttempt = { input, requestKey: randomUUID() };
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
        sessionId, requestKey: attempt.requestKey }, pending);
      const ownedJob = job;
      const prepared = (receipt: Parameters<AssistantGenerationJobs['receiveReceipt']>[1]) => {
        this.generationJobs.receiveReceipt(ownedJob, receipt); budgetReceipt = receipt;
      };
      const requested = () => this.generationJobs.requestStarted(ownedJob);
      const result = replaceable && selection.newRequest
        ? await replaceReply(this.backend, attempt.input, attempt.requestKey, replaceable.requestKey, pending.signal, sessionId, prepared, requested)
        : await generateReply(this.backend, attempt.input, attempt.requestKey, pending.signal, sessionId, prepared, requested);
      if (!current() || result.generation !== generation) return;
      // 可靠完成可作为历史读取；只有仍属当前输入且来源有效的结果才可成为当前候选。
      const beforeRead = this.state.savedSession;
      const saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (!current() || saved.generation !== generation) return;
      const completed = saved.turns.find((turn) => turn.inputVersionId === result.inputVersionId);
      const observed = this.state.savedSession;
      // 较晚完整读取优先；只有同一有效CURRENT的完成结果仍可发布。
      const superseded = observed !== beforeRead && !(observed?.phase === 'ready'
        && observed.sessionId === sessionId && observed.currentInputVersionId === result.inputVersionId
        && observed.turns.some((turn) => turn.inputVersionId === result.inputVersionId
          && turn.requestKey === attempt.requestKey && turn.state === 'completed'
          && turn.reply?.replyRequestId === result.replyRequestId)
        && observed.inputs.some((input) => input.inputVersionId === result.inputVersionId && input.state === 'active'));
      if (superseded) {
        this.lastAttempt = undefined;
        this.publish({ phase: this.state.result ? 'ready' : 'idle', canRetry: false,
          errorCode: undefined, inputBudgetNotice: undefined });
        return;
      }
      if (saved.currentInputVersionId !== result.inputVersionId || completed?.state !== 'completed'
        || completed.reply?.replyRequestId !== result.replyRequestId) {
        this.lastAttempt = undefined;
        this.publish({ phase: 'idle', canRetry: false, result: null, selectedCandidateId: null });
        await this.readSavedSession(selection); return;
      }
      this.savedRead?.abort(); this.savedRead = undefined;
      const inputBudgetNotice = result.inputBudget ? { contactId: selection.contactId,
        scopeRevision: selection.scopeRevision, sessionId: result.assistantSessionId, requestKey: attempt.requestKey,
        inputVersionId: result.inputVersionId, connectionGeneration: generation, operation, decision: result.inputBudget } : undefined;
      // 同键重放恢复原结果，保留该候选在本次运行中的编辑和选择。
      if (this.state.result?.replyRequestId === result.replyRequestId) { this.publish({ phase: 'ready', inputBudgetNotice }); return; }
      this.publish({ phase: 'ready', savedSession: observed !== beforeRead ? observed
        : { phase: 'idle', sessionId: result.assistantSessionId, turns: [], inputs: [], currentInputVersionId: null },
      inputBudgetNotice,
      ...(result.assistantSessionId !== this.state.savedSession?.sessionId ? { sessionDeletion: undefined } : {}),
      result: { replyRequestId: result.replyRequestId, assistantSessionId: result.assistantSessionId,
        inputVersionId: result.inputVersionId, input: attempt.input,
        contextEvidenceIds: result.contextEvidenceIds,
        styleSampleIds: result.styleSampleIds,
        usedSkill: result.usedSkill,
        inputBudget: result.inputBudget,
        candidates: result.candidates.map((original) => ({ original, editedText: original.text })) },
      selectedCandidateId: result.candidates[0].candidateId });
      await this.restoreCandidateVersions(selection, result.assistantSessionId,
        result.candidates.map((candidate) => candidate.candidateId));
    } catch (error) {
      if (current()) {
        const failure = error instanceof BackendRequestFailure ? error : undefined;
        const budgetFailure = failure?.code === 'input_budget_exceeded' || failure?.code === 'input_budget_unavailable';
        if (budgetFailure) {
          const receipt = budgetReceipt;
          const beforeRead = this.state.savedSession;
          let saved: Awaited<ReturnType<typeof readAssistantSession>> | undefined;
          let readFailure: BackendRequestFailure | 'unavailable' | undefined;
          try {
            if (receipt && failure?.inputBudget) {
              saved = await readAssistantSession(this.backend, selection.contactId, receipt.sessionId, pending.signal);
            }
          } catch (error) {
            readFailure = error instanceof BackendRequestFailure ? error : 'unavailable';
          }
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
          const sourceUnavailable = readFailure instanceof BackendRequestFailure
            && (readFailure.status === 404 || readFailure.reason === 'source_unavailable');
          if (!saved && readFailure && receipt && failure?.inputBudget && !superseded && !sourceUnavailable) {
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
          : failure?.code === 'reply_timeout' ? 'timeout'
          : failure?.code === 'assistant_session_save_failed' ? 'save_failed'
          : failure?.reason === 'target_message_unavailable' ? 'target_unavailable'
          : failure?.reason === 'source_unavailable' ? 'source_unavailable'
          : ['reply_rejected', 'assistant_session_rejected'].includes(failure?.code ?? '') ? 'rejected'
          : ['reply_unavailable', 'runtime_stopping'].includes(failure?.code ?? '') ? 'unavailable' : 'generation_failed';
        this.publish({ phase: 'failed', errorCode, ...(budgetFailure ? { canRetry: false } : {}),
          inputBudgetNotice: budgetReceipt && failure?.inputBudget && generation !== undefined ? {
            contactId: selection.contactId, scopeRevision: selection.scopeRevision, sessionId: budgetReceipt.sessionId,
            requestKey: budgetReceipt.requestKey, inputVersionId: budgetReceipt.inputVersionId,
            connectionGeneration: generation, operation, decision: failure.inputBudget,
          } : undefined });
      }
    } finally { if (job) this.generationJobs.finish(job); if (this.pending === pending) this.pending = undefined; }
  }

  selectCandidate(selection: ReplyCandidateSelection): ReplySessionState {
    this.assertCandidate(selection);
    this.notifyInputChanged();
    this.publish({ selectedCandidateId: selection.candidateId });
    return this.getState();
  }
  editCandidate(edit: ReplyCandidateEdit): ReplySessionState {
    const candidate = this.assertCandidate(edit);
    this.notifyInputChanged();
    candidate.editedText = edit.text;
    this.publish({});
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
    try { await this.candidateVersions.save(edit, current); }
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
    if (this.state.sessionDeletion === 'deleting' || this.state.sessionDeletion === 'failed') {
      throw new Error('请先核对当前助手会话的删除结果。');
    }
    if (this.candidateSourceCheck) throw new Error('请等待相关来源核验完成。');
    if (this.catalogPending || this.state.sessionCatalog?.selectionPending) {
      throw new Error('请刷新会话列表并明确选择本次助手会话。');
    }
  }
  private receiveContact(state: ContactSessionState): void {
    if (state.scopeRevision !== this.state.scopeRevision || state.selectedContactId !== this.state.contactId) {
      const generation = this.backend.getConnectionGeneration();
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
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.selectedContactId,
        options: defaults(), mode: 'rewrite_draft', messages: { phase: 'idle', items: [], nextCursor: null },
        messageNotice: { phase: 'idle', changed: false, needsRefresh: false },
        targetMessageId: null, direction: '', purpose: '', correction: '', requirements: '', clarificationAnswer: '', skillChoice: { mode: 'auto', versionId: null }, skillChoices: [], exploration: { phase: 'idle', result: null },
        phase: 'idle', errorCode: undefined, result: null, selectedCandidateId: null, canRetry: false,
        savedSession: { phase: 'idle', sessionId: null, turns: [], inputs: [], currentInputVersionId: null }, sessionDeletion: undefined,
        sessionCatalog: undefined,
        confirmedSessionDeletion: undefined });
      this.candidateSourceCheck = undefined;
      this.beginMessageNotice();
      // 新连接重新选择联系人后只读取已保存讨论，不恢复本次输入或触发生成。
      if (state.selectedContactId && state.directoryPhase === 'ready') {
        void this.readSavedSession({ contactId: state.selectedContactId, scopeRevision: state.scopeRevision });
      }
    } else if (state.draft !== this.draft) {
      this.draft = state.draft;
      this.cancelPending();
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
        if (!current() || event.contactId !== contactId
          || this.state.messageNotice.changed && !this.automaticExploration) return;
        const revision = ++this.noticeRevision;
        this.noticeVerification?.abort();
        const verification = new AbortController();
        this.noticeVerification = verification;
        // 事件只含标识；用当前认证联系人真实的有界消息投影确认归属，不猜缺失范围。
        void readReplyMessages(this.backend, contactId, null, verification.signal).then((page) => {
          if (!current() || verification.signal.aborted || revision !== this.noticeRevision || page.generation !== generation) return;
          if (page.messages.some((message) => message.messageId === event.messageId)) {
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
    this.invalidateExploration(preserveExploration);
    this.notifyInputChanged();
    this.cancelPending(); this.lastAttempt = undefined;
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
    if (!preserveAutomatic) this.stopAutomaticExploration();
    for (const listener of this.inputListeners) listener();
  }
  private cancelMessagePage(): void { ++this.messageOperation; this.messagePending?.abort(); this.messagePending = undefined; }
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
  private publish(update: Partial<ReplySessionState>): void {
    const state = { ...this.state, ...update, revision: this.state.revision + 1 };
    if (this.state.inputBudgetNotice && !state.inputBudgetNotice
      && (state.errorCode === 'input_budget_exceeded' || state.errorCode === 'input_budget_unavailable')) {
      this.lastAttempt = undefined;
      state.errorCode = undefined; state.canRetry = false;
      if (state.phase === 'failed') state.phase = state.result ? 'ready' : 'idle';
    }
    this.state = state;
    for (const listener of this.listeners) listener(this.getState());
  }
}
