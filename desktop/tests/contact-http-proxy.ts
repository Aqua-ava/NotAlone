import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 仅在本轮回环传输边界延迟真实目录响应，业务仍进入当前后端与随机 PG 库。
export class ContactHttpProxy {
  readonly server: Server;
  holdContacts = false;
  readonly holdBindingPaths = new Set<string>();
  failRuntimeStatus = false;
  heldCount = 0;
  private runtimeStopped = false;
  private readonly held: Array<(failure: boolean) => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();

  constructor(address: string, private readonly heldEndpoint = '/api/contacts', private readonly runtimeToken?: string) {
    this.server = createServer((incoming, response) => {
      if (this.failRuntimeStatus && incoming.url === '/api/runtime/status') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(chunk));
        result.on('end', () => {
          // 只见证本轮原认证请求的真实停读响应，不从响应迟到、断线或进程退出推定停读。
          if (this.runtimeToken && incoming.method === 'POST' && incoming.url === '/api/runtime/shutdown'
            && incoming.headers.authorization === `Bearer ${this.runtimeToken}` && result.statusCode === 200) {
            try {
              const stopped: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (stopped && typeof stopped === 'object' && !Array.isArray(stopped)
                && (stopped as Record<string, unknown>).state === 'stopped') this.runtimeStopped = true;
            } catch { /* 无效正文不证明已停读，仍按原传输结果交付。 */ }
          }
          const deliver = (failure: boolean) => {
            if (response.destroyed) return;
            response.writeHead(failure ? 503 : result.statusCode ?? 500, { 'Content-Type': 'application/json' });
            response.end(failure ? '{"error":"synthetic_transport_unavailable"}' : Buffer.concat(chunks));
          };
          if ((this.holdContacts && incoming.url === this.heldEndpoint) || this.holdBindingPaths.has(incoming.url ?? '')) { this.held.push(deliver); this.heldCount++; }
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

  static async attach(infoPath: string, heldEndpoint = '/api/contacts'): Promise<ContactHttpProxy> {
    const fields = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const proxy = new ContactHttpProxy(fields.address, heldEndpoint, fields.token);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('联系人测试传输边界未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${fields.token}\npid=${fields.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  get authenticatedRuntimeStopped(): boolean { return this.runtimeStopped; }
  release(failure = false): void { for (const deliver of this.held.splice(0)) deliver(failure); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
