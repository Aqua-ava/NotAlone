import type { BackendState } from '../../shared/backend-bridge';
import { BackendFailure, readConnection } from './connection';
import { RuntimeClient } from './runtime-client';
import { loadBackendConfiguration } from './config';
import { OwnedBackendProcess } from './process';

export class BackendHost {
  private state: BackendState = { phase: 'disconnected', reused: false, revision: 0, canRetryConnection: true, canRetryShutdown: false };
  private target: RuntimeClient | undefined;
  private ownedChild: OwnedBackendProcess | undefined;
  private initialization: Promise<void> | undefined;
  private stopping: Promise<boolean> | undefined;
  private closing = false;
  private generation = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(state: BackendState) => void>();

  constructor(private readonly userData: string) {}

  getState(): BackendState { return { ...this.state }; }
  onStateChanged(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.closing || this.state.phase === 'connected') return Promise.resolve();
    if (this.initialization) return this.initialization;
    const generation = ++this.generation;
    this.publish({ phase: 'connecting', errorCode: undefined, canRetryConnection: false });
    this.initialization = this.initialize().then(() => {
      if (!this.closing) this.schedulePoll(generation);
    }).catch(async (error: unknown) => {
      const failedChild = this.ownedChild;
      if (failedChild && !this.target && await failedChild.terminate()) {
        // 已回收的失败启动不再占用下次用户明确重试；旧进程对象不参与新运行时状态。
        if (this.ownedChild === failedChild) this.ownedChild = undefined;
      }
      if (!this.closing) this.publish({ phase: 'disconnected', errorCode: error instanceof BackendFailure ? error.code : 'backend_connection_failed', canRetryConnection: true });
    }).finally(() => { this.initialization = undefined; });
    return this.initialization;
  }

  async stop(): Promise<boolean> {
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

  private async initialize(): Promise<void> {
    if (this.target) {
      // 已验证连接暂时失败时，恢复和退出仍指向它，不让变化后的握手替换关闭目标。
      if (await this.target.status() !== 'running') throw new BackendFailure('backend_connection_failed');
      if (!this.closing) this.publish({ phase: 'connected', errorCode: undefined, canRetryConnection: false });
      return;
    }
    const config = await loadBackendConfiguration(this.userData);
    const connection = await readConnection(config.infoPath);
    if (connection) {
      const client = new RuntimeClient(connection);
      if (await client.status() !== 'running') throw new BackendFailure('backend_connection_failed');
      this.target = client;
      if (!this.closing) this.publish({ phase: 'connected', reused: true, errorCode: undefined, canRetryConnection: false });
      return;
    }
    if (!config.pythonExecutable || !config.projectDirectory) throw new BackendFailure('backend_launch_unconfigured');
    if (this.ownedChild) throw new BackendFailure('backend_connection_failed');
    this.ownedChild = await OwnedBackendProcess.launch(config);
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
    for (const listener of this.listeners) listener(this.getState());
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
      this.publish({ phase: 'disconnected', errorCode: 'backend_connection_failed', canRetryConnection: true });
    }
  }
}
