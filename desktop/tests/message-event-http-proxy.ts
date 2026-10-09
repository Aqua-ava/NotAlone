import { createServer, request, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// SSE 原样流式转发，仅安排已完成的真实消息页迟到，不替代 PG 或事件响应。
export class MessageEventHttpProxy {
  readonly server: Server;
  readonly messagePaths: string[] = [];
  holdNextMessages = false;
  heldCount = 0;
  private readonly held: Array<() => void> = [];
  private readonly pending = new Set<ReturnType<typeof request>>();
  private constructor(address: string) {
    this.server = createServer((incoming, response) => {
      const messages = /^\/api\/contacts\/[a-f0-9-]+\/messages\?/.test(incoming.url ?? '');
      const hold = messages && this.holdNextMessages;
      if (messages) { this.messagePaths.push(incoming.url!); this.holdNextMessages = false; }
      const outgoing = request(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        if (!hold) {
          response.writeHead(result.statusCode ?? 500, result.headers);
          response.flushHeaders();
          result.pipe(response);
        } else {
          const chunks: Buffer[] = [];
          result.on('data', (chunk: Buffer) => chunks.push(chunk));
          result.on('end', () => {
            const value = Buffer.concat(chunks);
            this.heldCount++;
            this.held.push(() => {
              if (!response.destroyed) { response.writeHead(result.statusCode ?? 500, result.headers); response.end(value); }
            });
          });
        }
        result.once('error', () => response.destroy());
      });
      this.pending.add(outgoing);
      outgoing.once('close', () => this.pending.delete(outgoing));
      outgoing.once('error', () => response.destroy());
      response.once('close', () => outgoing.destroy());
      incoming.pipe(outgoing);
    });
  }
  static async attach(infoPath: string): Promise<MessageEventHttpProxy> {
    const values = Object.fromEntries((await readFile(infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const proxy = new MessageEventHttpProxy(values.address);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('事件验收传输未启动。');
    await writeFile(infoPath, `address=127.0.0.1:${address.port}\ntoken=${values.token}\npid=${values.pid}\n`, { mode: 0o600 });
    return proxy;
  }
  release(): void { for (const deliver of this.held.splice(0)) deliver(); }
  async close(): Promise<void> {
    this.release();
    for (const outgoing of this.pending) outgoing.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
