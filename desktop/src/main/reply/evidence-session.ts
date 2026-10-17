import type { ReplyCandidateSelection, ReplySessionState } from '../../shared/reply-bridge';
import type { ReplyEvidenceState } from '../../shared/reply-evidence';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ReplySession } from './session';
import { readReplyEvidence } from './evidence-read';

export class ReplyEvidenceSession {
  private state: ReplyEvidenceState = { revision: 0, scopeRevision: 0, contactId: null, replyRequestId: null, candidateId: null, phase: 'idle', items: [] };
  private operation = 0;
  private pending: AbortController | undefined;
  private generation: number | undefined;
  private readonly listeners = new Set<(state: ReplyEvidenceState) => void>();
  constructor(private readonly backend: BackendHost, private readonly replies: ReplySession) {
    replies.onStateChanged((state) => this.receive(state));
    this.receive(replies.getState());
  }
  getState(): ReplyEvidenceState { return structuredClone(this.state); }
  onStateChanged(listener: (state: ReplyEvidenceState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close(selection: ReplyCandidateSelection): void { this.assertCandidate(selection); this.cancel(); this.publish({ candidateId: null, phase: 'idle', items: [], basisChanges: undefined, retrieval: undefined, layeredContext: undefined, layeredStatus: undefined, layeredScenarioReads: undefined }); }
  async load(selection: ReplyCandidateSelection): Promise<void> {
    this.assertCandidate(selection);
    this.cancel();
    const operation = this.operation;
    const generation = this.backend.getConnectionGeneration();
    const pending = new AbortController(); this.pending = pending;
    const current = () => operation === this.operation && generation === this.backend.getConnectionGeneration()
      && this.state.scopeRevision === selection.scopeRevision && this.state.contactId === selection.contactId
      && this.state.replyRequestId === selection.replyRequestId;
    this.publish({ candidateId: selection.candidateId, phase: 'loading', items: [], basisChanges: undefined, retrieval: undefined, layeredContext: undefined, layeredStatus: undefined, layeredScenarioReads: undefined });
    try {
      const result = await readReplyEvidence(this.backend, selection.contactId, selection.replyRequestId, pending.signal);
      if (current() && result.generation === generation) this.publish({ phase: 'ready', items: result.items, basisChanges: result.basisChanges, retrieval: result.retrieval, layeredContext: result.layeredContext, layeredStatus: result.layeredStatus, layeredScenarioReads: result.layeredScenarioReads });
    } catch (error) {
      if (current()) this.publish({ phase: error instanceof BackendRequestFailure && error.status === 404 ? 'missing' : 'failed', items: [], basisChanges: undefined, retrieval: undefined, layeredContext: undefined, layeredStatus: undefined, layeredScenarioReads: undefined });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private assertCandidate(selection: ReplyCandidateSelection): void {
    const state = this.replies.getState();
    if (this.backend.getConnectionGeneration() === undefined || state.phase === 'waiting'
      || state.contactId !== selection.contactId || state.scopeRevision !== selection.scopeRevision
      || state.result?.replyRequestId !== selection.replyRequestId
      || !state.result.candidates.some(({ original }) => original.candidateId === selection.candidateId)) throw new Error('候选依据已失效。');
  }
  private receive(state: ReplySessionState): void {
    const generation = this.backend.getConnectionGeneration();
    const requestId = state.phase === 'waiting' ? null : state.result?.replyRequestId ?? null;
    if (generation !== this.generation || state.scopeRevision !== this.state.scopeRevision
      || state.contactId !== this.state.contactId || requestId !== this.state.replyRequestId) {
      this.cancel(); this.generation = generation;
      this.publish({ scopeRevision: state.scopeRevision, contactId: state.contactId, replyRequestId: requestId, candidateId: null, phase: 'idle', items: [], basisChanges: undefined, retrieval: undefined, layeredContext: undefined, layeredStatus: undefined, layeredScenarioReads: undefined });
    }
  }
  private cancel() { ++this.operation; this.pending?.abort(); this.pending = undefined; }
  private publish(update: Partial<ReplyEvidenceState>) {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
