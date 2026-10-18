import { isUuid } from '../uuid';
import type { SetupState } from '../../shared/setup-bridge';
import type { BackendHost } from '../backend/host';

type Operation = { generation: number; epoch: number };

export class SetupController {
  private state: SetupState = { phase: 'offline', ownerReady: false, credentialsConfigured: false, revision: 0 };
  private generation: number | undefined;
  private epoch = 0;
  private busy = false;
  private savedConfigPending = false;
  private savedExpectation: 'owner' | 'credentials' | 'official' = 'owner';
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
    const operation = this.beginOperation();
    if (operation) await this.readStatus(operation);
  }
  private async readStatus(operation: Operation): Promise<void> {
    this.publish({ phase: 'loading', ownerReady: false, credentialsConfigured: false, errorCode: undefined });
    try {
      const { data } = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
      const status = data as { initialized?: unknown; owner_configured?: unknown; credentials_configured?: unknown; runtime_owner_configured?: unknown; official_deepseek_defaults?: unknown };
      if (!status || typeof status.initialized !== 'boolean' || typeof status.owner_configured !== 'boolean'
        || typeof status.credentials_configured !== 'boolean' || typeof status.runtime_owner_configured !== 'boolean') throw new Error();
      const ownerReady = status.runtime_owner_configured;
      if (!this.isCurrent(operation)) return;
      this.publish({ phase: ownerReady ? 'ready' : status.owner_configured ? 'identity-unbound' : 'needs-owner',
        ownerReady, credentialsConfigured: status.credentials_configured,
        officialDefaults: typeof status.official_deepseek_defaults === 'boolean' ? status.official_deepseek_defaults : undefined });
    } catch { if (this.isCurrent(operation)) this.publish({ phase: 'failed', ownerReady: false, credentialsConfigured: false }); }
  }
  async initializeOwner(displayName: string): Promise<void> {
    if (this.state.phase !== 'needs-owner') return;
    await this.writeConfiguration('owner', async () => {
      // 全库状态只用于拒绝自动恢复，不能据此选择任何既有 owner。
      const status = await this.backend.requestJson({ method: 'GET', path: '/api/setup/status', maxResponseBytes: 4096 });
      if ((status.data as { owner_configured?: unknown })?.owner_configured !== false) throw new Error();
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/initialize', body: { display_name: displayName, create_only: true }, maxResponseBytes: 4096 });
      const value = result.data as { owner_id?: unknown; created?: unknown };
      if (!isUuid(value?.owner_id)
        || value.created !== true) throw new Error();
    });
  }
  async saveDeepSeekKey(apiKey: string): Promise<void> {
    if (this.state.phase !== 'ready') return;
    await this.writeConfiguration('credentials', async () => {
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/credentials',
        body: { provider: 'deepseek', api_key: apiKey }, maxResponseBytes: 4096 });
      const value = result.data as { provider?: unknown; configured?: unknown };
      if (value?.provider !== 'deepseek' || value.configured !== true) throw new Error();
    });
  }
  async saveOfficialDeepSeekKey(apiKey: string): Promise<void> {
    if (this.state.phase !== 'ready') return;
    await this.writeConfiguration('official', async () => {
      const result = await this.backend.requestJson({ method: 'POST', path: '/api/setup/official-deepseek',
        body: { api_key: apiKey, confirm_official_defaults: true }, maxResponseBytes: 4096 });
      const value = result.data as { configured?: unknown; official_deepseek_defaults?: unknown };
      if (value.configured !== true || value.official_deepseek_defaults !== true) throw new Error();
    });
  }
  private async writeConfiguration(kind: 'owner' | 'credentials' | 'official', write: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    const operation = this.beginOperation();
    if (!operation) return;
    this.busy = true;
    this.publish({ phase: 'saving', errorCode: undefined });
    try {
      await write();
      if (!this.isCurrent(operation)) return;
      this.savedConfigPending = true;
      this.savedExpectation = kind;
      await this.reloadConfiguration();
    } catch {
      if (!this.isCurrent(operation)) return;
      const recovery = this.beginOperation();
      if (!recovery || recovery.generation !== operation.generation) return;
      await this.readStatus(recovery);
      // 自己的恢复查询返回也需复核；断线或较新查询不能被旧保存错误覆盖。
      if (this.isCurrent(recovery)) this.publish({ errorCode: kind === 'owner' ? 'initialize-failed' : 'credentials-failed' });
    } finally { this.busy = false; }
  }
  async retryRestart(): Promise<void> {
    if (this.busy || !this.savedConfigPending) return;
    this.busy = true;
    try { await this.reloadConfiguration(); }
    finally { this.busy = false; }
  }
  async reloadControlledConfiguration(): Promise<void> {
    if (this.busy || this.state.phase !== 'identity-unbound' || this.backend.getConnectionGeneration() === undefined) return;
    this.savedConfigPending = true;
    this.savedExpectation = 'owner';
    await this.retryRestart();
  }
  private async reloadConfiguration(): Promise<void> {
    this.publish({ phase: 'restarting', ownerReady: false, credentialsConfigured: false, errorCode: undefined });
    if (!await this.backend.restart()) {
      this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' }); return;
    }
    const operation = this.beginOperation();
    if (!operation) { this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' }); return; }
    await this.readStatus(operation);
    if (!this.isCurrent(operation)) return;
    if (this.state.phase === 'ready' && (this.savedExpectation === 'owner' || this.state.credentialsConfigured
      && (this.savedExpectation !== 'official' || this.state.officialDefaults === true))) this.savedConfigPending = false;
    else this.publish({ phase: 'restart-failed', errorCode: 'reload-failed' });
  }
  private beginOperation(): Operation | undefined {
    const generation = this.backend.getConnectionGeneration();
    return generation === undefined ? undefined : { generation, epoch: ++this.epoch };
  }
  private isCurrent(operation: Operation): boolean {
    return operation.generation === this.backend.getConnectionGeneration() && operation.epoch === this.epoch;
  }
  private publish(update: Partial<SetupState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.getState());
  }
}
