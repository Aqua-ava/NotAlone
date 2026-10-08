import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 只控制真实后端的 HTTP 传输边界：业务请求仍进入当前源码与随机 PG 库。
export class SetupHttpProxy {
  readonly server: Server;
  failRuntimeStatus = false;
  holdCredentialResponses = false;
  dropInitializeResponse = false;
  holdStatusAfterInitialize = false;
  closeAfterShutdown = false;
  afterShutdown: (() => Promise<void>) | undefined;
  holdSetupStatusResponses = false;
  initializeCompletedCount = 0;
  heldCount = 0;
  private readonly held: Array<() => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();

  constructor(private readonly address: string) {
    this.server = createServer((incoming, response) => {
      if (this.failRuntimeStatus && incoming.url === '/api/runtime/status') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(chunk));
        result.on('end', () => {
          if (incoming.url === '/api/setup/initialize') {
            this.initializeCompletedCount++;
            if (this.holdStatusAfterInitialize) this.holdSetupStatusResponses = true;
            if (this.dropInitializeResponse) { response.destroy(); return; }
          }
          const deliver = () => {
            if (this.closeAfterShutdown && incoming.url === '/api/runtime/shutdown' && result.statusCode === 200) {
              response.once('finish', () => {
                void (this.afterShutdown?.() ?? Promise.resolve()).then(() => {
                  this.server.close(); this.server.closeIdleConnections();
                }).catch(() => {});
              });
            }
            response.writeHead(result.statusCode ?? 500, { 'Content-Type': 'application/json' });
            response.end(Buffer.concat(chunks));
          };
          if ((this.holdCredentialResponses && incoming.url === '/api/setup/credentials')
            || (this.holdSetupStatusResponses && incoming.url === '/api/setup/status')) {
            this.held.push(deliver); this.heldCount++;
          } else deliver();
        });
      });
      this.pending.add(outgoing);
      outgoing.on('close', () => this.pending.delete(outgoing));
      outgoing.on('error', () => this.fail(response));
      incoming.pipe(outgoing);
    });
  }

  static async attach(infoPath: string): Promise<SetupHttpProxy> {
    const fields = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const proxy = new SetupHttpProxy(fields.address);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('合成 HTTP 边界未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${fields.token}\npid=${fields.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  release(): void { for (const deliver of this.held.splice(0)) deliver(); }
  releaseLatest(): void { this.held.pop()?.(); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private fail(response: ServerResponse): void {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end('{"error":"synthetic_transport_unavailable"}');
  }
}
