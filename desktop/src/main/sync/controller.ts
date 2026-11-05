import type { HistoryAuthorizationDecision, HistoryAuthorizationRequest, SyncControlState, SyncControlRequest, SyncScopeRequest, SyncScope } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import { ContactDeletionQuiet } from '../contacts/deletion-quiet';
import type { ContactSession } from '../contacts/session';
import { readSyncStatus, setSyncEnabled, controlBackfill, setSyncScope, setHistoryAuthorization } from './status';

type Scope = { generation: number };
type Operation = 'refresh' | 'enable' | 'disable' | 'pause' | 'retry' | 'scope' | 'history';

export class SyncControlController {
  private state: SyncControlState = { revision: 0, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };
  private scope: Scope | undefined;
  private epoch = 0;
  private pending: AbortController | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryFailures = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotRefreshing = false;
  private knownBindingCount: number | undefined;
  private directoryRefresh: { scope: Scope; count: number } | undefined;
  private disposed = false;
  private readonly unsubscribe: (() => void)[];
  private readonly listeners = new Set<(state: SyncControlState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession,
    private readonly beginReadingScopeChange: () => (() => void) = () => () => {},
    private readonly quiet: ContactDeletionQuiet = new ContactDeletionQuiet()) {
    this.unsubscribe = [backend.onStateChanged(() => this.synchronizeScope()),
      contacts.onStateChanged(() => this.synchronizeScope())];
    this.synchronizeScope();
  }
  getState(): SyncControlState { return structuredClone(this.state); }
  onStateChanged(listener: (state: SyncControlState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.disposed = true; this.cancelRecovery(); this.cancelSnapshot();
    this.directoryRefresh = undefined;
    this.pending?.abort(); this.pending = undefined; ++this.epoch;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.listeners.clear();
  }
  private cancelRecovery(): void {
    clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; this.recoveryFailures = 0;
  }
  private cancelSnapshot(): void {
    clearTimeout(this.snapshotTimer); this.snapshotTimer = undefined;
  }
  private scheduleSnapshot(scope: Scope): void {
    if (this.disposed || this.snapshotTimer !== undefined || scope !== this.scope
      || this.state.phase !== 'ready' || !this.state.report?.enabled || (!this.state.report.priority && this.state.report.syncScope !== 'all_private' && !this.state.report.historyCoverages?.length)) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      if (this.disposed || this.pending || scope !== this.scope
        || scope.generation !== this.backend.getConnectionGeneration()) return;
      // 删除窗口内也照常尝试读取；失败时保留上一次报告、登记窗口结束补读并有界恢复。
      void this.perform('refresh', scope, true);
    }, 3000);
    this.snapshotTimer.unref?.();
  }
  private scheduleRecovery(scope: Scope): void {
    if (this.disposed || this.recoveryTimer !== undefined || scope !== this.scope) return;
    const delay = 1000 * 2 ** this.recoveryFailures;
    this.recoveryFailures = Math.min(3, this.recoveryFailures + 1);
    // 只重读初始化快照；不开启同步，也不重放开关或补齐操作。
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.disposed || this.pending || scope !== this.scope
        || scope.generation !== this.backend.getConnectionGeneration()) return;
      // 删除窗口内恢复定时器也照常尝试读取；失败继续按退避恢复。
      void this.perform('refresh', scope);
    }, delay);
    this.recoveryTimer.unref?.();
  }
  private synchronizeScope(): void {
    if (this.disposed) return;
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const next = generation !== undefined && ['ready', 'loading'].includes(contact.directoryPhase)
      ? { generation } : undefined;
    // 同步报告属于连接全局，展示联系人变化只更新页面命令修订。
    if (next?.generation === this.scope?.generation) {
      if (contact.scopeRevision !== this.state.scopeRevision) this.publish({ scopeRevision: contact.scopeRevision });
      return;
    }
    this.cancelRecovery(); this.cancelSnapshot();
    this.pending?.abort(); this.pending = undefined; ++this.epoch;
    this.scope = next;
    this.knownBindingCount = undefined;
    this.directoryRefresh = undefined;
    this.publish({ scopeRevision: contact.scopeRevision, phase: generation === undefined ? 'offline' : 'unavailable',
      report: null, busy: null, errorCode: null });
    // 只读取缓存状态，不启动正文周期或把历史定位结果当作当前联系人。
    if (next) void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    // 删除窗口内也照常尝试读取；失败时保留上一次报告，登记窗口结束补读并按退避恢复。
    this.cancelRecovery(); this.cancelSnapshot();
    this.synchronizeScope();
    if (!this.scope || this.pending) return;
    await this.perform('refresh', this.scope, this.state.phase === 'ready');
  }
  /** 删除结束后的补读：不显示加载态，失败保留上一次成功报告。 */
  private readonly silentRefresh = () => {
    if (this.disposed) return;
    this.cancelRecovery(); this.cancelSnapshot();
    this.synchronizeScope();
    if (!this.scope) return;
    void this.perform('refresh', this.scope, true, undefined, undefined, true).catch(() => {});
  };
  enable(request: SyncControlRequest): Promise<void> { return this.control(request, 'enable'); }
  disable(request: SyncControlRequest): Promise<void> { return this.control(request, 'disable'); }
  pause(request: SyncControlRequest): Promise<void> { return this.control(request, 'pause'); }
  retry(request: SyncControlRequest): Promise<void> { return this.control(request, 'retry'); }
  setScope(request: SyncScopeRequest): Promise<void> {
    if (request.confirmed !== true || !['selected', 'all_private'].includes(request.mode)) return Promise.reject(new Error('同步范围需要明确确认。'));
    return this.control(request, 'scope', request.mode);
  }
  setHistoryAuthorization(request: HistoryAuthorizationRequest): Promise<void> {
    if (request.confirmed !== true || !['accepted', 'declined'].includes(request.decision)) {
      return Promise.reject(new Error('历史读取授权需要明确确认。'));
    }
    return this.control(request, 'history', undefined, request.decision);
  }
  private async control(request: SyncControlRequest, operation: Exclude<Operation, 'refresh'>, mode?: SyncScope,
    historyDecision?: HistoryAuthorizationDecision): Promise<void> {
    this.synchronizeScope();
    if (this.snapshotRefreshing && request.scopeRevision === this.state.scopeRevision) {
      // 用户停读优先于只读指标请求；迟到快照由 epoch 和取消信号共同失效。
      this.pending?.abort(); this.pending = undefined; ++this.epoch; this.snapshotRefreshing = false;
    }
    if (this.disposed || !this.scope || this.pending || this.state.phase !== 'ready' || !this.state.report
      || request.scopeRevision !== this.state.scopeRevision) throw new Error('本次同步范围已失效，请刷新状态后重试。');
    if (operation === 'pause' || operation === 'retry') {
      const phases = operation === 'pause' ? ['gap_detected', 'backfilling', 'incomplete'] : ['paused', 'failed', 'incomplete'];
      if (!this.state.report.enabled || !phases.includes(this.state.report.backfill.phase)) throw new Error('当前补齐状态不支持本次操作。');
    }
    this.cancelRecovery(); this.cancelSnapshot();
    const finish = ['enable', 'disable', 'pause', 'scope', 'history'].includes(operation) ? this.beginReadingScopeChange() : undefined;
    try { await this.perform(operation, this.scope, false, mode, historyDecision); }
    finally { finish?.(); }
  }
  private async perform(operation: Operation, scope: Scope, background = false, mode?: SyncScope,
    historyDecision?: HistoryAuthorizationDecision, preserveOnFailure = false): Promise<void> {
    const enabledBefore = this.state.report?.enabled;
    // 窗口内只读刷新失败时恢复这次读取前的展示，不能停在“正在读取”。
    const phaseBefore = this.state.phase;
    const reportBefore = this.state.report;
    const errorCodeBefore = this.state.errorCode;
    const epoch = ++this.epoch;
    const pending = new AbortController();
    this.pending = pending;
    this.snapshotRefreshing = background;
    const current = () => !this.disposed && !pending.signal.aborted && scope === this.scope && epoch === this.epoch
      && scope.generation === this.backend.getConnectionGeneration();
    // 自动刷新只读缓存报告，保留有效展示和前台许可，不闪烁成暂停或重放启停命令。
    if (!background) this.publish({ phase: 'loading', report: null, busy: operation === 'refresh' ? null : operation, errorCode: null });
    try {
      const result = operation === 'refresh' ? await readSyncStatus(this.backend, pending.signal)
        : operation === 'enable' || operation === 'disable' ? await setSyncEnabled(this.backend, operation === 'enable', pending.signal)
        : operation === 'scope' ? await setSyncScope(this.backend, mode!, pending.signal)
        : operation === 'history' ? await setHistoryAuthorization(this.backend, historyDecision!, pending.signal)
        : await controlBackfill(this.backend, operation, pending.signal);
      if (!current() || result.generation !== scope.generation) return;
      if ((operation === 'enable' || operation === 'disable') && result.report.enabled !== (operation === 'enable')) throw new Error('同步结果未确认。');
      if ((operation === 'pause' || operation === 'retry') && result.report.enabled !== enabledBefore) throw new Error('同步结果未确认。');
      if (operation === 'scope' && (result.report.syncScope !== mode || result.report.enabled !== enabledBefore)) throw new Error('同步范围结果未确认。');
      if (operation === 'history') {
        // 已同意后迟到的拒绝不会降级；其余结果必须明确落库。
        if (result.report.enabled !== enabledBefore) throw new Error('历史读取授权结果未确认。');
        if (historyDecision === 'accepted' && result.report.historyAuthorizationState !== 'accepted') {
          throw new Error('历史读取授权结果未确认。');
        }
        if (historyDecision === 'declined' && result.report.historyAuthorizationState === 'required') {
          throw new Error('历史读取授权结果未确认。');
        }
      }
      this.cancelRecovery();
      this.publish({ phase: 'ready', report: result.report, errorCode: null });
      if (result.report.syncScope === 'all_private') this.refreshContactDirectory(scope, result.report.confirmedBindingCount);
    } catch (error) {
      if (!current()) return;
      const unavailable = error instanceof BackendRequestFailure
        && ['sync_unavailable', 'sync_status_unavailable'].includes(error.code ?? '');
      // 删除窗口内或静默补读失败：只读刷新保留上一次成功报告，不显示“同步状态读取失败”。
      if (preserveOnFailure || operation === 'refresh' && this.quiet.deleting) {
        if (operation === 'refresh') {
          if (!background && this.state.phase === 'loading') {
            this.publish({ phase: phaseBefore, report: reportBefore, errorCode: errorCodeBefore });
          }
          // 窗口结束补读一次；补读失败后继续按退避有界恢复（含存储繁忙的真实 503）。
          if (this.quiet.deleting) this.quiet.defer(this.silentRefresh);
          if (this.transientReadFailure(error)) this.scheduleRecovery(scope);
        }
        return;
      }
      this.publish({ phase: unavailable ? 'unavailable' : 'failed', report: null,
        errorCode: operation === 'refresh' ? 'status-unconfirmed' : 'operation-unconfirmed' });
      if (operation === 'refresh' && this.transientReadFailure(error)) this.scheduleRecovery(scope);
    } finally {
      if (this.pending === pending) { this.pending = undefined; this.snapshotRefreshing = false; }
      if (current()) { this.publish({ busy: null }); this.scheduleSnapshot(scope); }
    }
  }
  /**
   * 只读状态读取的瞬时失败：连接中断、存储繁忙/压缩独占（真实后端为 503 sqlite_contact_operation_failed）、
   * 状态快照未就绪（旧后台 sync_status_unavailable）都按退避自动恢复；未配置宿主的 sync_unavailable 不重试。
   */
  private transientReadFailure(error: unknown): boolean {
    if (!(error instanceof BackendRequestFailure)) return false;
    if (error.kind === 'connection') return true;
    if (error.kind !== 'response' || error.status === undefined) return false;
    if (error.status === 409 || error.status === 429 || error.status >= 500) return error.code !== 'sync_unavailable';
    return false;
  }
  private refreshContactDirectory(scope: Scope, count: number): void {
    if (this.directoryRefresh || this.knownBindingCount === count) return;
    const refresh = { scope, count };
    this.directoryRefresh = refresh;
    // 只有共享目录实际接收成功才记住数量；失败或用户切换使读取失效时，下次快照继续重试。
    void this.contacts.refreshContactsInBackground().then((applied) => {
      if (applied && !this.disposed && this.directoryRefresh === refresh && this.scope === scope
        && scope.generation === this.backend.getConnectionGeneration()) this.knownBindingCount = count;
    }).catch(() => {}).finally(() => {
      if (this.directoryRefresh === refresh) this.directoryRefresh = undefined;
    });
  }
  private publish(update: Partial<SyncControlState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
