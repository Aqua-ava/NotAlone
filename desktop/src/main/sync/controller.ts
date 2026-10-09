import type { SyncControlState, SyncSwitchRequest } from '../../shared/sync-control-bridge';
import type { BackendHost } from '../backend/host';
import { BackendRequestFailure } from '../backend/json-client';
import type { ContactSession } from '../contacts/session';
import { readSyncStatus, setSyncEnabled } from './status';

type Scope = { generation: number; scopeRevision: number };
type Operation = 'refresh' | 'enable' | 'disable';

export class SyncControlController {
  private state: SyncControlState = { revision: 0, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };
  private scope: Scope | undefined;
  private epoch = 0;
  private pending: AbortController | undefined;
  private readonly listeners = new Set<(state: SyncControlState) => void>();

  constructor(private readonly backend: BackendHost, private readonly contacts: ContactSession) {
    backend.onStateChanged(() => this.synchronizeScope());
    contacts.onStateChanged(() => this.synchronizeScope());
    this.synchronizeScope();
  }
  getState(): SyncControlState { return structuredClone(this.state); }
  onStateChanged(listener: (state: SyncControlState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private synchronizeScope(): void {
    const generation = this.backend.getConnectionGeneration();
    const contact = this.contacts.getState();
    const next = generation !== undefined && ['ready', 'loading'].includes(contact.directoryPhase)
      ? { generation, scopeRevision: contact.scopeRevision } : undefined;
    if (next?.generation === this.scope?.generation && next?.scopeRevision === this.scope?.scopeRevision
      && contact.scopeRevision === this.state.scopeRevision) return;
    this.pending?.abort(); this.pending = undefined; ++this.epoch;
    this.scope = next;
    this.publish({ scopeRevision: contact.scopeRevision, phase: generation === undefined ? 'offline' : 'unavailable',
      report: null, busy: null, errorCode: null });
    // 只读取缓存状态，不启动正文周期或把历史定位结果当作当前联系人。
    if (next) void this.refresh();
  }
  async refresh(): Promise<void> {
    this.synchronizeScope();
    if (!this.scope || this.pending) return;
    await this.perform('refresh', this.scope);
  }
  enable(request: SyncSwitchRequest): Promise<void> { return this.switch(request, 'enable'); }
  disable(request: SyncSwitchRequest): Promise<void> { return this.switch(request, 'disable'); }
  private async switch(request: SyncSwitchRequest, operation: 'enable' | 'disable'): Promise<void> {
    this.synchronizeScope();
    if (!this.scope || this.pending || this.state.phase !== 'ready' || !this.state.report
      || request.scopeRevision !== this.state.scopeRevision) throw new Error('本次同步范围已失效，请刷新状态后重试。');
    await this.perform(operation, this.scope);
  }
  private async perform(operation: Operation, scope: Scope): Promise<void> {
    const epoch = ++this.epoch;
    const pending = new AbortController();
    this.pending = pending;
    const current = () => !pending.signal.aborted && scope === this.scope && epoch === this.epoch
      && scope.generation === this.backend.getConnectionGeneration()
      && scope.scopeRevision === this.contacts.getState().scopeRevision;
    this.publish({ phase: 'loading', report: null, busy: operation === 'refresh' ? null : operation, errorCode: null });
    try {
      const result = operation === 'refresh' ? await readSyncStatus(this.backend, pending.signal)
        : await setSyncEnabled(this.backend, operation === 'enable', pending.signal);
      if (!current() || result.generation !== scope.generation) return;
      if (operation !== 'refresh' && result.report.enabled !== (operation === 'enable')) throw new Error('同步结果未确认。');
      this.publish({ phase: 'ready', report: result.report });
    } catch (error) {
      if (!current()) return;
      const unavailable = error instanceof BackendRequestFailure
        && ['sync_unavailable', 'sync_status_unavailable'].includes(error.code ?? '');
      this.publish({ phase: unavailable ? 'unavailable' : 'failed', report: null,
        errorCode: operation === 'refresh' ? 'status-unconfirmed' : 'operation-unconfirmed' });
    } finally {
      if (this.pending === pending) this.pending = undefined;
      if (current()) this.publish({ busy: null });
    }
  }
  private publish(update: Partial<SyncControlState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
