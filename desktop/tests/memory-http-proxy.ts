import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 只安排本轮真实 HTTP 传输的迟到或失败，不替换资料业务服务与仓储。
export class MemoryHttpProxy {
  readonly server: Server;
  holdPath: string | null = null;
  holdMethod: 'GET' | 'POST' = 'GET';
  failRuntimeStatus = false;
  readonly failurePaths = new Set<string>();
  readonly requests: Array<{ method: string; path: string }> = [];
  private readonly held: Array<(failure: boolean) => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();
  get heldCount(): number { return this.held.length; }

  constructor(address: string) {
    this.server = createServer((incoming, response) => {
      this.requests.push({ method: incoming.method ?? '', path: incoming.url ?? '' });
      if ((this.failRuntimeStatus && incoming.url === '/api/runtime/status') || this.failurePaths.has(incoming.url ?? '')) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(chunk));
        result.on('end', () => {
          const deliver = (failure: boolean) => {
            if (response.destroyed) return;
            response.writeHead(failure ? 503 : result.statusCode ?? 500, { 'Content-Type': 'application/json' });
            response.end(failure ? '{"error":"synthetic_transport_unavailable"}' : Buffer.concat(chunks));
          };
          if (incoming.method === this.holdMethod && incoming.url === this.holdPath) this.held.push(deliver);
          else deliver(false);
        });
      });
      this.pending.add(outgoing);
      outgoing.on('close', () => this.pending.delete(outgoing));
      outgoing.on('error', () => {
        if (response.destroyed) return;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}');
      });
      incoming.pipe(outgoing);
    });
  }
  static async attach(infoPath: string): Promise<MemoryHttpProxy> {
    const fields = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (!/^127\.0\.0\.1:\d+$/.test(fields.address) || !fields.token) throw new Error('本轮资料代理握手不可用。');
    const proxy = new MemoryHttpProxy(fields.address);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('本轮资料传输边界未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${fields.token}\npid=${fields.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  release(failure = false): void { for (const deliver of this.held.splice(0)) deliver(failure); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
