import { type HistoryBoundaryView, type HistoryClearRequest, type HistoryClearState, type HistoryClearView, type HistoryResyncView, type HistoryResyncRequest } from '../../shared/history-clear-bridge';
import type { BackendHost } from '../backend/host';
import type { ContactSession } from '../contacts/session';

type Scope = { generation: number; contactId: string; scopeRevision: number };
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
export class HistoryClearController {
  private state: HistoryClearState = { revision: 0, contactId: null, scopeRevision: 0, phase: 'idle', clear: null, resync: null, busy: null, error: null };
  private scope: Scope | undefined;
  private revision = 0;
  private pending: AbortController | undefined;
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
    this.disposed = true; this.cancel(); this.listeners.clear();
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
    this.cancel(); this.scope = next;
    this.publish({ contactId: next?.contactId ?? null, scopeRevision: contact.scopeRevision, phase: 'idle',
      clear: null, resync: null, busy: null, error: null });
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
    if (this.state.busy || this.state.phase !== 'ready' || !this.state.clear) throw new Error('清空状态已变化，请刷新后确认。');
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
    if (this.state.busy || this.state.phase !== 'ready' || !this.state.clear) throw new Error('重读状态已变化，请刷新后确认。');
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
  private async read(scope: Scope): Promise<void> {
    this.cancel(); const pending = new AbortController(); this.pending = pending;
    const current = () => !this.disposed && this.scope === scope && this.pending === pending && scope.generation === this.backend.getConnectionGeneration();
    this.publish({ phase: 'loading', error: null });
    try {
      const [clear, resync] = await Promise.all([
        this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/history/clear`, signal: pending.signal }),
        this.backend.requestJson({ method: 'GET', path: `/api/contacts/${scope.contactId}/history/resync`, signal: pending.signal }),
      ]);
      if (!current() || clear.generation !== scope.generation || resync.generation !== scope.generation) return;
      this.publish({ phase: 'ready', clear: clearView(clear.data), resync: resyncView(resync.data), error: null });
    } catch {
      if (current()) this.publish({ phase: 'failed', error: '暂时无法读取聊天清空与重新同步状态，请重试。' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
}
