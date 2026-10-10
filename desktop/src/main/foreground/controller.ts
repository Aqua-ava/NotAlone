import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { initialForegroundState, type ForegroundState, type ForegroundConfirmation, type GenerationBlock } from '../../shared/foreground-bridge';
import { foregroundObservation } from './observation';

type Flight = { abort: AbortController; promise: Promise<void> };

// 新观察只在可信show之前触发；页面不能声明焦点或调用任意定位请求。
export class ForegroundController {
  private state: ForegroundState = { ...initialForegroundState };
  private epoch = 0;
  private disposed = false;
  private flight: Flight | undefined;
  private generation: number | undefined;
  private scopeRevision: number;
  private draft: string;
  private readingScopeChanges = 0;
  private qualification: { generation: number; scopeRevision: number; contactId: string;
    kind: 'manual-confirmed' | 'verified-binding' } | undefined;
  private hasReplyEdits: () => boolean = () => true;
  private readonly listeners = new Set<(state: ForegroundState) => void>();
  private readonly unsubscribe: (() => void)[];
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    this.generation = backend.getConnectionGeneration();
    const contact = contacts.getState();
    this.scopeRevision = contact.scopeRevision; this.draft = contact.draft;
    this.unsubscribe = [backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation;
      this.qualification = undefined;
      this.invalidatePending();
      this.clearObservation('unavailable', 'connection_changed');
    }), contacts.onStateChanged((state) => {
      if (state.scopeRevision !== this.scopeRevision) {
        this.scopeRevision = state.scopeRevision;
        this.qualification = undefined;
        this.invalidatePending(); this.clearObservation('idle', 'contact_changed');
      } else if (state.draft !== this.draft) this.invalidatePending();
      this.draft = state.draft;
    })];
  }
  getState(): ForegroundState { return { ...this.state }; }
  setReplyEditGuard(read: () => boolean): void { this.hasReplyEdits = read; }
  getGenerationBlock(): GenerationBlock {
    const contact = this.contacts.getState();
    const qualified = this.qualification;
    return !this.disposed && this.readingScopeChanges === 0 && qualified && qualified.generation === this.backend.getConnectionGeneration()
      && qualified.scopeRevision === contact.scopeRevision && qualified.contactId === contact.selectedContactId
      && (contact.directoryPhase === 'ready' || contact.directoryPhase === 'loading')
      ? null : 'foreground-confirmation-required';
  }
  // 仅由helper具名桥调用；同步校验并选择，异步旧观察不能在确认后覆盖资格。
  confirm(selection: ForegroundConfirmation) {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    if (this.disposed || generation === undefined || generation !== this.generation
      || selection.foregroundRevision !== this.state.foregroundRevision
      || selection.contactScopeRevision !== contact.scopeRevision
      || !contact.contacts.some((item) => item.contactId === selection.contactId)
      || (contact.directoryPhase !== 'ready' && contact.directoryPhase !== 'loading')) {
      throw new Error('联系人确认已失效，请重新选择本次联系人。');
    }
    this.invalidatePending(); ++this.epoch;
    const selected = this.contacts.selectContact({ contactId: selection.contactId, scopeRevision: contact.scopeRevision });
    this.qualification = { generation, scopeRevision: selected.scopeRevision, contactId: selection.contactId, kind: 'manual-confirmed' };
    this.publish({ foregroundRevision: this.state.foregroundRevision + 1, suggestedContactId: null });
    return selected;
  }
  onStateChanged(listener: (state: ForegroundState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  observeBeforeShow(): Promise<void> {
    if (this.disposed || this.state.suspendedByHelperFocus) return Promise.resolve();
    if (this.readingScopeChanges > 0) {
      this.clearObservation('manual-required', 'reading_scope_changed'); return Promise.resolve();
    }
    if (this.flight) return this.flight.promise;
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) {
      this.clearObservation('unavailable', 'connection_unavailable'); return Promise.resolve();
    }
    const scope = this.contacts.getState().scopeRevision;
    if (this.qualification?.kind === 'verified-binding') this.qualification = undefined;
    const epoch = ++this.epoch;
    const abort = new AbortController();
    const current = () => !this.disposed && !abort.signal.aborted && epoch === this.epoch
      && !this.state.suspendedByHelperFocus && generation === this.backend.getConnectionGeneration()
      && scope === this.contacts.getState().scopeRevision;
    this.clearObservation('observing', null);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (current()) {
          ++this.epoch; abort.abort(); this.clearObservation('unavailable', 'observation_timeout');
        }
        resolve();
      }, 1500);
    });
    const request = this.backend.requestJson({ method: 'POST', path: '/api/sync/foreground/observe', body: {},
      signal: abort.signal, timeoutMs: 1500, maxResponseBytes: 4096 }).then((response) => {
      if (!current() || response.generation !== generation) return;
      const observation = foregroundObservation(response.data);
      // 消费前先废弃flight，内部选择不能把已消费的观察当异步旧结果。
      ++this.epoch;
      if (observation.contactId) {
        const contact = this.contacts.getState();
        if (contact.directoryPhase !== 'ready'
          || !contact.contacts.some((item) => item.contactId === observation.contactId)) {
          this.qualification = undefined;
          this.clearObservation('manual-required', 'contact_unavailable'); return;
        }
        if (contact.draft || this.hasReplyEdits()) {
          this.qualification = undefined;
          this.publish({ phase: 'manual-required', reason: 'existing_edits_require_confirmation',
            observedAt: observation.observedAt, probeAvailable: true, wechatInFront: true,
            suggestedContactId: observation.contactId }); return;
        }
        const selected = this.contacts.selectContact({ contactId: observation.contactId, scopeRevision: scope });
        this.qualification = { generation, scopeRevision: selected.scopeRevision,
          contactId: observation.contactId, kind: 'verified-binding' };
      }
      this.publish({ phase: observation.phase, reason: observation.reason, observedAt: observation.observedAt,
        probeAvailable: observation.probeAvailable, wechatInFront: observation.wechatInFront, suggestedContactId: null });
    }).catch(() => {
      if (current()) this.clearObservation('unavailable', 'observation_unavailable');
    });
    const promise = Promise.race([request, deadline]).finally(() => {
      clearTimeout(timer);
      if (this.flight?.abort === abort) this.flight = undefined;
    });
    this.flight = { abort, promise };
    return promise;
  }
  notifyHelperLifecycle(event: 'focused' | 'blurred' | 'hidden' | 'closed'): void {
    if (this.disposed) return;
    this.invalidatePending(); ++this.epoch;
    this.publish({ suspendedByHelperFocus: event === 'focused', foregroundRevision: this.state.foregroundRevision + 1 });
    if (event === 'closed') this.clearObservation('idle', 'helper_closed');
  }
  invalidatePending(): void {
    if (!this.flight || this.flight.abort.signal.aborted) return;
    ++this.epoch; this.flight.abort.abort();
    this.clearObservation('unavailable', 'observation_cancelled');
  }
  beginReadingScopeChange(): () => void {
    ++this.readingScopeChanges;
    this.invalidateReadingScope();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true; --this.readingScopeChanges;
      this.invalidateReadingScope();
    };
  }
  private invalidateReadingScope(): void {
    this.qualification = undefined;
    this.invalidatePending(); ++this.epoch;
    this.clearObservation('manual-required', 'reading_scope_changed');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; ++this.epoch; this.flight?.abort.abort();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.listeners.clear();
  }
  private clearObservation(phase: ForegroundState['phase'], reason: string | null): void {
    this.publish({ phase, reason, observedAt: null, probeAvailable: null, wechatInFront: null,
      foregroundRevision: this.state.foregroundRevision + 1, suggestedContactId: null });
  }
  private publish(update: Partial<ForegroundState>): void {
    if (this.disposed) return;
    const generationBlock = this.getGenerationBlock();
    this.state = { ...this.state, ...update, revision: this.state.revision + 1,
      generationBlock, confirmation: generationBlock === null ? this.qualification!.kind : 'required',
      confirmedContactId: generationBlock === null ? this.qualification!.contactId : null };
    for (const listener of this.listeners) listener(this.getState());
  }
}
