import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { build } from 'esbuild';

const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'notalone-message-opt-in-public-'));
const source = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { RuntimeClient } from './src/main/backend/runtime-client';
  export { readConnection } from './src/main/backend/connection';
  export { withRewriteFixture } from './tests/rewrite-backend-fixture';
  export { ReplyCandidates } from './src/renderer/RewritePanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
await writeFile(path.join(bundleDirectory, 'production.mjs'), source.outputFiles[0].text);
const ports = await import(path.join(bundleDirectory, 'production.mjs'));
after(() => rm(bundleDirectory, { recursive: true, force: true }));

export async function eventually(read, accepts, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

// 仅宿主事件与模型可控；业务读取、认证SSE、生成、保存和删除均走生产HTTP。
export async function withMessageOptInFixture(use) {
  let cleaned = false;
  try { await ports.withRewriteFixture('notalone-message-opt-in-http-', async (fixture) => {
    assert.equal(fixture.data.migration_count, 55);
    assert.equal(fixture.data.migration_repeat, 0);
    const connection = await ports.readConnection(fixture.infoPath);
    assert(connection);
    const runtime = new ports.RuntimeClient(connection);
    const handlers = new Map(), listeners = new Map(), requests = [], delivery = {};
    let generation = 7;
    const backendListeners = new Set();
    const backend = {
      getConnectionGeneration: () => generation,
      onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
      subscribeMessages: (callbacks, signal) => runtime.subscribeMessages(callbacks, signal),
      requestJson: async (options) => {
        const captured = generation;
        const observed = { method: options.method, path: options.path,
          bodyHash: options.body === undefined ? null : createHash('sha256').update(JSON.stringify(options.body)).digest('hex') };
        requests.push(observed);
        let data;
        try { data = await runtime.requestJson(options); }
        catch (error) {
          observed.failure = { kind: error.kind, code: error.code, reason: error.reason, status: error.status };
          await delivery.after?.(options, observed);
          throw error;
        }
        await delivery.after?.(options, observed);
        return { data, generation: captured };
      },
    };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(generation); await contacts.refreshContacts();
    const replies = ports.installReplyBridge({
      handle: (channel, handler, role) => { assert(!handlers.has(channel)); handlers.set(channel, { handler, role }); },
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); },
    }, backend, contacts);
    const bridge = ports.createReplyBridge({
      invoke: (channel, ...args) => Promise.resolve().then(() => { assert(handlers.has(channel)); return handlers.get(channel).handler(...args); }),
      on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    });
    const connect = async (contactId = fixture.data.contact_ids[0]) => {
      contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
      const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
      await bridge.readSavedSession(scope);
      await eventually(() => bridge.getState(), (state) => state.messageNotice.phase === 'connected', '生产SSE须已连接。');
      return scope;
    };
    try {
      await use({ fixture, bridge, contacts, replies, handlers, requests, delivery, connect,
        request: (endpoint, body, method = body ? 'POST' : 'GET') => runtime.requestJson({ method, path: endpoint, body }),
        disconnect: () => { generation += 1; runtime.cancelPending(); for (const listener of backendListeners) listener(); },
        renderCandidates: (state) => {
          const previous = globalThis.window;
          globalThis.window = { notalone: { styleSamples: {} } };
          try { return ports.renderToStaticMarkup(ports.createElement(ports.ReplyCandidates, { replies: { state, error: '' } })); }
          finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
        },
      });
    } finally {
      runtime.cancelPending();
      await fixture.command('release');
      const observations = await fixture.command('observations');
      process.stdout.write(`message_opt_in_models: calls=${observations.model_calls}\n`);
      await fixture.cleanup();
      const ownership = JSON.parse(await readFile(path.join(fixture.directory, 'message-events-owned.json'), 'utf8'));
      assert.equal(ownership.cleanup_confirmed, true);
      assert.match(ownership.database_name, /^notalone_core_flow_[0-9a-f]{32}_test$/);
    }
  }, () => { cleaned = true; }, path.resolve('tests/fixtures/message-events-backend.py')); }
  finally {
    if (cleaned) process.stdout.write('message_opt_in_cleanup: 001–055 repeat=0 owned_database_remaining=0\n');
  }
}
