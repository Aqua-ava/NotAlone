import { BackendFailure, type BackendConnection } from './connection';
import { JsonClient, type JsonRequest } from './json-client';
import { createConnection } from 'node:net';

type RuntimeState = 'running' | 'stopping' | 'stopped';

// 方法和路径由主进程固定，既不跟随重定向，也不接收渲染层 URL。
export class RuntimeClient {
  private readonly transport: JsonClient;
  constructor(readonly connection: BackendConnection) { this.transport = new JsonClient(connection); }

  status(): Promise<RuntimeState> { return this.perform('GET', '/api/runtime/status', 4000); }
  shutdown(): Promise<RuntimeState> { return this.perform('POST', '/api/runtime/shutdown', 8000); }

  cancelPending(): void { this.transport.cancelPending(); }
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
      const state = (value as { state?: unknown })?.state;
      if (state !== 'running' && state !== 'stopping' && state !== 'stopped') throw new Error();
      return state;
    } catch { throw new BackendFailure('backend_connection_failed'); }
  }
}
