import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { withoutExternalTracing } from '../scripts/test-environment.mjs';

const enabled = process.env.CONDA_DEFAULT_ENV === 'NotAlone';
test('真实Main连接重载在旧作业未核对时拒绝，保留认证连接；故障解除后按原身份排空', { skip: !enabled, timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-manual-connection-'));
  const bundle = await build({ stdin: { contents: `
    export { BackendHost } from './src/main/backend/host';
    export { installContactSessionBridge } from './src/main/contacts/bridge';
    export { installForegroundBridge } from './src/main/foreground/bridge';
    export { installReplyBridge } from './src/main/reply/bridge';
    export { createReplyBridge } from './src/preload/reply';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
  const portFile = path.join(directory, 'ports.mjs');
  await writeFile(portFile, bundle.outputFiles[0].text);
  const ports = await import(pathToFileURL(portFile).href);
  const project = path.resolve('..');
  const child = spawn(path.join(process.env.CONDA_PREFIX, 'bin/python'), ['tests/fixtures/manual-connection-change-backend.py'], {
    stdio: ['pipe', 'pipe', 'inherit'], env: withoutExternalTracing({ ...process.env,
      NOTALONE_DISABLE_DOTENV: '1', NOTALONE_ENV_FILE: path.join(directory, 'unused.env'),
      NOTALONE_DATABASE_URL: '', NOTALONE_OWNER_ID: '', NOTALONE_DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY: '',
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1' }) });
  let cleanup = false;
  const ready = new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).on('line', line => {
      const value = JSON.parse(line); if (value.ready) resolve(value.ready); if (value.cleanup) cleanup = true;
    });
    child.once('exit', code => reject(new Error(`synthetic_backend_exit_${code}`)));
  });
  let host, proxy;
  t.after(async () => {
    proxy?.closeAllConnections(); if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    if (child.exitCode === null) { child.stdin.end('{"operation":"stop"}\n'); await new Promise(resolve => child.once('exit', resolve)); }
    assert.equal(child.exitCode, 0); assert.equal(cleanup, true);
    await rm(directory, { recursive: true, force: true });
  });
  const backend = await ready;
  let blockRead = false, shutdowns = 0;
  proxy = createServer((incoming, response) => {
    if (blockRead && /\/assistant-sessions\//.test(incoming.url)
      && (incoming.method === 'GET' || incoming.method === 'POST' && incoming.url.endsWith('/interrupt'))) {
      response.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end('{"error":"synthetic_receipt_unavailable"}'); return;
    }
    const upstream = request({ host: '127.0.0.1', port: backend.port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, connection: 'close' } }, actual => {
      response.writeHead(actual.statusCode, { ...actual.headers, connection: 'close' }); actual.pipe(response);
      if (incoming.url === '/api/runtime/shutdown') {
        shutdowns += 1; actual.once('end', () => proxy.close());
      }
    });
    upstream.on('error', () => { response.writeHead(503); response.end(); }); incoming.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const info = path.join(directory, 'backend.info');
  await writeFile(info, `address=127.0.0.1:${proxy.address().port}\ntoken=${backend.token}\npid=${backend.pid}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({ backendInfoPath: info }));
  host = new ports.BackendHost(directory);
  const handlers = new Map(), listeners = new Map();
  const commands = { handle: (name, handler) => handlers.set(name, handler),
    publish: (name, state) => { for (const listener of listeners.get(name) ?? []) listener(undefined, state); } };
  const contacts = ports.installContactSessionBridge(commands, host);
  const foreground = ports.installForegroundBridge(commands, host, contacts);
  t.after(() => foreground.dispose());
  const replies = ports.installReplyBridge(commands, host, contacts, () => foreground.getGenerationBlock());
  host.setConnectionChangePreparation(() => replies.prepareGenerationConnectionChange());
  const bridge = ports.createReplyBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name)(...args)),
    on: (name, listener) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); },
    removeListener: (name, listener) => listeners.get(name)?.delete(listener) });
  await host.connect(); await contacts.refreshContacts();
  assert.equal(host.getState().phase, 'connected');
  const deadline = Date.now() + 5000;
  while (contacts.getState().directoryPhase === 'loading' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(contacts.getState().directoryPhase, 'ready');
  await handlers.get('contacts:create')({ displayName: '合成重载联系人', scopeRevision: contacts.getState().scopeRevision });
  const contactId = contacts.getState().contacts[0].contactId;
  await handlers.get('contacts:confirm-manual')({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await handlers.get('contacts:set-draft')({ ...scope, text: '合成预算失败的本次草稿。' });
  await bridge.generate({ ...scope, newRequest: true });
  const failed = await bridge.getState(); assert.equal(failed.errorCode, 'input_budget_unavailable');
  const generation = host.getConnectionGeneration(); assert.ok(generation !== undefined);
  blockRead = true;
  assert.equal(await host.prepareConfiguration(), false);
  assert.equal(host.getConnectionGeneration(), generation); assert.equal(host.getState().phase, 'connected');
  assert.equal(shutdowns, 0);
  const directoryRead = await host.requestJson({ method: 'GET', path: '/api/contacts' });
  assert.equal(directoryRead.generation, generation); assert.equal(directoryRead.data.contacts.length, 1);
  blockRead = false;
  const sessions = await host.requestJson({ method: 'GET', path: `/api/contacts/${contactId}/assistant-sessions` });
  const sessionId = sessions.data.current_session_id;
  const original = await host.requestJson({ method: 'GET', path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}` });
  assert.equal(original.generation, generation); assert.equal(original.data.turns.length, 1);
  assert.equal(original.data.turns[0].state, 'failed');
  assert.equal(original.data.turns[0].generation_active, undefined);
  assert.equal(await host.prepareConfiguration(), true);
  assert.equal(shutdowns, 1); assert.equal(host.getConnectionGeneration(), undefined);
  console.log('manual_connection_change: original authenticated target retained on failure, recovered and stopped on retry');
});
