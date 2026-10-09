import { createServer, request, type ClientRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 仅安排本轮回环传输失败或迟到，成功数据全部来自真实 HTTP/PG。
export class EvidenceHttpProxy {
  readonly server: Server;
  readonly paths: string[] = [];
  next: 'normal' | 'hold' | 'drop' = 'normal';
  fail = false;
  heldCount = 0;
  private readonly held: Array<() => void> = [];
  private readonly pending = new Set<ClientRequest>();
  private constructor(address: string) {
    this.server = createServer((incoming, response) => {
      const evidence = /^\/api\/contacts\/[a-f0-9-]+\/replies\/[a-f0-9-]+\/evidence$/.test(incoming.url ?? '');
      const delivery = evidence ? this.next : 'normal';
      const fail = evidence && this.fail;
      if (evidence) { this.paths.push(incoming.url!); this.next = 'normal'; }
      const deliver = (status: number, body: Buffer, headers: typeof incoming.headers) => {
        const finish = () => {
          if (response.destroyed) return;
          response.writeHead(status, headers); response.end(body);
        };
        if (delivery === 'hold') { this.held.push(finish); ++this.heldCount; }
        else if (delivery === 'drop') response.destroy();
        else finish();
      };
      if (fail) {
        deliver(503, Buffer.from('{"error":"synthetic_transport_unavailable","detail":"合成原始错误不得显示"}'), { 'content-type': 'application/json' });
        incoming.resume(); return;
      }
      const outgoing = request(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        const chunks: Buffer[] = [];
        result.on('data', (chunk: Buffer) => chunks.push(chunk));
        result.on('end', () => deliver(result.statusCode ?? 500, Buffer.concat(chunks), result.headers));
        result.on('error', () => response.destroy());
      });
      this.pending.add(outgoing);
      outgoing.on('close', () => this.pending.delete(outgoing));
      outgoing.on('error', () => response.destroy());
      incoming.pipe(outgoing);
    });
  }
  static async attach(infoPath: string) {
    const values = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const proxy = new EvidenceHttpProxy(values.address);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('本轮依据传输未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${values.token}\npid=${values.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  release() { for (const finish of this.held.splice(0)) finish(); }
  async close() {
    this.release();
    for (const outgoing of this.pending) outgoing.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
