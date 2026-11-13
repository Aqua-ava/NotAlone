import { BackendFailure, type BackendConnection } from './connection';
import { JsonClient, type JsonRequest } from './json-client';
import { createConnection } from 'node:net';
import { openMessageStream, type MessageStreamCallbacks } from './message-stream';

type RuntimeState = 'running' | 'stopping' | 'stopped';
type RuntimeReply = {state: RuntimeState; shutdownFailed: boolean; shutdownProtocol?: 'poll-v1'};
const defaultShutdownTimeoutMs = 30_000;
// 后端已分阶段设置硬上限（合计约 23 秒）；超过桌面等待上限仍无结果，说明其停读流程无法自行完成。
// 与“后端明确报告失败”区分：只有本类才允许对本 App 自有进程升级为强制回收。
export class BackendShutdownTimeout extends BackendFailure {
  constructor() { super('backend_shutdown_unconfirmed'); }
}
export class RetiredBackendRuntime extends BackendFailure {
  constructor() { super('backend_connection_failed'); }
}
// 后台进程仍在应答且数据库身份一致，但存储线程已被终止（动作超时或线程退出）。存储层设计上不自动重开，
// 该进程不会自行恢复；与“旧实现／换库”不同，自有进程可以整体重启来恢复。
export class BackendStorageUnavailable extends RetiredBackendRuntime {}

// 方法和路径由主进程固定，既不跟随重定向，也不接收渲染层 URL。
export class RuntimeClient {
  private readonly transport: JsonClient;
  private readonly streams = new Set<AbortController>();
  private shutdownProtocol: 'poll-v1' | undefined;
  constructor(readonly connection: BackendConnection, private readonly expectedRuntime?: 'dsh',
    private readonly expectedStorage?: {databaseId: string; ownerId: string}, private readonly shutdownTimeoutMs = defaultShutdownTimeoutMs) { this.transport = new JsonClient(connection); }

  async status(): Promise<RuntimeState> {
    const reply = await this.perform('GET', '/api/runtime/status', 4000);
    this.shutdownProtocol = reply.shutdownProtocol;
    return reply.state;
  }
  async shutdown(): Promise<RuntimeState> {
    const deadline = Date.now() + this.shutdownTimeoutMs;
    // 能力只来自原目标的认证状态；旧后台继续使用原同步停读接口。
    const endpoint = this.shutdownProtocol === 'poll-v1' ? '/api/runtime/shutdown/begin' : '/api/runtime/shutdown';
    let reply: RuntimeReply | undefined;
    try { reply = await this.perform('POST', endpoint, 8000); }
    catch { /* 回包未知时继续查询原目标，不将一次查询失败当作排空失败。 */ }
    for (;;) {
      if (reply?.shutdownFailed) throw new BackendFailure('backend_shutdown_unconfirmed');
      if (reply?.state === 'stopped') return reply.state;
      if (reply?.state === 'running') throw new BackendFailure('backend_shutdown_unconfirmed');
      if (Date.now() >= deadline) throw new BackendShutdownTimeout();
      await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())));
      if (Date.now() >= deadline) throw new BackendShutdownTimeout();
      // 接纳停读后仅查询原连接，不重发停止、不读取新握手、不把失联当成功。
      try { reply = await this.perform('GET', '/api/runtime/status', Math.min(4000, deadline - Date.now())); }
      catch { if (Date.now() >= deadline) throw new BackendShutdownTimeout(); }
    }
  }

  cancelPending(): void { this.transport.cancelPending(); for (const stream of this.streams) stream.abort(); }
  subscribeMessages(callbacks: MessageStreamCallbacks, signal: AbortSignal): void {
    if (signal.aborted) return;
    const controller = new AbortController();
    this.streams.add(controller);
    const abort = () => controller.abort();
    controller.signal.addEventListener('abort', () => {
      this.streams.delete(controller); signal.removeEventListener('abort', abort);
    }, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    openMessageStream(this.connection, { ...callbacks, interrupted: () => { abort(); callbacks.interrupted(); } }, controller.signal);
  }
  async requestJson(options: JsonRequest): Promise<unknown> { return (await this.transport.perform(options)).data; }

  isListening(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: this.connection.port });
      const finish = (listening: boolean) => { socket.destroy(); resolve(listening); };
      socket.setTimeout(500, () => finish(true));
      socket.once('connect', () => finish(true));
      socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED'));
    });
  }

  private async perform(method: 'GET' | 'POST', endpoint: string, timeout: number): Promise<RuntimeReply> {
    try {
      const response = await this.transport.perform({ method, path: endpoint, timeoutMs: timeout, maxResponseBytes: 4096 });
      if (response.status !== 200 && !(endpoint === '/api/runtime/shutdown/begin' && response.status === 202)) throw new Error();
      const value = response.data;
      if (this.expectedRuntime && (value as { runtime?: unknown })?.runtime !== this.expectedRuntime) throw new Error();
      const state = (value as { state?: unknown })?.state;
      if (state !== 'running' && state !== 'stopping' && state !== 'stopped') throw new Error();
      if (endpoint === '/api/runtime/status' && this.expectedRuntime === 'dsh') {
        const status = value as { hostRuntime?: unknown; legacyPid?: unknown; ownership?: unknown };
        const ownership = status?.ownership;
        if (status?.hostRuntime !== 'typescript' || status.legacyPid !== undefined || !ownership || typeof ownership !== 'object' || Array.isArray(ownership)) throw new RetiredBackendRuntime();
        const owners = ownership as Record<string, unknown>;
        if (['contacts', 'deletion', 'wechat', 'skills', 'skillLearning', 'imports', 'taskApi', 'taskManagement', 'tasks',
          'crossDomainDeletion', 'wechatBodySync', 'wechatIncremental', 'wechatHistory', 'foregroundLocation', 'contactContext', 'memory', 'expressionPreferences']
          .some(key => owners[key] !== 'typescript' && owners[key] !== 'unavailable')
          || Object.values(owners).some(owner => typeof owner !== 'string' || !['typescript', 'typescript-migration-command', 'unavailable'].includes(owner))) throw new RetiredBackendRuntime();
        if (state === 'running' && this.expectedStorage) {
          const identity = (value as {storageIdentity?: {databaseId?: unknown; ownerId?: unknown; available?: unknown}}).storageIdentity;
          if (!identity || typeof identity.available !== 'boolean' || identity.databaseId !== this.expectedStorage.databaseId
            || identity.ownerId !== this.expectedStorage.ownerId) throw new RetiredBackendRuntime();
          if (identity.available !== true) throw new BackendStorageUnavailable();
        }
      }
      const metadata = value as {shutdownFailed?: unknown; shutdownProtocol?: unknown};
      if (metadata.shutdownFailed !== undefined && typeof metadata.shutdownFailed !== 'boolean') throw new Error();
      return {state, shutdownFailed: metadata.shutdownFailed === true,
        ...(metadata.shutdownProtocol === 'poll-v1' ? {shutdownProtocol: 'poll-v1'} : {})};
    } catch (error) {
      if (error instanceof RetiredBackendRuntime) throw error;
      throw new BackendFailure('backend_connection_failed');
    }
  }
}
