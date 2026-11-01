import { historyRecertifyFailureMessage, type HistoryBoundaryView, type HistoryClearRequest, type HistoryClearState, type HistoryClearView, type HistoryResyncView, type HistoryResyncRequest, type HistoryRecertifyView, type HistoryRecertifyRequest, type HistoryRecertifyCancelRequest } from '../../shared/history-clear-bridge';
import { BackendRequestFailure } from '../backend/json-client';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';

type Scope = { generation: number; contactId: string; scopeRevision: number };
type OwnedRecertification = Scope & { requestKey: string };
const phases = new Set(['none', 'boundary_pending', 'cleaning', 'cleanup_blocked', 'completed']);
const boundaryStates = new Set(['pending', 'verified', 'blocked']);
const resyncStates = new Set(['none', 'authorized', 'active', 'completed']);
const goalPhases = new Set(['not_started', 'syncing', 'complete', 'incomplete']);
const text = (value: unknown, max = 512): string | null => typeof value === 'string' && value.length <= max ? value : null;
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function clearView(value: unknown): HistoryClearView {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== 'object' || typeof row.contact_id !== 'string' || !phases.has(String(row.phase))
    || typeof row.completed !== 'boolean' || typeof row.boundary_pending !== 'boolean') throw new Error('清空状态格式无法确认。');
  let boundary: HistoryBoundaryView | null = null;
  const raw = row.boundary as Record<string, unknown> | null | undefined;
  if (raw != null) {
    if (typeof raw !== 'object' || !boundaryStates.has(String(raw.state))) throw new Error('清空状态格式无法确认。');
    boundary = { state: raw.state as HistoryBoundaryView['state'], barrierGeneration: String(raw.barrier_generation ?? ''),
      manifestSha256: text(raw.manifest_sha256, 64), memberCount: typeof raw.member_count === 'number' ? count(raw.member_count) : null,
      reason: text(raw.reason), establishedAt: text(raw.established_at, 40) };
  }
  return { contactId: row.contact_id, phase: row.phase as HistoryClearView['phase'], completed: row.completed,
    boundary, boundaryPending: row.boundary_pending, failureCode: text(row.failure_code), boundaryReason: text(row.boundary_reason),
    storedMessages: count(row.stored_messages), storedSources: count(row.stored_sources), openGoals: count(row.open_goals) };
}
function resyncView(value: unknown): HistoryResyncView {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== 'object' || typeof row.contact_id !== 'string' || (row.request_key !== null && typeof row.request_key !== 'string')
    || !resyncStates.has(String(row.state)) || typeof row.completed !== 'boolean') throw new Error('重读状态格式无法确认。');
  let goalPhase: HistoryResyncView['goalPhase'] = null;
  let messageCount = 0, nonTextCount = 0, failureCode: string | null = null;
  const goal = row.goal as Record<string, unknown> | null | undefined;
  if (goal != null) {
    if (typeof goal !== 'object' || !goalPhases.has(String(goal.phase))) throw new Error('重读状态格式无法确认。');
    goalPhase = goal.phase as HistoryResyncView['goalPhase'];
    messageCount = count(goal.message_count); nonTextCount = count(goal.non_text_count); failureCode = text(goal.failure_code);
  }
  return { contactId: row.contact_id, requestKey: typeof row.request_key === 'string' ? row.request_key : null, state: row.state as HistoryResyncView['state'],
    completed: row.completed, goalPhase, messageCount, nonTextCount, failureCode };
}
function recertifyView(value: unknown, contactId: string): HistoryRecertifyView {
  const row = value as Record<string, unknown> | null;
  const keys = ['contact_id', 'request_key', 'state', 'stage', 'completed', 'failure_code', 'message_count', 'non_text_count', 'page_count', 'preserved_message_count', 'started_at', 'finished_at'];
  const safeCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const time = (v: unknown) => v === null || safeCount(v);
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))
    || row.contact_id !== contactId || !['none', 'running', 'completed', 'failed', 'interrupted'].includes(String(row.state))
    || !['none', 'metadata', 'history', 'activation', 'completed'].includes(String(row.stage))
    || typeof row.completed !== 'boolean' || row.completed !== (row.state === 'completed')
    || !['message_count', 'non_text_count', 'page_count', 'preserved_message_count'].every(key => safeCount(row[key]))
    || !time(row.started_at) || !time(row.finished_at) || row.failure_code !== null && (typeof row.failure_code !== 'string' || !/^[a-z0-9_]{1,160}$/.test(row.failure_code))) throw new Error('来源认证状态格式无法确认。');
  if (row.state === 'none' ? row.request_key !== null || row.stage !== 'none' || row.started_at !== null || row.finished_at !== null
    : typeof row.request_key !== 'string' || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(row.request_key) || row.started_at === null) throw new Error('来源认证状态格式无法确认。');
  if (row.state === 'completed' && (row.stage !== 'completed' || row.failure_code !== null || row.finished_at === null)
    || row.state === 'running' && (!['metadata', 'history', 'activation'].includes(String(row.stage)) || row.finished_at !== null)) throw new Error('来源认证状态格式无法确认。');
  return { contactId, requestKey: row.request_key as string | null, state: row.state as HistoryRecertifyView['state'], stage: row.stage as HistoryRecertifyView['stage'],
    completed: row.completed, failureCode: row.failure_code as string | null, messageCount: row.message_count as number, nonTextCount: row.non_text_count as number,
    pageCount: row.page_count as number, preservedMessageCount: row.preserved_message_count as number, startedAt: row.started_at as number | null, finishedAt: row.finished_at as number | null };
}
export class HistoryClearController {
  private state: HistoryClearState = { revision: 0, contactId: null, scopeRevision: 0, phase: 'idle', clear: null, resync: null, recertify: null, pendingRecertifyKey: null, recertifyStoppingKey: null, recertifyCancelBusy: false, busy: null, error: null };
  private scope: Scope | undefined;
  private revision = 0;
  private pending: AbortController | undefined;
  private admission: AbortController | undefined;
  private ownedRecertification: OwnedRecertification | undefined;
  private readonly cancelRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly listeners = new Set<(state: HistoryClearState) => void>();
  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    contacts.onStateChanged(() => this.synchronizeScope());
    backend.onStateChanged(() => this.synchronizeScope());
    this.synchronizeScope();
  }
  getState(): HistoryClearState { return structuredClone(this.state); }
  onStateChanged(listener: (state: HistoryClearState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  dispose(): void {
    if (this.disposed) return;
    const owned = this.ownedRecertification; this.ownedRecertification = undefined;
    this.disposed = true; this.cancel(); this.admission?.abort(); this.admission = undefined;
    for (const timer of this.cancelRetryTimers) clearTimeout(timer); this.cancelRetryTimers.clear(); this.listeners.clear();
    if (owned) void this.stopRecertification(owned, false);
  }
  private publish(patch: Partial<HistoryClearState>): void {
    const next = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.state = next;
    for (const listener of this.listeners) listener(this.getState());
  }
  private cancel(): void { this.pending?.abort(); this.pending = undefined; ++this.revision; }
  private synchronizeScope(): void {
    if (this.disposed) return;
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const contactId = contact.selectedContactId;
    const allowed = generation !== undefined && contactId !== null
      && ['ready', 'loading'].includes(contact.directoryPhase) && contact.contacts.some(entry => entry.contactId === contactId);
    const next = allowed ? { generation, contactId: contactId!, scopeRevision: contact.scopeRevision } : undefined;
    if (next?.generation === this.scope?.generation && next?.contactId === this.scope?.contactId
      && next?.scopeRevision === this.scope?.scopeRevision) return;
    const owned = this.ownedRecertification; this.ownedRecertification = undefined;
    this.cancel(); this.admission?.abort(); this.admission = undefined; this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, phase: 'idle',
      clear: null, resync: null, recertify: null, pendingRecertifyKey: null, recertifyStoppingKey: null, recertifyCancelBusy: false, busy: null, error: null });
    if (owned) void this.stopRecertification(owned, false);
    if (next) void this.read(next);
  }
  private assertScope(request: HistoryClearRequest): Scope {
    this.synchronizeScope();
    if (!this.scope || request.contactId !== this.scope.contactId || request.scopeRevision !== this.scope.scopeRevision
      || this.scope.generation !== this.backend.getConnectionGeneration()) throw new Error('联系人范围已变化，请重新确认联系人。');
    return this.scope;
  }
  async refresh(request: HistoryClearRequest): Promise<void> { await this.read(this.assertScope(request)); }
  async clear(request: HistoryClearRequest): Promise<void> {
    const scope = this.assertScope(request);
    if (this.state.busy || this.state.phase !== 'ready' || !this.state.clear || this.state.pendingRecertifyKey || this.state.recertifyStoppingKey || this.state.recertify?.state === 'running') throw new Error('清空状态已变化，请刷新后确认。');
    this.cancel(); const pending = new AbortController(); this.pending = pending;
    const current = () => !this.disposed && this.scope === scope && this.pending === pending;
    try {
      this.publish({ busy: 'clear', error: null });
      // 清空是用户明确操作：请求体为空，范围只由已核验联系人与当前同步选择决定。
      const response = await this.backend.requestJson({ method: 'POST', path: `/api/contacts/${scope.contactId}/history/clear`, body: {}, signal: pending.signal, timeoutMs: 120_000 });
      if (!current() || response.generation !== scope.generation) throw new Error('连接已变化。');
      const clear = clearView(response.data);
      this.publish({ clear, busy: null });
      await this.read(scope);
    } catch {
      if (current()) this.publish({ busy: null, error: '清空结果尚未确认，请刷新核对；请求失败不等于未执行。' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  async resync(request: HistoryResyncRequest): Promise<void> {
    const scope = this.assertScope(request);
    if (this.state.busy || this.state.phase !== 'ready' || !this.state.clear || this.state.pendingRecertifyKey || this.state.recertifyStoppingKey || this.state.recertify?.state === 'running') throw new Error('重读状态已变化，请刷新后确认。');
    this.cancel(); const pending = new AbortController(); this.pending = pending;
    const current = () => !this.disposed && this.scope === scope && this.pending === pending;
    try {
      this.publish({ busy: 'resync', error: null });
      const response = await this.backend.requestJson({ method: 'POST', path: `/api/contacts/${scope.contactId}/history/resync`,
        body: { request_key: request.requestKey }, signal: pending.signal, timeoutMs: 120_000 });
      if (!current() || response.generation !== scope.generation) throw new Error('连接已变化。');
      const resync = resyncView(response.data);
      this.publish({ resync, busy: null });
      await this.read(scope);
    } catch {
      if (current()) this.publish({ busy: null, error: '重新同步结果尚未确认，请刷新核对；请求失败不等于未执行。' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  async recertify(request: HistoryRecertifyRequest): Promise<void> {
    const scope = this.assertScope(request);
    if (request.confirmed !== true || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(request.requestKey)
      || this.state.busy || this.admission || this.state.phase !== 'ready' || !this.state.recertify || this.state.pendingRecertifyKey || this.state.recertifyStoppingKey || this.state.recertify.state === 'running') throw new Error('请先查询当前认证结果，再明确确认新操作。');
    const pending = new AbortController(); this.admission = pending;
    const operation = { ...scope, requestKey: request.requestKey }; this.ownedRecertification = operation;
    const current = () => !this.disposed && this.scope === scope && this.admission === pending && scope.generation === this.backend.getConnectionGeneration();
    this.publish({ busy: 'recertify', pendingRecertifyKey: request.requestKey, error: null });
    try {
      const response = await this.backend.requestJson({ method: 'POST', path: `/api/contacts/${scope.contactId}/history/recertify`,
        body: { request_key: request.requestKey }, signal: pending.signal, timeoutMs: 10_000 });
      if (!current() || response.generation !== scope.generation) return;
      const recertify = recertifyView(response.data, scope.contactId);
      if (recertify.requestKey !== request.requestKey || recertify.state === 'none') throw new Error('本次认证结果尚未确认。');
      const known = this.state.recertify;
      if (known?.requestKey === request.requestKey && ['completed', 'failed', 'interrupted'].includes(known.state)) this.publish({ busy: null });
      else this.acceptRecertification(recertify, { busy: null }, true);
    } catch (error) {
      if (current()) {
        if (this.state.recertify?.requestKey === request.requestKey && this.state.recertify.state !== 'none') { this.publish({ busy: null }); return; }
        const rejected = error instanceof BackendRequestFailure && error.kind === 'response' && error.status !== undefined && error.status >= 400 && error.status < 500;
        if (rejected && this.ownedRecertification === operation) this.ownedRecertification = undefined;
        this.publish({ busy: null, ...(rejected ? { pendingRecertifyKey: null } : {}), error: rejected ? historyRecertifyFailureMessage(error.code ?? null)
          : '本次来源认证结果尚未确认，请查询本次认证状态；未确认前不会开启另一轮认证。' });
        if (rejected && error.code === 'history_recertify_already_running') await this.read(scope, null);
      }
    } finally { if (this.admission === pending) this.admission = undefined; }
  }
  private acceptRecertification(recertify: HistoryRecertifyView, patch: Partial<HistoryClearState> = {}, admissionResponse = false): void {
    const known = this.state.recertify;
    // 独立运输可能乱序到达；同一键的稳定终态不能被先前的 running 回包降级。
    if (known?.requestKey === recertify.requestKey && known.contactId === recertify.contactId && ['completed', 'failed', 'interrupted'].includes(known.state)) recertify = known;
    const terminal = ['completed', 'failed', 'interrupted'].includes(recertify.state);
    if (terminal && this.ownedRecertification?.requestKey === recertify.requestKey && this.ownedRecertification.contactId === recertify.contactId) {
      this.ownedRecertification = undefined;
      // 精确终态已经持久确认，才可收掉仍在等待的接纳运输；普通进度读取不取消它。
      if (!admissionResponse && this.admission) { this.admission.abort(); this.admission = undefined; patch = { ...patch, busy: null }; }
    }
    this.publish({ recertify, pendingRecertifyKey: null, ...(terminal ? { recertifyStoppingKey: null, recertifyCancelBusy: false } : {}), ...patch });
  }
  async cancelRecertify(request: HistoryRecertifyCancelRequest): Promise<void> {
    const scope = this.assertScope(request);
    const key = this.state.recertifyStoppingKey ?? this.state.pendingRecertifyKey ?? (this.state.recertify?.state === 'running' ? this.state.recertify.requestKey : null);
    if (!key || request.requestKey !== key || this.state.recertifyCancelBusy) throw new Error('请先核对当前认证操作。');
    const operation = { ...scope, requestKey: key }; this.ownedRecertification = operation;
    await this.stopRecertification(operation, true);
  }
  private async stopRecertification(operation: OwnedRecertification, visible: boolean): Promise<void> {
    if (operation.generation !== this.backend.getConnectionGeneration()) return;
    const current = () => visible && !this.disposed && this.scope?.contactId === operation.contactId && this.scope.scopeRevision === operation.scopeRevision && this.scope.generation === operation.generation;
    if (current()) this.publish({ recertifyStoppingKey: operation.requestKey, recertifyCancelBusy: true, error: null });
    try {
      const response = await this.backend.requestJson({ method: 'POST', path: `/api/contacts/${operation.contactId}/history/recertify/cancel`, body: { request_key: operation.requestKey }, timeoutMs: 10_000 });
      if (response.generation !== operation.generation) throw new Error('连接已变化。');
      const result = recertifyView(response.data, operation.contactId);
      if (result.requestKey !== operation.requestKey || result.state === 'none') throw new Error('停止结果尚未确认。');
      if (current()) {
        const known = this.state.recertify;
        if (known?.requestKey === operation.requestKey && ['completed', 'failed', 'interrupted'].includes(known.state)) this.publish({ recertifyCancelBusy: false });
        else this.acceptRecertification(result, { recertifyCancelBusy: false, error: null });
      }
    } catch {
      if (current()) this.publish({ recertifyCancelBusy: false, error: '停止结果尚未确认，请查询或重试停止同一认证；不会重新提交认证。' });
      else if (!this.disposed && operation.generation === this.backend.getConnectionGeneration()) {
        // 离开范围后只重试精确停止，绝不借用新范围或重新接纳来源读取。
        const timer = setTimeout(() => { this.cancelRetryTimers.delete(timer); void this.stopRecertification(operation, false); }, 2000);
        this.cancelRetryTimers.add(timer);
      }
    }
  }
  private async read(scope: Scope, requestedKey?: string | null): Promise<void> {
    this.cancel(); const pending = new AbortController(); this.pending = pending;
    const current = () => !this.disposed && this.scope === scope && this.pending === pending && scope.generation === this.backend.getConnectionGeneration();
    this.publish({ phase: 'loading', error: null });
    const key = requestedKey === undefined ? this.state.pendingRecertifyKey ?? this.state.recertifyStoppingKey ?? this.ownedRecertification?.requestKey ?? this.state.recertify?.requestKey : requestedKey;
    try {
      const [clear, resync, recertify] = await Promise.all([
        this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/history/clear`, signal: pending.signal }),
        this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/history/resync`, signal: pending.signal }),
        this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/history/recertify${key ? `?request_key=${encodeURIComponent(key)}` : ''}`, signal: pending.signal }),
      ]);
      if (!current() || clear.generation !== scope.generation || resync.generation !== scope.generation || recertify.generation !== scope.generation) return;
      const next = recertifyView(recertify.data, scope.contactId), unconfirmed = !!key && next.requestKey !== key;
      const patch = { phase: 'ready' as const, clear: clearView(clear.data), resync: resyncView(resync.data), error: unconfirmed ? '尚未查到本次认证的确定结果，请继续查询；不会自动重发或开启另一轮认证。' : null };
      if (unconfirmed) this.publish(patch); else this.acceptRecertification(next, patch);
    } catch {
      if (current()) {
        const unresolved = this.state.pendingRecertifyKey ?? this.state.recertifyStoppingKey ?? this.ownedRecertification?.requestKey
          ?? (this.state.recertify?.state === 'running' ? this.state.recertify.requestKey : null);
        this.publish({ phase: 'failed', recertify: null, pendingRecertifyKey: unresolved, error: '暂时无法读取聊天与来源认证状态，请查询本次状态或停止本次认证。' });
      }
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
}
