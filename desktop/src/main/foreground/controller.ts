import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';
import { initialForegroundState, type ForegroundState, type ForegroundConfirmation, type GenerationBlock } from '../../shared/foreground-bridge';
import { foregroundObservation } from './observation';

type Flight = { abort: AbortController; promise: Promise<void> };

export interface ObservationClock {
  schedule(callback: () => Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
const observationClock: ObservationClock = {
  schedule: (callback, delay) => setTimeout(() => { void callback(); }, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// 连续观察和焦点只由可信宿主驱动，页面不能声明微信前台或启动采集。
export class ForegroundController {
  private state: ForegroundState = { ...initialForegroundState };
  private epoch = 0;
  private disposed = false;
  private continuous = false;
  private stopped = false;
  private scheduled: unknown;
  private failures = 0;
  private manualRequired = false;
  private flight: Flight | undefined;
  private nameExpiry: ReturnType<typeof setTimeout> | undefined;
  private generation: number | undefined;
  private scopeRevision: number;
  private readingScopeChanges = 0;
  private qualification: { generation: number; scopeRevision: number; contactId: string;
    kind: 'manual-confirmed' | 'verified-binding' } | undefined;
  private readonly listeners = new Set<(state: ForegroundState) => void>();
  private readonly unsubscribe: (() => void)[];
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly clock: ObservationClock = observationClock) {
    this.generation = backend.getConnectionGeneration();
    const contact = contacts.getState();
    this.scopeRevision = contact.scopeRevision;
    this.unsubscribe = [backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation;
      this.qualification = undefined;
      this.invalidatePending();
      this.clearObservation('unavailable', 'connection_changed'); this.scheduleNext();
    }), contacts.onStateChanged((state) => {
      if (state.scopeRevision !== this.scopeRevision) {
        this.scopeRevision = state.scopeRevision;
        this.qualification = undefined;
        this.invalidatePending(); this.clearObservation('idle', 'contact_changed');
      }
    })];
  }
  getState(): ForegroundState { return { ...this.state }; }
  getGenerationBlock(): GenerationBlock {
    const contact = this.contacts.getState();
    const qualified = this.qualification;
    return !this.disposed && !this.stopped && this.readingScopeChanges === 0 && qualified && qualified.generation === this.backend.getConnectionGeneration()
      && qualified.scopeRevision === contact.scopeRevision && qualified.contactId === contact.selectedContactId
      && (contact.directoryPhase === 'ready' || contact.directoryPhase === 'loading')
      ? null : 'foreground-confirmation-required';
  }
  // 仅由helper具名桥调用；同步校验并选择，异步旧观察不能在确认后覆盖资格。
  confirm(selection: ForegroundConfirmation) {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    if (this.disposed || this.stopped || this.readingScopeChanges > 0 || generation === undefined || generation !== this.generation
      || selection.foregroundRevision !== this.state.foregroundRevision
      || selection.contactScopeRevision !== contact.scopeRevision
      || !contact.contacts.some((item) => item.contactId === selection.contactId)
      || (contact.directoryPhase !== 'ready' && contact.directoryPhase !== 'loading')) {
      throw new Error('联系人确认已失效，请重新选择本次联系人。');
    }
    this.invalidatePending(); ++this.epoch;
    const selected = this.contacts.selectContact({ contactId: selection.contactId, scopeRevision: contact.scopeRevision });
    this.manualRequired = false;
    this.qualification = { generation, scopeRevision: selected.scopeRevision, contactId: selection.contactId, kind: 'manual-confirmed' };
    this.publish({ foregroundRevision: this.state.foregroundRevision + 1, suggestedContactId: null });
    return selected;
  }
  onStateChanged(listener: (state: ForegroundState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  startContinuous(): void {
    if (this.disposed || this.continuous) return;
    this.stopped = false; this.continuous = true; this.failures = 0;
    this.scheduleNext();
  }
  stopContinuous(): void {
    this.continuous = false; this.stopped = true;
    this.cancelScheduled(); this.qualification = undefined;
    this.invalidatePending('paused'); ++this.epoch;
    this.clearObservation('paused', 'observation_stopped');
  }
  private cancelScheduled(): void {
    if (this.scheduled !== undefined) this.clock.cancel(this.scheduled);
    this.scheduled = undefined;
  }
  private scheduleNext(): void {
    if (!this.continuous || this.disposed || this.flight || this.state.suspendedByHelperFocus
      || this.readingScopeChanges > 0 || this.scheduled !== undefined) return;
    // 后端每轮预算 1.3 秒，完成后至少休息 2 秒；失败退避至最多 8 秒。
    const delay = Math.min(8000, 2000 * 2 ** this.failures);
    const handle = this.clock.schedule(async () => {
      if (this.scheduled !== handle) return;
      this.scheduled = undefined;
      await this.observeBeforeShow();
      this.scheduleNext();
    }, delay);
    this.scheduled = handle;
  }
  observeBeforeShow(): Promise<void> {
    if (this.disposed || this.stopped || this.state.suspendedByHelperFocus) return Promise.resolve();
    if (this.readingScopeChanges > 0) {
      this.clearObservation('manual-required', 'reading_scope_changed'); return Promise.resolve();
    }
    if (this.flight) return this.flight.promise;
    this.cancelScheduled();
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) {
      this.clearObservation('unavailable', 'connection_unavailable'); this.scheduleNext(); return Promise.resolve();
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
      if (observation.phase === 'manual-required' || observation.phase === 'unavailable') this.manualRequired = true;
      if (this.manualRequired || observation.reason === 'sync_disabled') this.qualification = undefined;
      // 消费前先废弃flight，内部选择不能把已消费的观察当异步旧结果。
      ++this.epoch;
      if (observation.contactId) {
        const contact = this.contacts.getState();
        if (contact.directoryPhase !== 'ready'
          || !contact.contacts.some((item) => item.contactId === observation.contactId)) {
          this.qualification = undefined;
          this.clearObservation('manual-required', 'contact_unavailable'); return;
        }
        if (this.manualRequired) {
          this.publish({ phase: 'manual-required', reason: 'manual_confirmation_required',
            observedAt: observation.observedAt, probeAvailable: true, wechatInFront: true,
            recognizedName: observation.recognizedName, recognitionConfidence: observation.recognitionConfidence,
            suggestedContactId: observation.contactId }); return;
        }
        const selected = this.contacts.selectContact({ contactId: observation.contactId, scopeRevision: scope });
        this.qualification = { generation, scopeRevision: selected.scopeRevision,
          contactId: observation.contactId, kind: 'verified-binding' };
      }
      this.publish({ phase: observation.phase, reason: observation.reason, observedAt: observation.observedAt,
        recognizedName: observation.recognizedName, recognitionConfidence: observation.recognitionConfidence,
        probeAvailable: observation.probeAvailable, wechatInFront: observation.wechatInFront, suggestedContactId: null });
    }).catch(() => {
      if (current()) this.clearObservation('unavailable', 'observation_unavailable');
    });
    // UI 超时可以结束等待，但底层传输未结算时仍占有唯一观察许可。
    const settled = request.finally(() => {
      if (this.flight?.abort === abort) {
        this.flight = undefined;
        this.failures = this.state.phase === 'unavailable' || this.state.phase === 'manual-required'
          ? Math.min(2, this.failures + 1) : 0;
        this.scheduleNext();
      }
    });
    const promise = Promise.race([settled, deadline]).finally(() => { clearTimeout(timer); });
    this.flight = { abort, promise };
    return promise;
  }
  notifyHelperLifecycle(event: 'focused' | 'blurred' | 'hidden' | 'closed'): void {
    if (this.disposed) return;
    this.invalidatePending('paused'); ++this.epoch;
    this.publish({ suspendedByHelperFocus: event === 'focused', foregroundRevision: this.state.foregroundRevision + 1 });
    if (event === 'focused') { this.cancelScheduled(); this.clearObservation('paused', 'helper_focused'); }
    else this.scheduleNext();
  }
  invalidatePending(phase: 'paused' | 'unavailable' = 'unavailable'): void {
    if (!this.flight || this.flight.abort.signal.aborted) return;
    ++this.epoch; this.flight.abort.abort();
    this.clearObservation(phase, 'observation_cancelled');
  }
  beginReadingScopeChange(): () => void {
    ++this.readingScopeChanges; this.cancelScheduled();
    this.invalidateReadingScope();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true; --this.readingScopeChanges;
      this.invalidateReadingScope(); this.scheduleNext();
    };
  }
  private invalidateReadingScope(): void {
    this.qualification = undefined;
    this.invalidatePending(); ++this.epoch;
    this.clearObservation('manual-required', 'reading_scope_changed');
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancelScheduled(); this.disposed = true; ++this.epoch; this.flight?.abort.abort();
    clearTimeout(this.nameExpiry); this.nameExpiry = undefined;
    this.state = { ...this.state, recognizedName: null, recognitionConfidence: null };
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.listeners.clear();
  }
  private clearObservation(phase: ForegroundState['phase'], reason: string | null): void {
    if (phase === 'manual-required' || phase === 'unavailable') this.qualification = undefined;
    if (reason === 'observation_timeout' || reason === 'observation_unavailable' || reason === 'contact_unavailable') this.manualRequired = true;
    this.publish({ phase, reason, observedAt: null, probeAvailable: null, wechatInFront: null,
      recognizedName: null, recognitionConfidence: null,
      foregroundRevision: this.state.foregroundRevision + 1, suggestedContactId: null });
  }
  private publish(update: Partial<ForegroundState>): void {
    if (this.disposed) return;
    const generationBlock = this.getGenerationBlock();
    this.state = { ...this.state, ...update, revision: this.state.revision + 1,
      generationBlock, confirmation: generationBlock === null ? this.qualification!.kind : 'required',
      confirmedContactId: generationBlock === null ? this.qualification!.contactId : null };
    if (Object.hasOwn(update, 'recognizedName')) {
      clearTimeout(this.nameExpiry); this.nameExpiry = undefined;
      if (this.state.recognizedName) {
        const remaining = Date.parse(this.state.observedAt ?? '') + 5000 - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 5000) {
          this.state = { ...this.state, recognizedName: null, recognitionConfidence: null };
        } else {
          this.nameExpiry = setTimeout(() => {
            this.nameExpiry = undefined;
            this.publish({ recognizedName: null, recognitionConfidence: null });
          }, remaining);
        }
      }
    }
    for (const listener of this.listeners) listener(this.getState());
  }
}
