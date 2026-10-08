import { request, type ClientRequest } from 'node:http';
import { BackendFailure, type BackendConnection } from './connection';

type RuntimeState = 'running' | 'stopping' | 'stopped';

// 方法和路径由主进程固定，既不跟随重定向，也不接收渲染层 URL。
export class RuntimeClient {
  private readonly requests = new Set<ClientRequest>();
  constructor(readonly connection: BackendConnection) {}

  status(): Promise<RuntimeState> { return this.perform('GET', '/api/runtime/status', 4000); }
  shutdown(): Promise<RuntimeState> { return this.perform('POST', '/api/runtime/shutdown', 8000); }

  cancelPending(): void {
    for (const req of this.requests) req.destroy(new BackendFailure('backend_connection_failed'));
  }

  private perform(method: 'GET' | 'POST', endpoint: string, timeout: number): Promise<RuntimeState> {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new BackendFailure('backend_connection_failed'));
      const req = request({
        hostname: '127.0.0.1', port: this.connection.port, method, path: endpoint,
        headers: { Authorization: `Bearer ${this.connection.token}`, Accept: 'application/json', 'Content-Length': '0' },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4096) { response.destroy(); fail(); }
          else chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) { fail(); return; }
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const state = (value as { state?: unknown })?.state;
            if (state !== 'running' && state !== 'stopping' && state !== 'stopped') { fail(); return; }
            resolve(state);
          } catch { fail(); }
        });
      });
      const timer = setTimeout(() => req.destroy(new BackendFailure('backend_connection_failed')), timeout);
      this.requests.add(req);
      req.on('error', fail);
      req.on('close', () => { clearTimeout(timer); this.requests.delete(req); });
      req.end();
    });
  }
}
