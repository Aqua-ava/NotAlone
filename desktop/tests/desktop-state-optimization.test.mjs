import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { installContactSessionBridge } from './src/main/contacts/bridge';
  export { createContactSessionBridge } from './src/preload/contact-session';
  export { createContactSessionReceiver } from './src/shared/contact-session-bridge';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { installContactSessionBridge, createContactSessionBridge } = loaded.exports;
const contactId = '11111111-1111-4111-8111-111111111111';

test('草稿接收保留初读期间的新事件，并拒绝旧修订和跨范围回包', () => {
  const receive = loaded.exports.createContactSessionReceiver();
  const initial = { revision: -1, scopeRevision: 0, directoryPhase: 'unavailable', contacts: [], selectedContactId: null, draft: '' };
  const full = { ...initial, revision: 10, scopeRevision: 2, directoryPhase: 'ready',
    selectedContactId: contactId, contacts: [{ contactId, displayName: '合成联系人' }] };
  const draft = { kind: 'draft', revision: 12, scopeRevision: 2, selectedContactId: contactId, draft: '初读在途的新输入' };
  assert.equal(receive(initial, draft), initial);
  let state = receive(initial, full);
  assert.equal(state.draft, '初读在途的新输入');
  assert.equal(state.revision, 12);
  assert.equal(receive(state, { ...draft, revision: 11, draft: '旧输入' }), state);
  assert.equal(receive(state, { ...draft, revision: 13, selectedContactId: '其他联系人' }), state);
  const cleared = { ...full, revision: 14, draft: '', draftClearRevision: 1 };
  state = receive(state, cleared);
  assert.equal(state.draftClearRevision, 1);
  const switched = { ...full, revision: 20, scopeRevision: 3, selectedContactId: '另一范围', draft: '另一范围的输入' };
  state = receive(state, switched);
  assert.equal(receive(state, { ...draft, revision: 21 }), state);
  assert.equal(state.draft, '另一范围的输入');
});

test('草稿传输只含本次范围与文字，目录初读和范围变化仍为完整快照', async () => {
  let generation = 1;
  const handlers = new Map(), listeners = new Map(), events = [];
  const backendListeners = new Set();
  const backend = { getConnectionGeneration: () => generation,
    onStateChanged: listener => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    requestJson: async ({ path }) => ({ generation, data: path === '/api/setup/status' ? { runtime_owner_configured: true }
      : { contacts: [{ contact_id: contactId, display_name: '合成联系人', data_status: { message_count: 0, source_count: 0 } }] } }) };
  const session = installContactSessionBridge({ handle: (name, handler) => handlers.set(name, handler),
    publish: (name, state) => { events.push(state); for (const listener of listeners.get(name) ?? []) listener(null, state); } }, backend);
  const bridge = createContactSessionBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name)(...args)),
    on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeListener: (name, listener) => listeners.get(name)?.delete(listener) });
  await session.refreshContacts();
  const initial = await bridge.getState();
  assert.equal(initial.contacts.length, 1);
  const selected = await bridge.selectContact({ contactId, scopeRevision: initial.scopeRevision });
  assert.equal(selected.selectedContactId, contactId);
  const selection = { contactId, scopeRevision: selected.scopeRevision };
  const updates = [];
  const unsubscribe = bridge.onStateChanged(state => updates.push(state));
  const acknowledgement = await bridge.setDraft({ ...selection, text: '新的合成草稿' });
  assert.equal(acknowledgement.kind, 'draft');
  assert.equal('contacts' in acknowledgement, false);
  assert.deepEqual(updates, [acknowledgement]);
  assert.equal((await bridge.getState()).draft, '新的合成草稿');
  session.clearDraft(selection);
  assert.equal(updates.at(-1).draftClearRevision, 1);
  generation = undefined;
  for (const listener of backendListeners) listener();
  assert.equal(updates.at(-1).directoryPhase, 'unavailable');
  assert.deepEqual(updates.at(-1).contacts, []);
  await assert.rejects(bridge.setDraft({ ...selection, text: '过期输入' }));
  unsubscribe();
});
