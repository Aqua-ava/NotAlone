import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { foregroundObservation } from '../src/main/foreground/observation';

export function foregroundAcceptanceProjection(status: number | undefined, bytes: Buffer, contactId: string): Record<string, string | boolean> {
  if (status !== 200 || bytes.length > 4096) throw new Error('foreground_observation_invalid');
  const value = foregroundObservation(JSON.parse(bytes.toString('utf8')));
  const reasons = ['confirmed_active_binding', 'sync_disabled', 'wechat_not_in_front', 'quality_unverified',
    'session_candidates_truncated', 'ambiguous_requires_selection', 'unmatched_requires_selection',
    'binding_verification_unavailable', 'observation_timeout', 'minimal_region_unavailable',
    'probe_not_found', 'probe_timeout', 'probe_output_invalid', 'screen_capture_permission_missing', 'probe_failed'];
  if (!reasons.includes(value.reason) || (value.contactId !== null && value.contactId !== contactId)) throw new Error('foreground_observation_invalid');
  return { phase: value.phase, reason: value.reason, wechatInFront: value.wechatInFront, probeAvailable: value.probeAvailable,
    expectedContactMatched: value.contactId === contactId, hasBinding: value.phase === 'confirmed' };
}

// 仅在本轮回环传输边界延迟真实目录响应，业务仍进入当前后端与随机 PG 库。
export class ContactHttpProxy {
  readonly server: Server;
  holdContacts = false;
  readonly holdBindingPaths = new Set<string>();
  readonly holdRequestPaths = new Set<string>();
  failRuntimeStatus = false;
  heldCount = 0;
  private runtimeStopped = false;
  private foregroundObservation: { contactId: string; requests: number; received: number; invalid: boolean; observations: Array<Record<string, string | boolean>> } | undefined;
  private readonly held: Array<(failure: boolean) => void> = [];
  private readonly pending = new Set<ReturnType<typeof httpRequest>>();

  constructor(address: string, private readonly heldEndpoint = '/api/contacts', private readonly runtimeToken?: string) {
    this.server = createServer((incoming, response) => {
      if (this.failRuntimeStatus && incoming.url === '/api/runtime/status') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end('{"error":"synthetic_transport_unavailable"}'); return;
      }
      const forward = () => {
        if (this.foregroundObservation && incoming.method === 'POST' && incoming.url === '/api/sync/foreground/observe'
          && incoming.headers.authorization === `Bearer ${this.runtimeToken}`) {
          ++this.foregroundObservation.requests;
          if (this.foregroundObservation.requests > 4) this.foregroundObservation.invalid = true;
        }
        const outgoing = httpRequest(`http://${address}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
          const chunks: Buffer[] = [];
          result.on('data', (chunk: Buffer) => chunks.push(chunk));
          result.on('end', () => {
            if (this.foregroundObservation && incoming.method === 'POST' && incoming.url === '/api/sync/foreground/observe'
              && incoming.headers.authorization === `Bearer ${this.runtimeToken}`) {
              const target = this.foregroundObservation;
              ++target.received;
              try {
                if (target.received > 4) throw new Error();
                target.observations.push(foregroundAcceptanceProjection(result.statusCode, Buffer.concat(chunks), target.contactId));
              } catch { target.invalid = true; }
            }
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
      };
      // 只暂停本轮具名请求的转发，放行后仍由真实后端执行。
      if (this.holdRequestPaths.has(incoming.url ?? '')) { this.held.push(() => forward()); this.heldCount++; }
      else forward();
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
  // 显式单联系人验收才打开；不持久原响应，不改变正式传输或 Promise 时序。
  observeForeground(contactId: string): void {
    if (!this.runtimeToken || this.foregroundObservation) throw new Error('foreground_observer_unavailable');
    this.foregroundObservation = { contactId, requests: 0, received: 0, invalid: false, observations: [] };
  }
  foregroundReport() {
    const value = this.foregroundObservation;
    return value ? { requests: value.requests, received: value.received, invalid: value.invalid, observations: value.observations.map(item => ({ ...item })) } : null;
  }
  release(failure = false): void { for (const deliver of this.held.splice(0)) deliver(failure); }
  async close(): Promise<void> {
    this.release();
    for (const request of this.pending) request.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
