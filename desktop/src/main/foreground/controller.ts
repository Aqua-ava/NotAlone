import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import {currentDiagnosticTrace,diagnose,newTraceId,withDiagnosticTrace} from '../../../../backend-ts/src/diagnostics/context';
import type { ContactSession } from '../contacts/session';
import { initialForegroundState, type ForegroundState, type GenerationBlock } from '../../shared/foreground-bridge';
import { foregroundObservation } from './observation';
import type { SyncControlState } from '../../shared/sync-control-bridge';
import type { ForegroundChangeSource, HeaderChangePermit } from './native-change-source';
import { isAwaitingForegroundSelection, isKnownForegroundReason,
  isUnsupportedForegroundConversation } from '../../shared/foreground-failure.mjs';
import type { ContactSelection } from '../../shared/contact-session-bridge';

type Flight = { abort: AbortController; promise: Promise<void> };
export type ForegroundMeasurement = {
  event: 'change_received' | 'change_queued' | 'poll_scheduled' | 'request_started' | 'request_settled' | 'result_published';
  durationMs: number; changedContact: boolean; confirmed: boolean; phase: ForegroundState['phase'];
};
export interface ObservationClock {
  schedule(callback: () => Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
const observationClock: ObservationClock = {
  schedule: (callback, delay) => setTimeout(() => { void callback(); }, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
function foregroundReason(reason:string|null,phase:ForegroundState['phase']):string{
  if(reason==='connection_changed'||reason==='connection_unavailable')return 'connection_changed';
  if(reason==='contact_changed')return 'scope_changed';
  if(reason==='reading_scope_changed')return 'reading_scope_changed';
  if(reason==='helper_focused'||reason==='wechat_not_in_front')return 'paused';
  if(reason==='sync_disabled')return 'disabled';
  if(reason==='screen_capture_permission_missing')return 'permission_missing';
  if(reason&&isKnownForegroundReason(reason)){
    if(reason.includes('timeout'))return 'timeout';if(reason.includes('ambiguous'))return 'ambiguous';
    if(reason.includes('unmatched'))return 'unmatched';if(phase==='confirmed')return 'completed';
    return phase==='manual-required'?'unmatched':phase==='paused'?'paused':'failed';
  }
  return reason?'rejected':'no_change';
}

// 连续观察和焦点只由可信宿主驱动，页面不能声明微信前台或启动采集。
export class ForegroundController {
  private state: ForegroundState = { ...initialForegroundState };
  private epoch = 0;
  private disposed = false;
  private continuous = false;
  private stopped = false;
  private scheduled: unknown;
  private failures = 0;
  private refreshAfterHelperFocus = false;
  private changePending = false;
  private readonly loggedUnknownReasons = new Set<string>();
  private diagnosticState={phase:'idle',reasonCode:'no_change',contactId:null as string|null,began:performance.now()};
  private changeSource: ForegroundChangeSource | undefined;
  private syncPermit: { generation: number } | undefined;
  private captureAuthorityRevision = 0;
  private selectingObservedContact = false;
  private measurement: ((value: ForegroundMeasurement) => void) | undefined;
  private flight: Flight | undefined;
  private nameExpiry: ReturnType<typeof setTimeout> | undefined;
  private generation: number | undefined;
  private scopeRevision: number;
  private readingScopeChanges = 0;
  // 只由正式观察填入，进入小窗不延长原采集时间；页面不能提供或修改这份回执。
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
      this.generation = generation; this.syncPermit = undefined; ++this.captureAuthorityRevision;
      this.clearQualification();
      this.invalidatePending();
      this.clearObservation('unavailable', 'connection_changed'); this.scheduleNext();
    }), contacts.onStateChanged((state) => {
      if (state.scopeRevision !== this.scopeRevision) {
        this.scopeRevision = state.scopeRevision;
        this.clearQualification();
        if (!this.selectingObservedContact) {
          ++this.captureAuthorityRevision;
          this.invalidatePending(); this.clearObservation('idle', 'contact_changed');
        }
      }
      this.updateChangeSource();
    })];
  }
  getState(): ForegroundState { return { ...this.state }; }
  // 只供可信宿主的显式验收；仅发送固定事件与数值，不暴露会话文字或标识。
  observeMeasurements(listener: (value: ForegroundMeasurement) => void): void { this.measurement = listener; }
  private measure(event: ForegroundMeasurement['event'], durationMs = 0, changedContact = false): void {
    try { this.measurement?.({ event, durationMs, changedContact, confirmed: this.state.phase === 'confirmed', phase: this.state.phase }); }
    catch { /* 诊断故障不能改变观察调度或身份资格。 */ }
  }
  attachChangeSource(source: ForegroundChangeSource): void {
    this.changeSource?.dispose();
    if (this.disposed) { source.dispose(); return; }
    this.changeSource = source; this.updateChangeSource();
  }
  setSyncControlState(state: SyncControlState): void {
    const generation = this.backend.getConnectionGeneration();
    const hadPermit = Boolean(this.syncPermit);
    this.syncPermit = state.phase === 'ready' && state.report?.enabled === true && state.busy === null
      && generation !== undefined
      ? { generation } : undefined;
    if (hadPermit && !this.syncPermit) ++this.captureAuthorityRevision;
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
      || this.syncPermit.generation !== generation
      || !['ready', 'loading'].includes(contact.directoryPhase) || this.state.wechatInFront !== true
      || !observed || !Number.isFinite(capturedAt) || capturedAt > Date.now() || Date.now() - capturedAt >= 5000) return;
    return { scope: `${generation}:${this.captureAuthorityRevision}`, observation: observed };
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
  // 只清除宿主本次确认标记，不删除历史请求所依赖的确认记录。
  private clearQualification(): void {
    if (this.qualification?.kind === 'manual-confirmed') this.backend.clearManualInput(this.qualification.contactId);
    this.qualification = undefined;
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
    this.cancelScheduled(); this.invalidatePending(); ++this.epoch; ++this.captureAuthorityRevision;
    this.clearQualification();
    const selected = this.contacts.selectContact(selection);
    this.backend.confirmManualInput(selection.contactId, generation);
    this.state = { ...this.state, unsupportedConversation: false };
    this.qualification = { generation, scopeRevision: selected.scopeRevision, contactId: selection.contactId, kind: 'manual-confirmed' };
    this.publish({ phase: this.state.suspendedByHelperFocus ? 'paused' : 'idle', reason: 'contact_selected',
      recognizedName: null, recognitionConfidence: null, observedAt: null,
      wechatInFront: null, probeAvailable: null });
    this.scheduleNext();
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
    this.measure('change_received');
    // 顶部变化只撤销旧生成资格，不携带或授予新联系人身份。
    this.clearQualification();
    this.publish({ foregroundRevision: this.state.foregroundRevision + 1 });
    if (this.flight) { this.changePending = true; this.measure('change_queued'); return; }
    if (this.failures > 0) return;
    this.cancelScheduled();
    void this.observeBeforeShow();
  }
  stopContinuous(): void {
    this.continuous = false; this.stopped = true;
    this.cancelScheduled(); this.clearQualification();
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
    // 周期观察间隔2秒；真正离开助手可立即复查，技术失败仍退避至最多8秒。
    const delay = this.refreshAfterHelperFocus && this.failures === 0 ? 0 : Math.min(8000, 2000 * 2 ** this.failures);
    this.measure('poll_scheduled', delay);
    this.refreshAfterHelperFocus = false;
    const handle = this.clock.schedule(async () => {
      if (this.scheduled !== handle) return;
      this.scheduled = undefined;
      await this.observeBeforeShow();
      this.scheduleNext();
    }, delay);
    this.scheduled = handle;
  }
  async screenPermissionRestored(): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    if (this.disposed || this.stopped || generation === undefined) return;
    const response = await this.backend.requestJson({ method: 'POST', path: '/api/sync/foreground/permission-restored', body: {}, timeoutMs: 3500, maxResponseBytes: 4096 });
    if (response.generation !== generation || this.backend.getConnectionGeneration() !== generation
      || !response.data || typeof response.data !== 'object' || Object.keys(response.data).length !== 1
      || !('ok' in response.data) || response.data.ok !== true) throw new Error('前台权限恢复未完成。');
    await this.observeBeforeShow();
  }
  observeBeforeShow(): Promise<void> {
    return withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),()=>this.observeOwned());
  }
  private observeOwned():Promise<void>{
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
    const began = performance.now();
    this.measure('request_started');
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
      if (observation.reason !== null && !isKnownForegroundReason(observation.reason) && !this.loggedUnknownReasons.has(observation.reason)) {
        // 未知前台原因不静默折叠：只记录协议原因码，界面继续走固定兜底文案。
        if(this.loggedUnknownReasons.size<32)this.loggedUnknownReasons.add(observation.reason);
        diagnose({event:'foreground.decision',caller:'foreground_controller',reasonCode:'rejected',count:1});
      }
      // 丢弃已过时的身份/待选择结果，避免旧观察恢复资格或显示旧建议；技术失败及安全暂停仍处理。
      if (this.changePending && (observation.phase === 'confirmed'
        || observation.phase === 'manual-required' && isAwaitingForegroundSelection(observation.reason))) return;
      // 群聊暂停跨助手获焦/失败保留，只有新的完整私聊证据才能解除。
      const privateVerified = observation.phase === 'confirmed'
        || (observation.phase === 'manual-required' && observation.reason === 'unmatched_requires_selection');
      const unsupportedConversation = isUnsupportedForegroundConversation(observation.reason)
        || (this.state.unsupportedConversation && !privateVerified);
      // 失败撤销当轮资格；显式选择不停止观察，新的完整绑定核验可独立恢复。
      if (unsupportedConversation || observation.phase === 'manual-required'
        || observation.phase === 'unavailable' || observation.reason === 'sync_disabled') this.clearQualification();
      this.state = { ...this.state, unsupportedConversation };
      // 消费前先废弃flight，内部选择不能把已消费的观察当异步旧结果。
      ++this.epoch;
      let changedContact = false;
      if (observation.contactId) {
        this.clearQualification();
        const contact = this.contacts.getState();
        changedContact = contact.selectedContactId !== observation.contactId;
        if (contact.directoryPhase !== 'ready'
          || !contact.contacts.some((item) => item.contactId === observation.contactId)) {
          this.clearQualification();
          this.clearObservation('manual-required', 'contact_unavailable'); return;
        }
        this.selectingObservedContact = true;
        let selected;
        try { selected = this.contacts.selectContact({ contactId: observation.contactId, scopeRevision: scope },'foreground_scope_change'); }
        finally { this.selectingObservedContact = false; }
        this.qualification = { generation, scopeRevision: selected.scopeRevision,
          contactId: observation.contactId, kind: 'verified-binding' };
      }
      this.publish({ phase: observation.phase, reason: observation.reason, observedAt: observation.observedAt,
        recognizedName: unsupportedConversation ? null : observation.recognizedName,
        recognitionConfidence: unsupportedConversation ? null : observation.recognitionConfidence,
        probeAvailable: observation.probeAvailable, wechatInFront: observation.wechatInFront });
      this.measure('result_published', performance.now() - began, changedContact);
    }).catch((error: unknown) => {
      if (!current()) return;
      // 只保留固定业务原因；账号范围和服务失败不能误报为网络传输失败。
      let reason = 'foreground_observation_unavailable';
      if (error instanceof BackendRequestFailure) {
        if (error.kind === 'connection') reason = 'observation_unavailable';
        else if (error.kind === 'response') {
          if (error.status === 409 && error.code === 'foreground_observation_busy') reason = error.code;
          else if (error.status === 503 && error.code === 'foreground_scope_unavailable') reason = error.code;
          else if ((error.status === 503 || error.status === 504) && error.code === 'observation_timeout') reason = error.code;
        }
      }
      this.clearObservation('unavailable', reason);
    });
    // UI 超时可以结束等待，但底层传输未结算时仍占有唯一观察许可。
    const settled = request.finally(() => {
      this.measure('request_settled', performance.now() - began);
      if (this.flight?.abort === abort) {
        this.flight = undefined;
        const awaitingContact = this.state.phase === 'manual-required' && isAwaitingForegroundSelection(this.state.reason);
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
    const focused = event === 'focused';
    const wasFocused = this.state.suspendedByHelperFocus;
    if (focused === wasFocused && (focused || event === 'blurred')) return;
    if (wasFocused && !focused) this.refreshAfterHelperFocus = true;
    this.invalidatePending('paused'); ++this.epoch;
    this.publish({ suspendedByHelperFocus: event === 'focused', foregroundRevision: this.state.foregroundRevision + 1 });
    if (event === 'focused') {
      this.cancelScheduled();
      // 获焦只停止新采集；用户进入小窗查看时仍须看见刚取得的故障与恢复方式。
      if (this.state.phase !== 'unavailable') this.clearObservation('paused', 'helper_focused');
    }
    else this.scheduleNext();
  }
  invalidatePending(phase: 'paused' | 'unavailable' = 'unavailable'): void {
    this.changePending = false;
    if (!this.flight || this.flight.abort.signal.aborted) return;
    ++this.epoch; this.flight.abort.abort();
    this.clearObservation(phase, 'observation_cancelled');
  }
  beginReadingScopeChange(): () => void {
    const traceId=currentDiagnosticTrace()??newTraceId();
    diagnose({event:'foreground.decision',caller:'reading_scope_begin',reasonCode:'reading_scope_changed',traceId,count:this.readingScopeChanges+1});
    ++this.readingScopeChanges; this.cancelScheduled();
    this.invalidateReadingScope();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true; --this.readingScopeChanges;
      withDiagnosticTrace(traceId,()=>{diagnose({event:'foreground.decision',caller:'reading_scope_end',reasonCode:'reading_scope_changed',count:this.readingScopeChanges});this.invalidateReadingScope();this.scheduleNext();});
    };
  }
  private invalidateReadingScope(): void {
    ++this.captureAuthorityRevision;
    this.clearQualification();
    this.invalidatePending(); ++this.epoch;
    this.clearObservation('manual-required', 'reading_scope_changed');
  }
  dispose(): void {
    if (this.disposed) return;
    this.changeSource?.dispose(); this.changeSource = undefined; this.changePending = false;
    this.clearQualification();
    this.cancelScheduled(); this.disposed = true; ++this.epoch; this.flight?.abort.abort();
    clearTimeout(this.nameExpiry); this.nameExpiry = undefined;
    this.state = { ...this.state, recognizedName: null, recognitionConfidence: null };
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.listeners.clear();
  }
  private clearObservation(phase: ForegroundState['phase'], reason: string | null): void {
    if (phase === 'manual-required' || phase === 'unavailable') this.clearQualification();
    this.publish({ phase, reason, observedAt: null, probeAvailable: null, wechatInFront: null,
      recognizedName: null, recognitionConfidence: null,
      foregroundRevision: this.state.foregroundRevision + 1 });
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
    if(this.state.phase!=='observing'){
      const phases={idle:'idle',confirmed:'ready','manual-required':'blocked',paused:'paused',unavailable:'failed'},phase=phases[this.state.phase],reasonCode=foregroundReason(this.state.reason,this.state.phase),previous=this.diagnosticState;
      if(phase!==previous.phase||reasonCode!==previous.reasonCode||this.state.confirmedContactId!==previous.contactId){
        const now=performance.now();diagnose({event:'foreground.state_changed',caller:'foreground_controller',reasonCode,fromState:previous.phase,toState:phase,durationMs:Math.max(0,now-previous.began),...(this.state.confirmedContactId?{contactPrefix:this.state.confirmedContactId.slice(0,8)}:{})});
        this.diagnosticState={phase,reasonCode,contactId:this.state.confirmedContactId,began:now};
      }
    }
    for (const listener of this.listeners) listener(this.getState());
  }
}
