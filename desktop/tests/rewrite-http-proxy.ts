import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 仅控制回环传输的丢包/迟到；生成和持久化仍进入真实后端与 PG。
export class RewriteHttpProxy {
  readonly server: Server;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly results: Array<{ status: number; data: Record<string, unknown> }> = [];
  nextReply: 'normal' | 'drop' | 'hold' = 'normal';
  failRuntime = false;
  heldCount = 0;
  private readonly held: Array<() => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();

  constructor(address: string) {
    this.server = createServer((incoming, response) => {
      if (this.failRuntime && incoming.url === '/api/runtime/status') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      const generating = incoming.url === '/api/reply/generate';
      const delivery = generating ? this.nextReply : 'normal';
      if (generating) this.nextReply = 'normal';
      const body: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => body.push(chunk));
      incoming.on('end', () => {
        const content = Buffer.concat(body);
        if (generating) this.requests.push(JSON.parse(content.toString('utf8')));
        const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
          const chunks: Buffer[] = [];
          result.on('data', (chunk: Buffer) => chunks.push(chunk));
          result.on('end', () => {
            const value = Buffer.concat(chunks);
            if (generating) this.results.push({ status: result.statusCode ?? 500, data: JSON.parse(value.toString('utf8')) });
            const deliver = () => {
              if (response.destroyed) return;
              response.writeHead(result.statusCode ?? 500, { 'Content-Type': 'application/json' });
              response.end(value);
            };
            if (delivery === 'drop') response.destroy();
            else if (delivery === 'hold') { this.held.push(deliver); this.heldCount++; }
            else deliver();
          });
        });
        this.pending.add(outgoing);
        outgoing.on('close', () => this.pending.delete(outgoing));
        outgoing.on('error', () => { if (!response.destroyed) response.destroy(); });
        outgoing.end(content);
      });
    });
  }

  static async attach(infoPath: string): Promise<RewriteHttpProxy> {
    const values = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const proxy = new RewriteHttpProxy(values.address);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('改写测试传输边界未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${values.token}\npid=${values.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  release(): void { for (const deliver of this.held.splice(0)) deliver(); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
