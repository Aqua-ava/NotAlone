import { randomUUID } from 'node:crypto';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { GenerateReply, ReplyCandidateEdit, ReplyCandidateSelection, ReplyDirectionUpdate, ReplyInputSnapshot, ReplyMessagePageRequest, ReplyMessageSelection, ReplyModeUpdate, ReplySessionState, RewriteOptionsUpdate } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { generateReply } from './client';
import { readReplyMessages } from './messages';

const defaults = () => ({ tone: 'original' as const, instruction: '', includeRelationshipContext: false });
const tones = { original: '', warm: '本次语气自然温和。', concise: '本次表达简洁直接。', polite: '本次语气礼貌克制。' };

// 本次编辑只在主进程内存保留；原始候选和编辑稿分别保存。
export class ReplySession {
  private state: ReplySessionState = { revision: 0, scopeRevision: 0, contactId: null,
    options: defaults(), mode: 'rewrite_draft', messages: { phase: 'idle', items: [], nextCursor: null },
    messageNotice: { phase: 'idle', changed: false },
    targetMessageId: null, direction: '', phase: 'idle', result: null, selectedCandidateId: null, canRetry: false };
  private draft = '';
  private operation = 0;
  private pending: AbortController | undefined;
  private lastAttempt: { input: ReplyInputSnapshot; requestKey: string } | undefined;
  private messageOperation = 0;
  private messagePending: AbortController | undefined;
  private noticeStream: AbortController | undefined;
  private noticeVerification: AbortController | undefined;
  private noticeRevision = 0;
  private readonly listeners = new Set<(state: ReplySessionState) => void>();

  constructor(private readonly contacts: ContactSession, private readonly backend: BackendHost) {
    contacts.onStateChanged((state) => this.receiveContact(state));
    this.receiveContact(contacts.getState());
  }
  getState(): ReplySessionState { return structuredClone(this.state); }
  onStateChanged(listener: (state: ReplySessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateOptions(update: RewriteOptionsUpdate): ReplySessionState {
    this.assertScope(update);
    if (JSON.stringify(update.options) !== JSON.stringify(this.state.options)) {
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
    if (this.state.mode !== 'reply_to_message' || this.state.messages.phase === 'loading') return;
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
      this.invalidateInput(); this.publish({ targetMessageId: selection.messageId });
    }
    return this.getState();
  }
  updateDirection(update: ReplyDirectionUpdate): ReplySessionState {
    this.assertScope(update);
    if (this.state.mode !== 'reply_to_message') throw new Error('请先切换到回复模式。');
    if (update.direction !== this.state.direction) {
      this.invalidateInput(); this.publish({ direction: update.direction });
    }
    return this.getState();
  }

  async generate(selection: GenerateReply): Promise<void> {
    const contactState = this.assertScope(selection);
    if (this.state.phase === 'waiting') return;
    const generation = this.backend.getConnectionGeneration();
    const contact = contactState.contacts.find((item) => item.contactId === selection.contactId)!;
    const options = this.state.options;
    const target = this.state.messages.items.find((item) => item.messageId === this.state.targetMessageId);
    if (this.state.mode === 'rewrite_draft' ? !contactState.draft.trim() : !target || !this.state.direction.trim()) return;
    const common = { contactId: selection.contactId, contactDisplayName: contact.displayName };
    const input: ReplyInputSnapshot = this.state.mode === 'rewrite_draft'
      ? { ...common, mode: 'rewrite_draft', draftText: contactState.draft.trim(),
        userInstruction: [tones[options.tone], options.instruction.trim()].filter(Boolean).join('\n') || null,
        includeRelationshipContext: options.includeRelationshipContext }
      : { ...common, mode: 'reply_to_message', target: structuredClone(target!), direction: this.state.direction.trim() };
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
      const result = await generateReply(this.backend, attempt.input, attempt.requestKey, pending.signal);
      if (!current() || result.generation !== generation) return;
      // 同键重放恢复原结果，保留该候选在本次运行中的编辑和选择。
      if (this.state.result?.replyRequestId === result.replyRequestId) { this.publish({ phase: 'ready' }); return; }
      this.publish({ phase: 'ready', result: { replyRequestId: result.replyRequestId, input: attempt.input,
        contextEvidenceIds: result.contextEvidenceIds,
        candidates: result.candidates.map((original) => ({ original, editedText: original.text })) },
      selectedCandidateId: result.candidates[0].candidateId });
    } catch (error) {
      if (current()) {
        const failure = error instanceof BackendRequestFailure ? error : undefined;
        const errorCode = failure?.kind === 'connection' ? 'connection'
          : failure?.code === 'reply_timeout' ? 'timeout'
          : failure?.code === 'reply_rejected' ? 'rejected'
          : ['reply_unavailable', 'runtime_stopping'].includes(failure?.code ?? '') ? 'unavailable' : 'generation_failed';
        this.publish({ phase: 'failed', errorCode });
      }
    } finally { if (this.pending === pending) this.pending = undefined; }
  }

  selectCandidate(selection: ReplyCandidateSelection): ReplySessionState {
    this.assertCandidate(selection);
    this.publish({ selectedCandidateId: selection.candidateId });
    return this.getState();
  }
  editCandidate(edit: ReplyCandidateEdit): ReplySessionState {
    const candidate = this.assertCandidate(edit);
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
      this.noticeStream?.abort(); this.noticeVerification?.abort();
      this.noticeStream = undefined; this.noticeVerification = undefined;
      this.cancelPending();
      this.cancelMessagePage();
      this.lastAttempt = undefined;
      this.draft = state.draft;
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.selectedContactId,
        options: defaults(), mode: 'rewrite_draft', messages: { phase: 'idle', items: [], nextCursor: null },
        messageNotice: { phase: 'idle', changed: false },
        targetMessageId: null, direction: '', phase: 'idle', errorCode: undefined, result: null, selectedCandidateId: null, canRetry: false });
      this.beginMessageNotice();
    } else if (state.draft !== this.draft) {
      this.draft = state.draft;
      this.cancelPending();
      this.lastAttempt = undefined;
      this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
    }
  }
  private beginMessageNotice(): void {
    const contactId = this.state.contactId;
    const scopeRevision = this.state.scopeRevision;
    const generation = this.backend.getConnectionGeneration();
    if (!contactId || generation === undefined) return;
    const pending = new AbortController();
    this.noticeStream = pending;
    const current = () => !pending.signal.aborted && contactId === this.state.contactId
      && scopeRevision === this.state.scopeRevision && generation === this.backend.getConnectionGeneration();
    this.publish({ messageNotice: { phase: 'connecting', changed: false } });
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
            this.publish({ messageNotice: { phase: 'connected', changed: true } });
          }
        }).catch(() => {
          if (current() && !verification.signal.aborted) this.publish({ messageNotice: { ...this.state.messageNotice, phase: 'interrupted' } });
        }).finally(() => { if (this.noticeVerification === verification) this.noticeVerification = undefined; });
      },
    }, pending.signal);
  }
  private invalidateInput(): void {
    this.cancelPending(); this.lastAttempt = undefined;
    this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
  }
  private cancelMessagePage(): void { ++this.messageOperation; this.messagePending?.abort(); this.messagePending = undefined; }
  private cancelPending(): void { ++this.operation; this.pending?.abort(); this.pending = undefined; }
  private publish(update: Partial<ReplySessionState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
