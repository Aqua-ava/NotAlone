import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

// 仅控制回环传输的丢包/迟到；生成和持久化仍进入真实后端与 PG。
export class RewriteHttpProxy {
  readonly server: Server;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly results: Array<{ status: number; data: Record<string, unknown> }> = [];
  readonly replyPreparations: Array<{ kind: 'replies' | 'replace'; status: number; error: string | null; reason: string | null }> = [];
  readonly defaultSessionResults: Array<{ contactId: string; status: number; data: Record<string, unknown> }> = [];
  readonly explorationRequests: Array<Record<string, unknown>> = [];
  readonly explorationResults: Array<{ status: number; data: Record<string, unknown> }> = [];
  nextExploration: 'normal' | 'drop' | 'hold' = 'normal';
  nextReply: 'normal' | 'drop' | 'hold' = 'normal';
  nextMessages: 'normal' | 'drop' | 'hold' = 'normal';
  nextEvidence: 'normal' | 'hold' = 'normal';
  nextSessionRead: 'normal' | 'drop' | 'hold' = 'normal';
  readonly heldEvidenceStatuses: number[] = [];
  readonly sessionReads: Array<{ status: number; states: string[] }> = [];
  readonly sessionDeletes: Array<{ path: string; status: number }> = [];
  readonly sessionRequests: string[] = [];
  readonly messageRequests: string[] = [];
  failMessages = false;
  failRuntime = false;
  failSessionReads = false;
  failNextCandidateVersionSave = false;
  failNextCandidateSelectionRead = false;
  // 只为本轮已知会话的精确路径设置故障；不记录确认正文。
  failSessionDeletes: string | null = null;
  heldCount = 0;
  private readonly held: Array<() => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();

  constructor(address: string) {
    this.server = createServer((incoming, response) => {
      if (this.failRuntime && incoming.url === '/api/runtime/status') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      const generating = incoming.url === '/api/reply/generate'
        || /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+\/replies$/.test(incoming.url ?? '');
      const preparingReply = incoming.method === 'POST'
        && /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+\/(?:replies|replace)\/prepare$/.test(incoming.url ?? '');
      const defaultSession = incoming.method === 'POST'
        ? /^\/api\/contacts\/([a-f0-9-]+)\/assistant-session\/default$/.exec(incoming.url ?? '') : null;
      const exploring = incoming.url === '/api/reply/explore'
        || /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+\/explorations(?:\/[a-f0-9-]+\/(?:confirm|answer|stop))?$/.test(incoming.url ?? '') && incoming.method === 'POST';
      const preparingExploration = incoming.method === 'POST'
        && /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+\/explorations\/[a-f0-9-]+\/prepare-(?:confirm|answer)$/.test(incoming.url ?? '');
      const messages = /^\/api\/contacts\/[a-f0-9-]+\/messages\?/.test(incoming.url ?? '');
      const evidence = /^\/api\/contacts\/[a-f0-9-]+\/replies\/[a-f0-9-]+\/evidence$/.test(incoming.url ?? '');
      const sessionRead = incoming.method === 'GET'
        && /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+$/.test(incoming.url ?? '');
      const sessionDelete = incoming.method === 'DELETE'
        && /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+$/.test(incoming.url ?? '');
      if (this.failNextCandidateVersionSave && incoming.method === 'POST'
        && /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+\/candidates\/[a-f0-9-]+\/versions$/.test(new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname)) {
        this.failNextCandidateVersionSave = false; incoming.resume();
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      if (this.failNextCandidateSelectionRead && incoming.method === 'GET'
        && /^\/api\/contacts\/[a-f0-9-]+\/assistant-sessions\/[a-f0-9-]+\/selections$/.test(incoming.url ?? '')) {
        this.failNextCandidateSelectionRead = false; incoming.resume();
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      if (sessionDelete && this.failSessionDeletes === incoming.url) {
        this.sessionDeletes.push({ path: incoming.url!, status: 503 });
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      if (messages) this.messageRequests.push(incoming.url!);
      if (sessionRead) this.sessionRequests.push(incoming.url!);
      const delivery = generating ? this.nextReply : exploring ? this.nextExploration : messages ? this.nextMessages : evidence ? this.nextEvidence
        : sessionRead ? this.nextSessionRead : 'normal';
      if (generating) this.nextReply = 'normal';
      if (exploring) this.nextExploration = 'normal';
      if (messages) this.nextMessages = 'normal';
      if (evidence) this.nextEvidence = 'normal';
      if (sessionRead) this.nextSessionRead = 'normal';
      if ((messages && this.failMessages) || (sessionRead && this.failSessionReads)) {
        if (sessionRead) this.sessionReads.push({ status: 503, states: [] });
        const deliver = () => {
          if (response.destroyed) return;
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end('{"error":"synthetic_transport_unavailable"}');
        };
        if (delivery === 'hold') this.hold(deliver);
        else if (delivery === 'drop') response.destroy();
        else deliver();
        return;
      }
      const body: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => body.push(chunk));
      incoming.on('end', () => {
        const content = Buffer.concat(body);
        if (generating) this.requests.push(JSON.parse(content.toString('utf8')));
        if (exploring) this.explorationRequests.push(JSON.parse(content.toString('utf8')));
        const preparationBody = preparingExploration ? JSON.parse(content.toString('utf8')) : undefined;
        const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
          const chunks: Buffer[] = [];
          result.on('data', (chunk: Buffer) => chunks.push(chunk));
          result.on('end', () => {
            const value = Buffer.concat(chunks);
            if (defaultSession) this.defaultSessionResults.push({ contactId: defaultSession[1],
              status: result.statusCode ?? 500, data: JSON.parse(value.toString('utf8')) as Record<string, unknown> });
            if (preparingReply) {
              const data = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
              const safeCode = (code: unknown) => typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : null;
              this.replyPreparations.push({ kind: incoming.url!.includes('/replace/') ? 'replace' : 'replies',
                status: result.statusCode ?? 500, error: safeCode(data.error), reason: safeCode(data.reason) });
            }
            if (generating) this.results.push({ status: result.statusCode ?? 500, data: JSON.parse(value.toString('utf8')) });
            if (exploring) this.explorationResults.push({ status: result.statusCode ?? 500, data: JSON.parse(value.toString('utf8')) });
            let outcomeDelivery = delivery;
            if (preparingExploration) {
              const outcome = JSON.parse(value.toString('utf8'));
              // 未领取候选的准备步骤可直接完成探索；实际准备回执仍不计作探索结果。
              if (outcome.kind !== 'prepared') {
                this.explorationRequests.push(preparationBody);
                this.explorationResults.push({ status: result.statusCode ?? 500, data: outcome });
                outcomeDelivery = this.nextExploration;
                this.nextExploration = 'normal';
              }
            }
            if (evidence && delivery === 'hold') this.heldEvidenceStatuses.push(result.statusCode ?? 500);
            if (sessionDelete) this.sessionDeletes.push({ path: incoming.url!, status: result.statusCode ?? 500 });
            if (sessionRead) {
              const saved = JSON.parse(value.toString('utf8'));
              this.sessionReads.push({ status: result.statusCode ?? 500,
                states: Array.isArray(saved.turns) ? saved.turns.map((turn: { state: string }) => turn.state) : [] });
            }
            const deliver = () => {
              if (response.destroyed) return;
              response.writeHead(result.statusCode ?? 500, { 'Content-Type': 'application/json' });
              response.end(value);
            };
            if (outcomeDelivery === 'drop') response.destroy();
            else if (outcomeDelivery === 'hold') this.hold(deliver);
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
  private hold(deliver: () => void): void { this.held.push(deliver); this.heldCount++; }

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
