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
  private qualification: { generation: number; scopeRevision: number; contactId: string } | undefined;
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
  getGenerationBlock(): GenerationBlock {
    const contact = this.contacts.getState();
    const qualified = this.qualification;
    return !this.disposed && qualified && qualified.generation === this.backend.getConnectionGeneration()
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
    this.qualification = { generation, scopeRevision: selected.scopeRevision, contactId: selection.contactId };
    this.publish({ foregroundRevision: this.state.foregroundRevision + 1 });
    return selected;
  }
  onStateChanged(listener: (state: ForegroundState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  observeBeforeShow(): Promise<void> {
    if (this.disposed || this.state.suspendedByHelperFocus) return Promise.resolve();
    if (this.flight) return this.flight.promise;
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) {
      this.clearObservation('unavailable', 'connection_unavailable'); return Promise.resolve();
    }
    const scope = this.contacts.getState().scopeRevision;
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
      // 每个flight只在其有效代际消费一次；首片只发布安全状态，不更改联系人或草稿。
      ++this.epoch;
      this.publish({ phase: observation.phase, reason: observation.reason, observedAt: observation.observedAt,
        probeAvailable: observation.probeAvailable, wechatInFront: observation.wechatInFront });
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
    this.publish({ suspendedByHelperFocus: event === 'focused' });
    if (event === 'closed') this.clearObservation('idle', 'helper_closed');
  }
  invalidatePending(): void {
    if (!this.flight) return;
    ++this.epoch; this.flight.abort.abort();
    this.clearObservation('unavailable', 'observation_cancelled');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; ++this.epoch; this.flight?.abort.abort();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.listeners.clear();
  }
  private clearObservation(phase: ForegroundState['phase'], reason: string | null): void {
    this.publish({ phase, reason, observedAt: null, probeAvailable: null, wechatInFront: null,
      foregroundRevision: this.state.foregroundRevision + 1 });
  }
  private publish(update: Partial<ForegroundState>): void {
    if (this.disposed) return;
    const generationBlock = this.getGenerationBlock();
    this.state = { ...this.state, ...update, revision: this.state.revision + 1,
      generationBlock, confirmation: generationBlock === null ? 'manual-confirmed' : 'required',
      confirmedContactId: generationBlock === null ? this.qualification!.contactId : null };
    for (const listener of this.listeners) listener(this.getState());
  }
}
