import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 只暂停真实 DELETE 转发或一次具名依据响应；依据由场景显式释放，finally兜底清理。
export class SourceDeletionProxy {
  readonly server: Server;
  holdDelete = false;
  holdEvidencePath: string | null = null;
  readonly heldStatuses: number[] = [];
  readonly evidenceRequests: { phase: string; status?: number; held: boolean }[] = [];
  private gateTimer: NodeJS.Timeout | undefined;
  private readonly held: Array<(failure: boolean) => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();
  get heldCount(): number { return this.held.length; }

  constructor(address: string) {
    this.server = createServer((incoming, response) => {
      const watched = incoming.method === 'GET' && incoming.url === this.holdEvidencePath;
      if (watched) this.evidenceRequests.push({ phase: 'received', held: false });
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
          if (watched) this.evidenceRequests.push({ phase: 'response', status: result.statusCode, held: incoming.url === this.holdEvidencePath });
          if (incoming.method === 'GET' && incoming.url === this.holdEvidencePath) {
            this.holdEvidencePath = null;
            this.heldStatuses.push(result.statusCode ?? 0);
            this.held.push(deliver);
          } else deliver(false);
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
        this.scheduleRelease();
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
  private scheduleRelease() { if (!this.gateTimer) this.gateTimer = setTimeout(() => this.release(), 4000); }
  release(failure = false): void { clearTimeout(this.gateTimer); this.gateTimer = undefined; for (const deliver of this.held.splice(0)) deliver(failure); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
