import { randomUUID } from 'node:crypto';
import type { ContactSelection, ContactSessionState } from '../../shared/contact-session-bridge';
import type { GenerateRewrite, ReplyCandidateEdit, ReplyCandidateSelection, ReplySessionState, RewriteOptionsUpdate, RewriteSnapshot } from '../../shared/reply-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { generateRewrite } from './client';

const defaults = () => ({ tone: 'original' as const, instruction: '', includeRelationshipContext: false });
const tones = { original: '', warm: '本次语气自然温和。', concise: '本次表达简洁直接。', polite: '本次语气礼貌克制。' };

// 本次编辑只在主进程内存保留；原始候选和编辑稿分别保存。
export class ReplySession {
  private state: ReplySessionState = { revision: 0, scopeRevision: 0, contactId: null,
    options: defaults(), phase: 'idle', result: null, selectedCandidateId: null, canRetry: false };
  private draft = '';
  private operation = 0;
  private pending: AbortController | undefined;
  private lastAttempt: { input: RewriteSnapshot; requestKey: string } | undefined;
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

  async generate(selection: GenerateRewrite): Promise<void> {
    const contactState = this.assertScope(selection);
    if (this.state.phase === 'waiting' || !contactState.draft.trim()) return;
    const generation = this.backend.getConnectionGeneration();
    const contact = contactState.contacts.find((item) => item.contactId === selection.contactId)!;
    const options = this.state.options;
    const input = { contactId: selection.contactId, contactDisplayName: contact.displayName,
      draftText: contactState.draft.trim(),
      userInstruction: [tones[options.tone], options.instruction.trim()].filter(Boolean).join('\n') || null,
      includeRelationshipContext: options.includeRelationshipContext };
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
      const result = await generateRewrite(this.backend, attempt.input, attempt.requestKey, pending.signal);
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
      this.cancelPending();
      this.lastAttempt = undefined;
      this.draft = state.draft;
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.selectedContactId,
        options: defaults(), phase: 'idle', errorCode: undefined, result: null, selectedCandidateId: null, canRetry: false });
    } else if (state.draft !== this.draft) {
      this.draft = state.draft;
      this.cancelPending();
      this.lastAttempt = undefined;
      this.publish({ phase: this.state.result ? 'ready' : 'idle', errorCode: undefined, canRetry: false });
    }
  }
  private cancelPending(): void { ++this.operation; this.pending?.abort(); this.pending = undefined; }
  private publish(update: Partial<ReplySessionState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
