import { BackendFailure, type BackendConnection } from './connection';
import { JsonClient, type JsonRequest } from './json-client';
import { createConnection } from 'node:net';
import { openMessageStream, type MessageStreamCallbacks } from './message-stream';

type RuntimeState = 'running' | 'stopping' | 'stopped';
export class RetiredBackendRuntime extends BackendFailure {
  constructor() { super('backend_connection_failed'); }
}

// 方法和路径由主进程固定，既不跟随重定向，也不接收渲染层 URL。
export class RuntimeClient {
  private readonly transport: JsonClient;
  private readonly streams = new Set<AbortController>();
  constructor(readonly connection: BackendConnection, private readonly expectedRuntime?: 'dsh') { this.transport = new JsonClient(connection); }

  status(): Promise<RuntimeState> { return this.perform('GET', '/api/runtime/status', 4000); }
  shutdown(): Promise<RuntimeState> { return this.perform('POST', '/api/runtime/shutdown', 8000); }

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

  private async perform(method: 'GET' | 'POST', endpoint: string, timeout: number): Promise<RuntimeState> {
    try {
      const response = await this.transport.perform({ method, path: endpoint, timeoutMs: timeout, maxResponseBytes: 4096 });
      if (response.status !== 200) throw new Error();
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
      }
      return state;
    } catch (error) {
      if (error instanceof RetiredBackendRuntime) throw error;
      throw new BackendFailure('backend_connection_failed');
    }
  }
}
