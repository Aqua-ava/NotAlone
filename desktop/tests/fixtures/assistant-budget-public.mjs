import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { withoutExternalTracing } from '../../scripts/test-environment.mjs';

// 复用生产 Main/preload 公开操作；该夹具不会启动 App、页面或原生助手。
export async function budgetPublicFixture(t, { toolHistory = false, continuous = false } = {}) {
  assert.equal(process.env.CONDA_DEFAULT_ENV, 'NotAlone');
  const output = await build({ stdin: { contents: `
    export { ForegroundController } from './src/main/foreground/controller';
    export { ContactSession } from './src/main/contacts/session';
    export { installReplyBridge } from './src/main/reply/bridge';
    export { createReplyBridge } from './src/preload/reply';
    export { JsonClient, BackendRequestFailure } from './src/main/backend/json-client';
    export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    export { ReplyCandidates } from './src/renderer/RewritePanel';
    export { StrategyControls } from './src/renderer/StrategyControls';
    export { createElement } from 'react';
    export { renderToStaticMarkup } from 'react-dom/server';
    export { cleanupCoreFixture, FixtureProcessEvidence } from './tests/database-ownership';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
  const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const project = path.resolve('..'), directory = await mkdtemp(path.join(tmpdir(), 'notalone-budget-public-'));
  const child = spawn(path.join(process.env.CONDA_PREFIX, 'bin/python'), ['tests/fixtures/assistant-budget-backend.py'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: withoutExternalTracing({ ...process.env,
      NOTALONE_DISABLE_DOTENV: '1',
      NOTALONE_TEST_BINDING_DIRECTORY: directory,
      NOTALONE_CONTINUOUS_COMBINATION: continuous ? '1' : '',
      NOTALONE_BUDGET_TOOL_HISTORY: toolHistory ? '1' : '',
      NOTALONE_ENV_FILE: path.join(directory, 'synthetic.env'), NOTALONE_BACKEND_INFO: path.join(directory, 'backend.info'),
      NOTALONE_DATABASE_URL: '', NOTALONE_TEST_DATABASE_URL: '', NOTALONE_OWNER_ID: '', NOTALONE_DEEPSEEK_API_KEY: '',
      DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
    }),
  });
  const evidence = new ports.FixtureProcessEvidence(child);
  const pending = new Map(); let id = 0, cleanup;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本轮预算HTTP/PG夹具启动超时。')), 70000);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`本轮预算夹具退出${code}。`)); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const value = JSON.parse(line);
      if (value.ready) { clearTimeout(timer); resolve(value.ready); }
      else if (value.cleanup) cleanup = value.cleanup;
      else { pending.get(value.id)?.resolve(value.result); pending.delete(value.id); }
    });
  });
  const command = (operation, extra = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('本轮预算夹具命令超时。')); }, 10000);
    pending.set(key, { resolve: (result) => { clearTimeout(timer); resolve(result); } });
    child.stdin.write(`${JSON.stringify({ id: key, operation, ...extra })}\n`);
  });
  let data, client;
  t.after(async () => ports.cleanupCoreFixture({ directory, child,
    pythonExecutable: path.join(process.env.CONDA_PREFIX, 'bin/python'), cleanup: async () => {
      client?.cancelPending();
      let failure;
      if (child.exitCode === null && child.signalCode === null) {
        try { const metrics = await command('metrics');
          process.stdout.write(`budget_public_models: calls=${metrics.model_calls}\n`); }
        catch (error) { failure = error; }
        try { await command('stop'); } catch (error) { failure ??= error; }
        finally { child.stdin.end(); }
      }
      for (let count = 0; child.exitCode === null && child.signalCode === null && count < 100; count++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(child.exitCode, 0);
      assert.deepEqual(cleanup, { instance_ok: true, class_ok: true, database_remaining: false });
      if (failure) throw failure;
    } }, { label: '预算', evidence,
    matchesPreparedDatabase: (name) => !data || data.database_url === `host=/tmp dbname=${name}`,
    cleanupConfirmed: () => process.stdout.write('budget_public_cleanup: 001–072 repeat=0 owned_database_remaining=0\n'),
  }));
  data = await ready;
  assert.equal(data.migration_count, 72); assert.equal(data.migration_repeat, 0);
  client = new ports.JsonClient(data);
  const messageObservers = new Set();
  let generation = 7; const backendListeners = new Set(), delivery = {};
  const backend = { getConnectionGeneration: () => generation,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages: (observer, signal) => {
      messageObservers.add(observer); signal?.addEventListener('abort', () => messageObservers.delete(observer), { once: true }); observer.connected();
    },
    requestJson: async (options) => {
      const captured = generation;
      let response;
      try { response = await client.perform(options); }
      catch (error) { await delivery.after?.(options); throw error; }
      await delivery.after?.(options);
      return { data: response.data, generation: captured };
    },
  };
  const request = async (endpoint, body, method = body ? 'POST' : 'GET') => {
    const response = await client.perform({ method, path: endpoint, body }); return response.data;
  };
  const handlers = new Map(), listeners = new Map();
  const contacts = new ports.ContactSession(async () => {
    const response = await backend.requestJson({ method: 'GET', path: '/api/contacts' });
    return { generation: response.generation, contacts: response.data.contacts.map((contact) => ({
      contactId: contact.contact_id, displayName: contact.display_name, messageCount: contact.message_count,
      sourceCount: contact.source_count,
    })) };
  });
  const foreground = continuous ? new ports.ForegroundController(backend, contacts) : undefined;
  t.after(() => foreground?.dispose());
  const replies = ports.installReplyBridge({
    handle: (channel, handler, role) => handlers.set(channel, { handler, role }),
    publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); },
  }, backend, contacts, () => foreground?.getGenerationBlock() ?? null);
  const bridge = ports.createReplyBridge({
    invoke: (channel, ...args) => Promise.resolve().then(() => handlers.get(channel).handler(...args)),
    on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
  });
  const connect = async (contactId = data.contact_ids[0]) => {
    contacts.setConnection(generation); await contacts.refreshContacts();
    contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
    const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
    await bridge.readSavedSession(scope); return scope;
  };
  const configure = async (configuration) => {
    const next = await command('configure', configuration); client.cancelPending(); client = new ports.JsonClient(next);
    generation += 1; for (const listener of backendListeners) listener();
  };
  return { data, command, bridge, contacts, replies, foreground, request, connect, configure, handlers, backend, delivery,
    message: event => { for (const observer of messageObservers) observer.message(event); },
    BackendRequestFailure: ports.BackendRequestFailure,
    renderSession: (state) => ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel,
      { replies: { state, error: '' } })),
    renderStrategy: (state) => ports.renderToStaticMarkup(ports.createElement(ports.StrategyControls,
      { replies: { state, error: '' } })),
    renderCandidates: (state) => {
      const previousWindow = globalThis.window;
      // 静态渲染不运行 effect；宿主样本订阅只作为 renderer 参数。
      globalThis.window = { notalone: { styleSamples: {} } };
      try { return ports.renderToStaticMarkup(ports.createElement(ports.ReplyCandidates, { replies: { state, error: '' } })); }
      finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
    },
    disconnect: () => { generation += 1; for (const listener of backendListeners) listener(); },
  };
}
