/** 仅合成验收：独立官方 profile 中的 L2 宿主候选，不进入共享主宿主。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import {createServer} from 'node:http';
import pg from 'pg';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {createL2ScenarioHost} from '../src/memory/scenarios/host.ts';

export const name = 'l2-scenario-synthetic-host';
export const inject = ['llm', 'appReady'];

export function apply(ctx: Context) {
  const config = JSON.parse(process.env.NOTALONE_L2_SCENARIO_CONFIG!);
  const provider = installModelProvider(ctx, {
    provider: 'synthetic-route',
    connection: resolveAdapterOptions({
      baseURL: process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,
      thinking: 'disabled',
      maxTokens: 512,
      retryPolicy: {mode: 'normal', maxRetries: 0},
    }),
    resolveAuth: async () => ({headers: {}}),
    resolveUserId: () => 'synthetic-l2' as never,
  });
  const transaction = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({host: '/tmp', database: process.env.NOTALONE_L2_DATABASE!});
    await client.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  };
  const pending = new Set<Promise<unknown>>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/run') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const current = {...config, ...body};
    const host = createL2ScenarioHost({
      ctx,
      transaction,
      provider,
      permit: {
        path: process.env.NOTALONE_MODEL_PERMIT_SOCKET!,
        token: process.env.NOTALONE_MODEL_PERMIT_TOKEN!,
      },
      binding: {
        provider: 'synthetic-route',
        model: 'synthetic-model',
        maxTokens: 512,
        temperature: 0,
        reasoningEffort: 'off',
      },
      profile: {context_window_tokens: 32_000, safety_margin_tokens: 512},
      budget: current.budget,
    });
    const work = host.run(current.scope, current.claim, controller.signal);
    pending.add(work);
    try {
      const result = await work;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = controller.signal.aborted ? 499 : 502;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        error: error && typeof error === 'object' && 'code' in error ? error.code : 'l2_scenario_host_failed',
      }));
    } finally {
      pending.delete(work);
    }
  });
  const ready = ctx.appReady!.onReady(() => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`L2_SCENARIO_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.effect(() => async () => {
    ready();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...pending]);
    await provider.dispose();
  });
}
