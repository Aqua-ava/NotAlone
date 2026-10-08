import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as appTest } from './app-fixture';

// 合成本机服务只模拟进程边界，不替换 App 内部模块。
export class SyntheticBackend {
  readonly token = randomUUID();
  readonly server: Server;
  address = '';
  shutdownMode: 'success' | 'failure' | 'timeout' | 'lost-response' = 'success';
  statusDelay = 0;
  statusMode: 'success' | 'failure' = 'success';
  statusState: 'running' | 'stopping' | 'stopped' | undefined;
  shutdownDelay = 0;
  private statusDeliveries = 0;
  private state: 'running' | 'stopping' | 'stopped' = 'running';
  private shutdownCount = 0;
  private unauthorizedCount = 0;

  constructor() {
    this.server = createServer((request, response) => {
      const send = (status: number, body: object) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        this.unauthorizedCount++;
        send(401, { error: 'unauthorized' });
        return;
      }
      if (request.url === '/test/observations') {
        send(200, { state: this.state, shutdownCount: this.shutdownCount, unauthorizedCount: this.unauthorizedCount });
      } else if (request.url === '/test/status-deliveries') {
        send(200, { count: this.statusDeliveries });
      } else if (request.url === '/api/runtime/status' && request.method === 'GET') {
        if (this.statusMode === 'failure') { send(500, { error: 'internal_error' }); return; }
        const snapshot = { state: this.statusState ?? this.state };
        setTimeout(() => { this.statusDeliveries++; send(200, snapshot); }, this.statusDelay);
      } else if (request.url === '/api/runtime/shutdown' && request.method === 'POST') {
        this.shutdownCount++;
        this.state = 'stopping';
        const mode = this.shutdownMode;
        setTimeout(() => {
          if (mode === 'failure') send(500, { error: 'internal_error' });
          else if (mode === 'timeout') return;
          else {
            this.state = 'stopped';
            if (mode === 'lost-response') response.destroy();
            else send(200, { state: 'stopped' });
          }
        }, this.shutdownDelay);
      } else send(404, { error: 'not_found' });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('合成服务未启动');
    this.address = `127.0.0.1:${address.port}`;
  }

  async writeHandshake(infoPath: string, overrides: { address?: string; token?: string; pid?: number } = {}): Promise<void> {
    await writeFile(infoPath, `address=${overrides.address ?? this.address}\ntoken=${overrides.token ?? this.token}\npid=${overrides.pid ?? process.pid}\n`, { mode: 0o600 });
  }

  async observations(): Promise<{ state: string; shutdownCount: number; unauthorizedCount: number }> {
    const response = await fetch(`http://${this.address}/test/observations`, { headers: { Authorization: `Bearer ${this.token}` } });
    return response.json();
  }

  async deliveredStatuses(): Promise<number> {
    const response = await fetch(`http://${this.address}/test/status-deliveries`, { headers: { Authorization: `Bearer ${this.token}` } });
    return (await response.json()).count;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export type BackendFixture = { service: SyntheticBackend; directory: string; infoPath: string };
export const test = appTest.extend<{ backend: BackendFixture }>({
  backend: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-backend-'));
    const service = new SyntheticBackend();
    const infoPath = path.join(directory, 'backend.info');
    try {
      await service.start();
      await service.writeHandshake(infoPath);
      await use({ service, directory, infoPath });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  appEnvironment: async ({ backend }, use) => {
    await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env') });
  },
});
