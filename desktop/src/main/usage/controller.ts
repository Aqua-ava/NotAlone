import type { UsageState } from '../../shared/usage-bridge';
import type { BackendHost } from '../backend/host';
import { readUsageSummary } from './client';
type UsageBackend = Pick<BackendHost, 'getConnectionGeneration' | 'requestJson' | 'onStateChanged'>;
export class UsageController {
  private state: UsageState = { revision: 0, phase: 'idle', summary: null, errorCode: null };
  private readonly listeners = new Set<(state: UsageState) => void>();
  private generation: number | undefined;
  private request = 0;
  private pending: AbortController | undefined;
  private refreshing: { generation: number | undefined; promise: Promise<void> } | undefined;
  constructor(private readonly backend: UsageBackend) {
    this.generation = backend.getConnectionGeneration();
    backend.onStateChanged(() => {
      const next = backend.getConnectionGeneration();
      if (next === this.generation) return;
      this.generation = next; ++this.request; this.pending?.abort(); this.pending = undefined; this.refreshing = undefined;
      this.publish({ phase: next === undefined ? 'offline' : 'idle', summary: null, errorCode: null });
    });
  }
  getState(): UsageState { return structuredClone(this.state); }
  onStateChanged(listener: (state: UsageState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  refresh(): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    if (this.refreshing && this.refreshing.generation === generation) return this.refreshing.promise;
    const reading = { generation, promise: this.read() };
    this.refreshing = reading;
    void reading.promise.finally(() => { if (this.refreshing === reading) this.refreshing = undefined; });
    return reading.promise;
  }
  private async read(): Promise<void> {
    this.pending?.abort(); const pending = new AbortController(); this.pending = pending;
    const request = ++this.request, generation = this.backend.getConnectionGeneration();
    if (generation === undefined) { this.publish({ phase: 'offline', summary: null, errorCode: null }); return; }
    const current = () => request === this.request && generation === this.backend.getConnectionGeneration();
    // 同一连接保留成功快照，后台更新失败或连接变化仍立即撤下。
    this.publish({ phase: 'loading', summary: this.state.summary, errorCode: null });
    try {
      const response = await this.backend.requestJson({ method: 'GET', path: '/api/ledger/summary', signal: pending.signal });
      if (!current()) return;
      if (response.generation !== generation) throw new Error('用量连接已变更。');
      this.publish({ phase: 'ready', summary: readUsageSummary(response.data), errorCode: null });
    } catch {
      if (current()) this.publish({ phase: 'error', summary: null, errorCode: 'usage_read_failed' });
    } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private publish(update: Omit<UsageState, 'revision'>): void {
    this.state = { ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
