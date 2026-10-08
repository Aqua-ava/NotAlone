import type { SetupState } from '../../shared/setup-bridge';
import type { BackendHost } from '../backend/host';

export class SetupController {
  private state: SetupState = { phase: 'offline', ownerReady: false, credentialsConfigured: false, revision: 0 };
  private generation: number | undefined;
  private epoch = 0;
  private busy = false;
  private savedConfigPending = false;
  private savedExpectation: 'owner' | 'credentials' = 'owner';
  private readonly listeners = new Set<(state: SetupState) => void>();

  constructor(private readonly backend: BackendHost) {
    backend.onStateChanged(() => {
      const generation = backend.getConnectionGeneration();
      if (generation === this.generation) return;
      this.generation = generation;
      ++this.epoch;
      // 主动重启期间保留进度；普通保存遇到失联时仍立即失效旧界面。
      if (this.busy && this.state.phase === 'restarting') return;
      if (generation === undefined) this.publish({ phase: 'offline', ownerReady: false, credentialsConfigured: false });
      else void this.refresh();
    });
  }
  getState(): SetupState { return { ...this.state }; }
  onStateChanged(listener: (state: SetupState) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async refresh(): Promise<void> {
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) return;
    const epoch = ++this.epoch;
    const current = () => generation === this.backend.getConnectionGeneration() && epoch === this.epoch;
    this.publish({ phase: 'loading', ownerReady: false, credentialsConfigured: false, errorCode: undefined });
    try {
      const { data } = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
      const status = data as { initialized?: unknown; owner_configured?: unknown; credentials_configured?: unknown; runtime_owner_configured?: unknown };
      if (!status || typeof status.initialized !== 'boolean' || typeof status.owner_configured !== 'boolean'
        || typeof status.credentials_configured !== 'boolean' || typeof status.runtime_owner_configured !== 'boolean') throw new Error();
      const ownerReady = status.runtime_owner_configured;
      if (!current()) return;
      this.publish({ phase: ownerReady ? 'ready' : status.owner_configured ? 'identity-unbound' : 'needs-owner',
        ownerReady, credentialsConfigured: status.credentials_configured });
    } catch { if (current()) this.publish({ phase: 'failed', ownerReady: false, credentialsConfigured: false }); }
  }
  async initializeOwner(displayName: string): Promise<void> {
    if (this.busy || this.state.phase !== 'needs-owner') return;
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) return;
    this.busy = true;
    ++this.epoch;
    this.publish({ phase: 'saving', errorCode: undefined });
    try {
      // 全库状态只用于拒绝自动恢复，不能据此选择任何既有 owner。
      const status = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
      if ((status.data as { owner_configured?: unknown })?.owner_configured !== false) throw new Error();
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/initialize', body: { display_name: displayName }, maxResponseBytes: 4096 });
      const value = result.data as { owner_id?: unknown; created?: unknown };
      if (typeof value?.owner_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.owner_id)
        || typeof value.created !== 'boolean') throw new Error();
      this.savedConfigPending = true;
      this.savedExpectation = 'owner';
      await this.reloadConfiguration();
    } catch {
      if (generation === this.backend.getConnectionGeneration()) {
        await this.refresh();
        this.publish({ errorCode: 'initialize-failed' });
      }
    } finally { this.busy = false; }
  }
  async saveDeepSeekKey(apiKey: string): Promise<void> {
    if (this.busy || this.state.phase !== 'ready') return;
    const generation = this.backend.getConnectionGeneration();
    if (generation === undefined) return;
    this.busy = true;
    ++this.epoch;
    this.publish({ phase: 'saving', errorCode: undefined });
    try {
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/credentials',
        body: { provider: 'deepseek', api_key: apiKey }, maxResponseBytes: 4096 });
      const value = result.data as { provider?: unknown; configured?: unknown };
      if (value?.provider !== 'deepseek' || value.configured !== true) throw new Error();
      this.savedConfigPending = true;
      this.savedExpectation = 'credentials';
      await this.reloadConfiguration();
    } catch {
      if (generation === this.backend.getConnectionGeneration()) {
        await this.refresh();
        this.publish({ errorCode: 'credentials-failed' });
      }
    } finally { this.busy = false; }
  }
  async retryRestart(): Promise<void> {
    if (this.busy || !this.savedConfigPending) return;
    this.busy = true;
    try { await this.reloadConfiguration(); }
    finally { this.busy = false; }
  }
  private async reloadConfiguration(): Promise<void> {
    this.publish({ phase: 'restarting', ownerReady: false, credentialsConfigured: false, errorCode: undefined });
    if (!await this.backend.restart()) {
      this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' }); return;
    }
    await this.refresh();
    if (this.state.phase === 'ready' && (this.savedExpectation === 'owner' || this.state.credentialsConfigured)) this.savedConfigPending = false;
    else this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' });
  }
  private publish(update: Partial<SetupState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
