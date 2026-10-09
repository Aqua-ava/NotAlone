import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 只暂停用户确认的真实 DELETE 转发；业务响应仍来自生产后端，四秒自动放行。
export class SourceDeletionProxy {
  readonly server: Server;
  holdDelete = false;
  private gateTimer: NodeJS.Timeout | undefined;
  private readonly held: Array<(failure: boolean) => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();
  get heldCount(): number { return this.held.length; }

  constructor(address: string) {
    this.server = createServer((incoming, response) => {
      const forward = () => {
      const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(chunk));
        result.on('end', () => {
          const deliver = (failure: boolean) => {
            if (response.destroyed) return;
            response.writeHead(failure ? 503 : result.statusCode ?? 500, { 'Content-Type': 'application/json' });
            response.end(failure ? '{"error":"synthetic_transport_unavailable"}' : Buffer.concat(chunks));
          };
          deliver(false);
        });
      });
      this.pending.add(outgoing);
      outgoing.setTimeout(5000, () => outgoing.destroy());
      outgoing.on('close', () => this.pending.delete(outgoing));
      outgoing.on('error', () => {
        if (response.destroyed) return;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}');
      });
      if (incoming.method === 'DELETE') outgoing.end();
      else incoming.pipe(outgoing);
      };
      if (incoming.method === 'DELETE' && this.holdDelete) {
        this.held.push(() => forward());
        this.gateTimer = setTimeout(() => this.release(), 4000);
      } else forward();
    });
  }
  static async attach(infoPath: string): Promise<SourceDeletionProxy> {
    const fields = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (!/^127\.0\.0\.1:\d+$/.test(fields.address) || !fields.token) throw new Error('本轮资料代理握手不可用。');
    const proxy = new SourceDeletionProxy(fields.address);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('本轮资料传输边界未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${fields.token}\npid=${fields.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  release(failure = false): void { clearTimeout(this.gateTimer); this.gateTimer = undefined; for (const deliver of this.held.splice(0)) deliver(failure); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
