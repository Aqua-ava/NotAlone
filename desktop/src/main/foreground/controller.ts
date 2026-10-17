import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { initialForegroundState, type ForegroundState, type ForegroundConfirmation, type GenerationBlock } from '../../shared/foreground-bridge';
import { foregroundObservation } from './observation';
import type { SyncControlState } from '../../shared/sync-control-bridge';
import type { ForegroundChangeSource, HeaderChangePermit } from './native-change-source';
import { isTransientForegroundContextChange, isUnsupportedForegroundConversation } from '../../shared/foreground-failure.mjs';
import type { ContactSelection } from '../../shared/contact-session-bridge';

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
  private changePending = false;
  private changeSource: ForegroundChangeSource | undefined;
  private syncPermit: { generation: number; scopeRevision: number } | undefined;
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
      this.generation = generation; this.syncPermit = undefined;
      this.qualification = undefined;
      this.invalidatePending();
      this.clearObservation('unavailable', 'connection_changed'); this.scheduleNext();
    }), contacts.onStateChanged((state) => {
      if (state.scopeRevision !== this.scopeRevision) {
        this.scopeRevision = state.scopeRevision;
        this.qualification = undefined;
        this.invalidatePending(); this.clearObservation('idle', 'contact_changed');
      }
      this.updateChangeSource();
    })];
  }
  getState(): ForegroundState { return { ...this.state }; }
  attachChangeSource(source: ForegroundChangeSource): void {
    this.changeSource?.dispose();
    if (this.disposed) { source.dispose(); return; }
    this.changeSource = source; this.updateChangeSource();
  }
  setSyncControlState(state: SyncControlState): void {
    const generation = this.backend.getConnectionGeneration();
    this.syncPermit = state.phase === 'ready' && state.report?.enabled === true && state.busy === null
      && state.scopeRevision === this.contacts.getState().scopeRevision && generation !== undefined
      ? { generation, scopeRevision: state.scopeRevision } : undefined;
    if (!this.syncPermit) this.changePending = false;
    this.updateChangeSource();
  }
  private changePermit(): HeaderChangePermit | undefined {
    const contact = this.contacts.getState();
    const generation = this.backend.getConnectionGeneration();
    const observed = this.state.observedAt;
    const capturedAt = Date.parse(observed ?? '');
    if (!this.continuous || this.disposed || this.stopped || this.state.suspendedByHelperFocus
      || this.readingScopeChanges > 0 || generation === undefined || !this.syncPermit
      || this.syncPermit.generation !== generation || this.syncPermit.scopeRevision !== contact.scopeRevision
      || !['ready', 'loading'].includes(contact.directoryPhase) || this.state.wechatInFront !== true
      || !observed || !Number.isFinite(capturedAt) || capturedAt > Date.now() || Date.now() - capturedAt >= 5000) return;
    return { scope: `${generation}:${contact.scopeRevision}`, observation: observed };
  }
  private updateChangeSource(): void {
    const permit = this.changePermit();
    if (this.state.wechatInFront !== true || this.changeSource && !permit) this.changePending = false;
    this.changeSource?.update(permit, (event) => {
      if (!permit || this.changePermit()?.scope !== permit.scope) return;
      if (event === 'changed') this.notifyForegroundChange();
      else this.changePending = false;
    });
  }
  getGenerationBlock(): GenerationBlock {
    const contact = this.contacts.getState();
    const qualified = this.qualification;
    return !this.disposed && !this.stopped && !this.state.unsupportedConversation && this.readingScopeChanges === 0 && qualified && qualified.generation === this.backend.getConnectionGeneration()
      && qualified.scopeRevision === contact.scopeRevision && qualified.contactId === contact.selectedContactId
      && (contact.directoryPhase === 'ready' || contact.directoryPhase === 'loading')
      ? null : 'foreground-confirmation-required';
  }
  confirmManual(selection: ContactSelection) {
    const generation = this.backend.getConnectionGeneration();
    if (this.disposed || this.stopped || generation === undefined) throw new Error('本次联系人确认不可用。');
    this.cancelScheduled(); this.invalidatePending(); ++this.epoch;
    const selected = this.contacts.selectContact(selection);
    this.state = { ...this.state, manualInput: true, unsupportedConversation: false };
    this.qualification = { generation, scopeRevision: selected.scopeRevision, contactId: selection.contactId, kind: 'manual-confirmed' };
    this.publish({ phase: 'paused', reason: 'manual_input', recognizedName: null, recognitionConfidence: null,
      observedAt: null, suggestedContactId: null, wechatInFront: null, probeAvailable: null });
    return selected;
  }
  // 仅由helper具名桥调用；同步校验并选择，异步旧观察不能在确认后覆盖资格。
  confirm(selection: ForegroundConfirmation) {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    if (this.disposed || this.stopped || this.state.unsupportedConversation || this.readingScopeChanges > 0 || generation === undefined || generation !== this.generation
      || selection.foregroundRevision !== this.state.foregroundRevision
      || selection.contactScopeRevision !== contact.scopeRevision
      || !contact.contacts.some((item) => item.contactId === selection.contactId)
      || (contact.directoryPhase !== 'ready' && contact.directoryPhase !== 'loading')) {
      throw new Error('联系人确认已失效，请重新选择本次联系人。');
    }
    this.invalidatePending(); ++this.epoch;
    const selected = this.contacts.selectContact({ contactId: selection.contactId, scopeRevision: contact.scopeRevision });
    this.manualRequired = false;
    this.state = { ...this.state, manualInput: false };
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
    this.scheduleNext(); this.updateChangeSource();
  }
  // 仅可信宿主的无身份变化提示；真实失败的退避不受事件风暴影响。
  notifyForegroundChange(): void {
    if (!this.continuous || this.disposed || this.stopped || this.state.suspendedByHelperFocus
      || this.readingScopeChanges > 0 || this.backend.getConnectionGeneration() === undefined) return;
    if (this.flight) { this.changePending = true; return; }
    if (this.failures > 0) return;
    this.cancelScheduled();
    void this.observeBeforeShow();
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
    if (!this.continuous || this.disposed || this.flight || this.state.manualInput || this.state.suspendedByHelperFocus
      || this.readingScopeChanges > 0 || this.scheduled !== undefined) return;
    // 后端每轮预算 3.2 秒，完成后至少休息 2 秒；失败退避至最多 8 秒。
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
    if (this.disposed || this.stopped || this.state.manualInput || this.state.suspendedByHelperFocus) return Promise.resolve();
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
    // 例行刷新保留上次结果；旧人工确认请求仍随新观察作废，名称另受五秒期限约束。
    if (this.state.phase === 'idle') this.clearObservation('observing', null);
    else this.publish({ foregroundRevision: this.state.foregroundRevision + 1 });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (current()) {
          ++this.epoch; abort.abort(); this.clearObservation('unavailable', 'observation_timeout');
        }
        resolve();
      }, 3500);
    });
    const request = this.backend.requestJson({ method: 'POST', path: '/api/sync/foreground/observe', body: {},
      signal: abort.signal, timeoutMs: 3500, maxResponseBytes: 4096 }).then((response) => {
      if (!current() || response.generation !== generation) return;
      const observation = foregroundObservation(response.data);
      // 群聊暂停跨助手获焦/失败保留，只有新的完整私聊证据才能解除。
      const privateVerified = observation.phase === 'confirmed'
        || (observation.phase === 'manual-required' && observation.reason === 'unmatched_requires_selection');
      const unsupportedConversation = isUnsupportedForegroundConversation(observation.reason)
        || (this.state.unsupportedConversation && !privateVerified);
      if (observation.phase === 'manual-required' || (observation.phase === 'unavailable'
        && !isTransientForegroundContextChange(observation.reason))) this.manualRequired = true;
      if (unsupportedConversation || this.manualRequired || observation.phase === 'unavailable' || observation.reason === 'sync_disabled') this.qualification = undefined;
      this.state = { ...this.state, unsupportedConversation };
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
        recognizedName: unsupportedConversation ? null : observation.recognizedName,
        recognitionConfidence: unsupportedConversation ? null : observation.recognitionConfidence,
        probeAvailable: observation.probeAvailable, wechatInFront: observation.wechatInFront, suggestedContactId: null });
    }).catch((error: unknown) => {
      if (!current()) return;
      // 认证接口明确繁忙时撤销当轮资格；不改变此前已触发的人工确认门。
      const busy = error instanceof BackendRequestFailure && error.kind === 'response'
        && error.status === 409 && error.code === 'foreground_observation_busy';
      this.clearObservation('unavailable', busy ? 'foreground_observation_busy' : 'observation_unavailable');
    });
    // UI 超时可以结束等待，但底层传输未结算时仍占有唯一观察许可。
    const settled = request.finally(() => {
      if (this.flight?.abort === abort) {
        this.flight = undefined;
        const awaitingContact = this.state.phase === 'manual-required' && [
          'ambiguous_requires_selection', 'unmatched_requires_selection',
          'session_candidates_truncated', 'manual_confirmation_required',
        ].includes(this.state.reason ?? '');
        this.failures = this.state.phase === 'unavailable' || (this.state.phase === 'manual-required' && !awaitingContact)
          ? Math.min(2, this.failures + 1) : 0;
        const repeat = this.changePending && this.failures === 0;
        this.changePending = false;
        if (repeat) this.notifyForegroundChange();
        else this.scheduleNext();
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
    this.changePending = false;
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
    this.changeSource?.dispose(); this.changeSource = undefined; this.changePending = false;
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
    this.updateChangeSource();
    for (const listener of this.listeners) listener(this.getState());
  }
}
