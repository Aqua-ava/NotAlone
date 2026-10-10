import { randomUUID } from 'node:crypto';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyCorrectionUpdate, ReplyDirectionChoice, ReplyDirectionUpdate, ReplyGenerationBlock, ReplyInputSnapshot, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, ReplySessionState, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { generateReply } from './client';
import type { DirectionExploration, ReplyClarificationAnswer, ReplyRequirementsUpdate, ReplySkillChoice, ReplySkillUpdate } from '../../shared/reply-bridge';
import { actOnExploration, explorationIdentity, openExploration, type ExplorationRequest, type ExplorationAction } from './exploration-client';
import { readReplyMessages } from './messages';
import { readReplyEvidence } from './evidence-read';
import { defaultAssistantSession, readAssistantSession } from './assistant-sessions';

const defaults = () => ({ tone: 'original' as const, instruction: '', includeRelationshipContext: false });
const tones = { original: '', warm: '本次语气自然温和。', concise: '本次表达简洁直接。', polite: '本次语气礼貌克制。' };

type StrategyJob = { type: 'open'; request: ExplorationRequest; signature: string; input: ReplyInputSnapshot }
  | { type: 'action'; request: ExplorationAction; input: ReplyInputSnapshot };

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
  private sourceCheck: AbortController | undefined;
  private heldResult: { result: NonNullable<ReplySessionState['result']>; selectedCandidateId: string | null } | undefined;
  private draft = '';
  private operation = 0;
  private pending: AbortController | undefined;
  private lastAttempt: { input: ReplyInputSnapshot; requestKey: string } | undefined;
  private messageOperation = 0;
  private messagePending: AbortController | undefined;
  private noticeStream: AbortController | undefined;
  private noticeVerification: AbortController | undefined;
  private noticeRevision = 0;
  private savedRead: AbortController | undefined;
  private readonly listeners = new Set<(state: ReplySessionState) => void>();
  private readonly inputListeners = new Set<() => void>();

  constructor(private readonly contacts: ContactSession, private readonly backend: BackendHost,
    private readonly generationBlock: () => ReplyGenerationBlock = () => null) {
    this.state.generationBlock = generationBlock();
    contacts.onStateChanged((state) => this.receiveContact(state));
    this.receiveContact(contacts.getState());
  }
  getState(): ReplySessionState { return structuredClone(this.state); }
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

  async readSavedSession(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
    this.savedRead?.abort();
    const pending = new AbortController();
    this.savedRead = pending;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && selection.scopeRevision === this.state.scopeRevision
      && selection.contactId === this.state.contactId && generation === this.backend.getConnectionGeneration();
    const heldSessionId = this.state.savedSession?.sessionId;
    this.publish({ savedSession: { phase: 'loading', sessionId: heldSessionId ?? null, turns: [] } });
    try {
      const sessionId = heldSessionId ?? (await defaultAssistantSession(this.backend, selection.contactId, pending.signal)).sessionId;
      if (!current()) return;
      const saved = await readAssistantSession(this.backend, selection.contactId, sessionId, pending.signal);
      if (current() && saved.generation === generation) {
        const heldVersion = (this.state.result ?? this.heldResult?.result)?.inputVersionId;
        const invalid = heldVersion && saved.turns.some((turn) => turn.inputVersionId === heldVersion
          && ['redacted', 'unavailable'].includes(turn.state));
        if (invalid) { this.cancelPending(); this.lastAttempt = undefined; }
        this.publish({ savedSession: { sessionId: saved.sessionId, turns: saved.turns, phase: 'ready' },
          ...(invalid ? { result: null, selectedCandidateId: null, phase: 'idle', canRetry: false } : {}) });
      }
    } catch {
      if (current()) this.publish({ savedSession: { phase: 'failed', sessionId: heldSessionId ?? null, turns: [] } });
    } finally { if (this.savedRead === pending) this.savedRead = undefined; }
  }

  // 删除检查点只接收主进程已确认的联系人；跨联系人本人资料也可能影响当前依据。
  async revalidateDeletedSource(contactId: string): Promise<void> {
    this.invalidateExploration();
    this.savedRead?.abort();
    this.savedRead = undefined;
    if (this.state.savedSession) this.publish({ savedSession: { ...this.state.savedSession, phase: 'idle', turns: [] } });
    const held = this.heldResult ?? (this.state.result ? {
      result: this.state.result, selectedCandidateId: this.state.selectedCandidateId,
    } : undefined);
    this.cancelPending();
    this.lastAttempt = undefined;
    const operation = this.operation;
    const scopeRevision = this.state.scopeRevision;
    const currentContact = this.state.contactId;
    const generation = this.backend.getConnectionGeneration();
    this.heldResult = held;
    const pending = new AbortController();
    this.sourceCheck = pending;
    const current = () => !pending.signal.aborted && operation === this.operation
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
      if (!update.direction.trim()) this.directionDerived = false;
      this.invalidateInput(); this.publish({ direction: update.direction });
    }
    return this.getState();
  }
  updatePurpose(update: import('../../shared/reply-bridge').ReplyPurposeUpdate): ReplySessionState {
    this.assertScope(update);
    if (this.state.mode !== 'initiate_conversation') throw new Error('请先选择主动聊聊。');
    if (update.purpose !== this.state.purpose) {
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

  async explore(selection: ContactSelection, changeGroup = false): Promise<void> {
    this.assertScope(selection); this.refreshGenerationEligibility();
    if (this.state.generationBlock || this.state.mode === 'rewrite_draft' || this.state.phase === 'waiting'
      || this.state.exploration.phase === 'waiting' || this.state.mode === 'reply_to_message' && !this.state.targetMessageId) return;
    const signature = JSON.stringify({ mode: this.state.mode, target: this.state.targetMessageId,
      purpose: this.explorationPurpose ?? this.state.purpose, correction: this.state.correction,
      requirements: this.state.requirements, skill: this.state.skillChoice, changeGroup });
    if (this.strategyJob?.type === 'open' && this.strategyJob.signature === signature && this.state.exploration.phase === 'failed') {
      await this.runStrategy(this.strategyJob); return;
    }
    const generation = this.backend.getConnectionGeneration();
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
        skill: { ...this.state.skillChoice }, changeGroup };
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
    this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
      taskId: result.taskId, inputVersion: result.inputVersion, action: 'confirm', suggestionId: option.suggestionId },
      input: this.strategySnapshot(selection) };
    await this.runStrategy(this.strategyJob);
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
    this.strategyJob = { type: 'action', request: { contactId: selection.contactId, sessionId: result.sessionId,
      taskId: result.taskId, inputVersion: result.inputVersion, action: 'stop' }, input: this.strategySnapshot(selection) };
    await this.runStrategy(this.strategyJob);
  }
  async retryExploration(selection: ContactSelection): Promise<void> {
    this.assertScope(selection);
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
    if (this.state.generationBlock) return;
    this.notifyInputChanged(); this.cancelPending(); this.lastAttempt = undefined;
    this.explorationPending?.abort();
    const pending = new AbortController(); this.explorationPending = pending;
    const operation = ++this.explorationOperation, scopeRevision = this.state.scopeRevision;
    const generation = this.backend.getConnectionGeneration();
    const current = () => !pending.signal.aborted && operation === this.explorationOperation
      && scopeRevision === this.state.scopeRevision && job.request.contactId === this.state.contactId
      && generation === this.backend.getConnectionGeneration();
    this.publish({ exploration: { phase: 'waiting', result: this.state.exploration.result, canRetry: true } });
    try {
      const result = job.type === 'open' ? await openExploration(this.backend, job.request, pending.signal)
        : await actOnExploration(this.backend, job.request, pending.signal);
      if (!current() || result.generation !== generation) return;
      if (result.kind === 'exploration') {
        this.currentExploration = result.result;
        this.generationSkillChoice = result.result.usedSkill
          ? { mode: 'user', versionId: result.result.usedSkill.versionId } : { mode: 'disabled', versionId: null };
        const confirmed = result.result.confirmedIntent;
        if (confirmed) this.directionDerived = true;
        this.publish({ exploration: { phase: 'ready', result: result.result, canRetry: true },
          savedSession: { phase: 'idle', sessionId: result.result.sessionId, turns: [] }, skillChoices: result.result.skillChoices,
          ...(confirmed ? this.state.mode === 'reply_to_message' ? { direction: confirmed } : { purpose: confirmed } : {}) });
      } else if (result.kind === 'paused') {
        this.currentExploration = undefined; this.explorationPurpose = undefined;
        this.publish({ exploration: { phase: 'paused', result: null, canRetry: false } });
      } else {
        this.currentExploration = undefined; this.explorationPurpose = undefined;
        const input = job.input.mode === 'rewrite_draft' ? job.input : job.input.mode === 'reply_to_message'
          ? { ...job.input, direction: result.confirmedIntent } : { ...job.input, purpose: result.confirmedIntent };
        this.directionDerived = true;
        this.publish({ exploration: { phase: 'ready', result: null, canRetry: true }, phase: 'ready', errorCode: undefined,
          savedSession: { phase: 'idle', sessionId: result.reply.assistantSessionId, turns: [] },
          ...(input.mode === 'reply_to_message' ? { direction: input.direction } : input.mode === 'initiate_conversation' ? { purpose: input.purpose } : {}) });
        if (this.state.result?.replyRequestId !== result.reply.replyRequestId) this.publish({ result: {
          ...result.reply, input, candidates: result.reply.candidates.map((original) => ({ original, editedText: original.text })) },
          selectedCandidateId: result.reply.candidates[0].candidateId });
      }
    } catch { if (current()) this.publish({ exploration: { phase: 'failed', result: null, canRetry: true } }); }
    finally { if (this.explorationPending === pending) this.explorationPending = undefined; }
  }

  async generate(selection: GenerateReply): Promise<void> {
    const contactState = this.assertScope(selection);
    this.refreshGenerationEligibility();
    if (this.state.generationBlock) throw new Error('请先确认本次联系人。');
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
    if (this.state.phase === 'waiting') return;
    const generation = this.backend.getConnectionGeneration();
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
    this.cancelPending();
    const operation = this.operation;
    const pending = new AbortController();
    this.pending = pending;
    const current = () => operation === this.operation && generation === this.backend.getConnectionGeneration()
      && selection.scopeRevision === this.state.scopeRevision && selection.contactId === this.state.contactId;
    this.publish({ phase: 'waiting', errorCode: undefined, canRetry: true });
    try {
      const result = await generateReply(this.backend, attempt.input, attempt.requestKey, pending.signal,
        this.state.savedSession?.sessionId ?? undefined);
      if (!current() || result.generation !== generation) return;
      // 同键重放恢复原结果，保留该候选在本次运行中的编辑和选择。
      if (this.state.result?.replyRequestId === result.replyRequestId) { this.publish({ phase: 'ready' }); return; }
      this.publish({ phase: 'ready', savedSession: { phase: 'idle', sessionId: result.assistantSessionId, turns: [] },
      result: { replyRequestId: result.replyRequestId, assistantSessionId: result.assistantSessionId,
        inputVersionId: result.inputVersionId, input: attempt.input,
        contextEvidenceIds: result.contextEvidenceIds,
        styleSampleIds: result.styleSampleIds,
        usedSkill: result.usedSkill,
        candidates: result.candidates.map((original) => ({ original, editedText: original.text })) },
      selectedCandidateId: result.candidates[0].candidateId });
    } catch (error) {
      if (current()) {
        const failure = error instanceof BackendRequestFailure ? error : undefined;
        const errorCode = failure?.kind === 'connection' ? 'connection'
          : failure?.code === 'reply_timeout' ? 'timeout'
          : failure?.code === 'assistant_session_save_failed' ? 'save_failed'
          : failure?.reason === 'target_message_unavailable' ? 'target_unavailable'
          : failure?.reason === 'source_unavailable' ? 'source_unavailable'
          : ['reply_rejected', 'assistant_session_rejected'].includes(failure?.code ?? '') ? 'rejected'
          : ['reply_unavailable', 'runtime_stopping'].includes(failure?.code ?? '') ? 'unavailable' : 'generation_failed';
        this.publish({ phase: 'failed', errorCode });
      }
    } finally { if (this.pending === pending) this.pending = undefined; }
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
  private assertCandidate(selection: ReplyCandidateSelection) {
    this.assertScope(selection);
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
  private receiveContact(state: ContactSessionState): void {
    if (state.scopeRevision !== this.state.scopeRevision || state.selectedContactId !== this.state.contactId) {
      this.savedRead?.abort(); this.savedRead = undefined;
      this.noticeStream?.abort(); this.noticeVerification?.abort();
      this.noticeStream = undefined; this.noticeVerification = undefined;
      this.cancelPending();
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
        savedSession: { phase: 'idle', sessionId: null, turns: [] } });
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
        this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'interrupted' } });
      } },
      message: (event) => {
        if (!current() || event.contactId !== contactId || this.state.messageNotice.changed) return;
        const revision = ++this.noticeRevision;
        this.noticeVerification?.abort();
        const verification = new AbortController();
        this.noticeVerification = verification;
        // 事件只含标识；用当前认证联系人真实的有界消息投影确认归属，不猜缺失范围。
        void readReplyMessages(this.backend, contactId, null, verification.signal).then((page) => {
          if (!current() || verification.signal.aborted || revision !== this.noticeRevision || page.generation !== generation) return;
          if (page.messages.some((message) => message.messageId === event.messageId)) {
            this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'connected', changed: true } });
          }
        }).catch(() => {
          if (current() && !verification.signal.aborted) this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'interrupted' } });
        }).finally(() => { if (this.noticeVerification === verification) this.noticeVerification = undefined; });
      },
    }, pending.signal);
  }
  private invalidateInput(preserveExploration = false): void {
    this.invalidateExploration(preserveExploration);
    this.notifyInputChanged();
    this.cancelPending(); this.lastAttempt = undefined;
    this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
  }
  private invalidateExploration(preserve = false): void {
    this.strategyJob = undefined;
    if (!preserve) { this.currentExploration = undefined; this.explorationPurpose = undefined; this.generationSkillChoice = undefined; }
    ++this.explorationOperation;
    this.explorationPending?.abort(); this.explorationPending = undefined;
    this.publish({ exploration: { phase: 'idle', result: null }, clarificationAnswer: '' });
  }
  private notifyInputChanged(): void {
    for (const listener of this.inputListeners) listener();
  }
  private cancelMessagePage(): void { ++this.messageOperation; this.messagePending?.abort(); this.messagePending = undefined; }
  private cancelPending(): void {
    ++this.operation; this.pending?.abort(); this.pending = undefined;
    this.sourceCheck?.abort(); this.sourceCheck = undefined; this.heldResult = undefined;
    if (this.state.sourceAvailability) this.publish({ sourceAvailability: undefined });
  }
  private publish(update: Partial<ReplySessionState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
