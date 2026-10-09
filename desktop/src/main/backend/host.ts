import type { BackendState } from '../../shared/backend-bridge';
import { BackendFailure, readConnection } from './connection';
import { RuntimeClient } from './runtime-client';
import { loadBackendConfiguration, type BackendConfiguration } from './config';
import { OwnedBackendProcess } from './process';
import { BackendRequestFailure, type JsonRequest } from './json-client';
import type { MessageStreamCallbacks } from './message-stream';

export class BackendHost {
  private state: BackendState = { phase: 'disconnected', reused: false, revision: 0, canRetryConnection: true, canRetryShutdown: false,
    canSaveStartupPaths: true, canPrepareConfiguration: false };
  private target: RuntimeClient | undefined;
  private ownedChild: OwnedBackendProcess | undefined;
  private initialization: Promise<void> | undefined;
  private stopping: Promise<boolean> | undefined;
  private closing = false;
  private quitting = false;
  private restarting: Promise<boolean> | undefined;
  private preparing: Promise<boolean> | undefined;
  private configurationSave: Promise<void> | undefined;
  private generation = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(state: BackendState) => void>();

  constructor(private readonly userData: string,
    private readonly beforeConnect?: (config: BackendConfiguration, canStart: () => boolean) => Promise<void>) {}

  getState(): BackendState {
    return { ...this.state, canSaveStartupPaths: !this.configurationSave && this.configurationCanChange(),
      canPrepareConfiguration: !this.quitting && !this.restarting && !this.preparing && !this.stopping && !this.initialization
        && Boolean(this.target || this.ownedChild) && ['connected', 'disconnected', 'shutdown-failed'].includes(this.state.phase) };
  }
  saveStartupConfiguration(save: (canSave: () => boolean) => Promise<void>): Promise<void> {
    if (!this.getState().canSaveStartupPaths) return Promise.reject(new Error('启动配置暂时不可修改'));
    // 保存期间的新连接等待落盘；写入前仍核验实际持有的运行时，退出优先。
    this.configurationSave = Promise.resolve().then(() => save(() => this.configurationCanChange()))
      .finally(() => { this.configurationSave = undefined; this.publishEligibility(); });
    this.publishEligibility();
    return this.configurationSave;
  }
  getConnectionGeneration(): number | undefined {
    return !this.closing && this.state.phase === 'connected' && this.target ? this.generation : undefined;
  }
  subscribeMessages(callbacks: MessageStreamCallbacks, signal: AbortSignal): void {
    const target = this.target;
    const generation = this.getConnectionGeneration();
    if (!target || generation === undefined || signal.aborted) return;
    const current = () => !signal.aborted && target === this.target && generation === this.getConnectionGeneration();
    target.subscribeMessages({ connected: () => { if (current()) callbacks.connected(); },
      message: (event) => { if (current()) callbacks.message(event); },
      interrupted: () => { if (current()) callbacks.interrupted(); } }, signal);
  }
  async requestJson(options: JsonRequest): Promise<{ generation: number; data: unknown }> {
    const target = this.target;
    const generation = this.getConnectionGeneration();
    if (!target || generation === undefined) throw new BackendRequestFailure('cancelled');
    let data: unknown;
    try { data = await target.requestJson(options); }
    catch (error) {
      if (target !== this.target || generation !== this.getConnectionGeneration()) throw new BackendRequestFailure('cancelled');
      throw error;
    }
    if (target !== this.target || generation !== this.getConnectionGeneration()) throw new BackendRequestFailure('cancelled');
    return { generation, data };
  }
  onStateChanged(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.closing || this.state.phase === 'connected') return Promise.resolve();
    if (this.configurationSave) return this.configurationSave.catch(() => {}).then(() => this.connect());
    if (this.initialization) return this.initialization;
    const generation = ++this.generation;
    clearTimeout(this.pollTimer);
    this.target?.cancelPending();
    this.publish({ phase: 'connecting', errorCode: undefined, canRetryConnection: false });
    this.initialization = this.initialize(generation).then(() => {
      if (!this.closing) this.schedulePoll(generation);
    }).catch(async (error: unknown) => {
      const failedChild = this.ownedChild;
      if (failedChild && !this.target && await failedChild.terminate()) {
        // 已回收的失败启动不再占用下次用户明确重试；旧进程对象不参与新运行时状态。
        if (this.ownedChild === failedChild) this.ownedChild = undefined;
      }
      if (!this.closing && generation === this.generation) this.publish({ phase: 'disconnected', errorCode: error instanceof BackendFailure ? error.code : 'backend_connection_failed', canRetryConnection: true });
    }).finally(() => { this.initialization = undefined; this.publishEligibility(); });
    return this.initialization;
  }

  async stop(): Promise<boolean> {
    this.quitting = true;
    return this.stopRuntime();
  }

  restart(): Promise<boolean> {
    if (this.quitting) return Promise.resolve(false);
    if (this.restarting) return this.restarting;
    if (this.preparing) return Promise.resolve(false);
    this.restarting = this.restartRuntime().finally(() => { this.restarting = undefined; this.publishEligibility(); });
    return this.restarting;
  }

  prepareConfiguration(): Promise<boolean> {
    if (this.quitting || this.restarting) return Promise.resolve(false);
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareRuntime().finally(() => { this.preparing = undefined; this.publishEligibility(); });
    return this.preparing;
  }

  private async stopRuntime(): Promise<boolean> {
    if (this.state.phase === 'stopped') return true;
    if (this.stopping) return this.stopping;
    this.closing = true;
    ++this.generation;
    clearTimeout(this.pollTimer);
    this.target?.cancelPending();
    this.publish({ phase: 'stopping', errorCode: undefined, canRetryConnection: false, canRetryShutdown: false });
    this.stopping = this.shutdown().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async restartRuntime(): Promise<boolean> {
    if (!await this.prepareRuntime() || this.quitting) return false;
    await this.connect();
    return this.getConnectionGeneration() !== undefined;
  }

  private async prepareRuntime(): Promise<boolean> {
    if (!await this.stopRuntime() || this.quitting) return false;
    // 连接中停读也可能在等待后获得目标；固定 shutdown 实际确认的那个实例。
    const previous = this.target;
    if (previous) {
      const deadline = Date.now() + 5000;
      while (await previous.isListening()) {
        if (this.quitting) return false;
        if (Date.now() >= deadline) {
          this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (this.quitting) return false;
    if (this.ownedChild?.isRunning()) {
      this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
      return false;
    }
    this.target = undefined;
    this.ownedChild = undefined;
    this.closing = false;
    this.publish({ phase: 'disconnected', errorCode: undefined, reused: false, canRetryConnection: true, canRetryShutdown: false });
    return true;
  }

  private async initialize(generation: number): Promise<void> {
    const canStart = () => !this.closing && generation === this.generation;
    const config = await loadBackendConfiguration(this.userData);
    if (!canStart()) return;
    await this.beforeConnect?.(config, canStart);
    if (!canStart()) return;
    const connection = await readConnection(config.infoPath);
    if (!canStart()) return;
    if (connection) {
      // 原自建进程仍存活时不移交另一实例；退出仍须回收本 App 已持有的运行时。
      if (this.ownedChild?.isRunning() && connection.pid !== this.ownedChild.pid) throw new BackendFailure('backend_handshake_invalid');
      const client = new RuntimeClient(connection);
      if (await client.status() !== 'running') throw new BackendFailure('backend_connection_failed');
      // 正常明确重连可验证新握手；退出一旦开始，认证中的新目标也不能替换原目标。
      if (!canStart()) return;
      this.target?.cancelPending();
      this.target = client;
      this.publish({ phase: 'connected', reused: !(this.ownedChild?.isRunning() && connection.pid === this.ownedChild.pid), errorCode: undefined, canRetryConnection: false });
      return;
    }
    // 丢失握手不能成为另起读取进程的依据；保留原目标供明确退出使用。
    if (this.target) throw new BackendFailure('backend_connection_failed');
    if (!config.pythonExecutable || !config.projectDirectory) throw new BackendFailure('backend_launch_unconfigured');
    if (this.ownedChild) throw new BackendFailure('backend_connection_failed');
    this.ownedChild = await OwnedBackendProcess.launch(config, canStart);
    // spawn 已完成的子进程仍须取得认证目标并收尾；取消检查只阻止新的 spawn。
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && this.ownedChild.isRunning()) {
      const started = await readConnection(config.infoPath);
      if (started) {
        if (started.pid !== this.ownedChild.pid) throw new BackendFailure('backend_handshake_invalid');
        const client = new RuntimeClient(started);
        if (await client.status() !== 'running') throw new BackendFailure('backend_connection_failed');
        this.target = client;
        if (!this.closing) this.publish({ phase: 'connected', reused: false, errorCode: undefined, canRetryConnection: false });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new BackendFailure('backend_connection_failed');
  }

  private async shutdown(): Promise<boolean> {
    await this.initialization;
    if (!this.target) {
      if (!this.ownedChild) return true;
      this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
      return false;
    }
    try {
      // 成功 POST 只有 stop 完成后才产生；服务可能随后关闭，不能强求第二次 GET。
      if (await this.target.shutdown() !== 'stopped') throw new BackendFailure('backend_shutdown_unconfirmed');
    } catch {
      try {
        if (await this.target.status() !== 'stopped') throw new BackendFailure('backend_shutdown_unconfirmed');
      } catch {
        this.publish({ phase: 'shutdown-failed', errorCode: 'backend_shutdown_unconfirmed', canRetryShutdown: true });
        return false;
      }
    }
    if (this.ownedChild && this.target.connection.pid === this.ownedChild.pid) {
      if (!await this.ownedChild.waitForExit(2500)) await this.ownedChild.terminate();
    }
    this.publish({ phase: 'stopped', errorCode: undefined, canRetryShutdown: false });
    return true;
  }

  private publish(update: Partial<BackendState>): void {
    this.state = { ...this.state, ...update, revision: this.state.revision + 1 };
    this.state = this.getState();
    for (const listener of this.listeners) listener(this.getState());
  }

  private configurationCanChange(): boolean {
    return this.state.phase === 'disconnected' && !this.target && !this.ownedChild && !this.initialization
      && !this.closing && !this.quitting && !this.preparing && !this.restarting && !this.stopping;
  }

  private publishEligibility(): void {
    const next = this.getState();
    if (next.canSaveStartupPaths !== this.state.canSaveStartupPaths
      || next.canPrepareConfiguration !== this.state.canPrepareConfiguration) this.publish({});
  }

  private schedulePoll(generation: number): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.refresh(generation), 1000);
  }

  private async refresh(generation: number): Promise<void> {
    const client = this.target;
    if (!client || this.closing || generation !== this.generation || this.state.phase !== 'connected') return;
    try {
      const state = await client.status();
      if (this.closing || generation !== this.generation || client !== this.target) return;
      if (state !== 'running') throw new BackendFailure('backend_connection_failed');
      this.schedulePoll(generation);
    } catch {
      if (this.closing || generation !== this.generation || client !== this.target) return;
      client.cancelPending();
      ++this.generation;
      this.publish({ phase: 'disconnected', errorCode: 'backend_connection_failed', canRetryConnection: true });
    }
  }
}
