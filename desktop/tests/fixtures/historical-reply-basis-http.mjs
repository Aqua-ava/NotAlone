import assert from 'node:assert/strict';
import path from 'node:path';
import { ports } from './historical-reply-basis.mjs';

// 使用正式联系人目录、Main／preload 与 HTTP；只有模型和固定合成事件受测试控制。
export async function withHistoricalReplyHttpFixture(run) {
  let cleanupConfirmed = false;
  await ports.withRewriteFixture('notalone-historical-basis-', async (fixture) => {
    const connection = await ports.readConnection(fixture.infoPath);
    assert(connection);
    const client = new ports.JsonClient(connection);
    const delivery = {};
    const calls = [];
    const backend = { getConnectionGeneration: () => 7, onStateChanged: () => () => {},
      subscribeMessages: (observer) => observer.connected(), requestJson: async (request) => {
        calls.push({ method: request.method, path: request.path });
        const response = await client.perform(request);
        await delivery.after?.(request);
        return { generation: 7, data: response.data };
      } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    const handlers = new Map(), listeners = new Map();
    const replies = ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler),
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); } }, backend, contacts);
    const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args),
      on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
      removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) });
    const connect = async (contactId = fixture.data.contact_ids[0]) => {
      contacts.setConnection(7); await contacts.refreshContacts();
      assert.equal(contacts.getState().directoryPhase, 'ready');
      contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
      const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
      await bridge.readSavedSession(scope);
      return scope;
    };
    const request = async (endpoint, body, method = body === undefined ? 'GET' : 'POST') =>
      (await client.perform({ method, path: endpoint, ...(body === undefined ? {} : { body }) })).data;
    try { await run({ fixture, bridge, contacts, replies, connect, request, backend, calls, delivery }); }
    finally { client.cancelPending(); }
  }, () => { cleanupConfirmed = true; }, path.resolve('tests/fixtures/historical-reply-basis-backend.py'), path.resolve('../backend'));
  assert.equal(cleanupConfirmed, true);
  process.stdout.write('historical_basis_http_cleanup: exact_owned_database_remaining=0\n');
}
