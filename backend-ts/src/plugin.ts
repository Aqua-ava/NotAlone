import type {} from '@deepseek-ai/dsh-cmdline';
import { createServer } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { ValidationService } from './host/service.ts';

export const name = 'notalone-validation';
export const inject = ['llm', 'agents', 'sessions', 'tools', 'appReady'];

/** 仅装配本票合成 HTTP 入口，普通业务规则留在独立 TS 模块。 */
export function apply(ctx: Context) {
  const service = new ValidationService(ctx);
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ pid: process.pid, active: service.active, resources: { agents: ctx.agents.list().length, sessions: ctx.sessions.list().length } })); return;
      }
      if (req.method !== 'POST' || !['/semantic', '/loop', '/cancel', '/revoke'].includes(req.url ?? '')) { res.statusCode = 404; res.end('{}'); return; }
      let body = ''; for await (const part of req) { body += part; if (body.length > 10000) throw new Error('INPUT_LIMIT'); }
      const input = JSON.parse(body);
      res.end(JSON.stringify(req.url === '/cancel' ? service.cancel(input) : req.url === '/revoke' ? service.revoke(input) : await service.execute(req.url!, input)));
    } catch (error) { res.statusCode = 422; res.end(JSON.stringify({ error: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REQUEST_REJECTED' })); }
  });
  const readyDispose = ctx.appReady!.onReady(() => {
    void (async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`VALIDATION_READY http://127.0.0.1:${address.port}\n`);
    })();
  });
  ctx.effect(() => async () => {
    readyDispose();
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
}
