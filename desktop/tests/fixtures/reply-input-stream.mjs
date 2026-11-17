import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { ContactSession, installReplyBridge, createReplyBridge } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

export async function replyInputFixture(rounds) {
  const contactId = randomUUID(), otherContactId = randomUUID(), sessionId = randomUUID();
  const saved = { mode: 'sqlite', session_id: sessionId, runtime_recovery: 'ready', entries: [] };
  for (let i = 0; i < rounds; i++) saved.entries.push({ entry_id: randomUUID(), position: String(i + 1), role: 'user',
    text: '合成历史正文。'.repeat(40), request_id: randomUUID(), call_id: null, content_state: 'available' });
  const handlers = new Map(), listeners = new Map(), events = [], responses = [], calls = [];
  let forward = () => {};
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(), requestJson: async (request) => { calls.push(request); const { path } = request;
      if (path.startsWith('/api/deletions?')) return { generation: 1, data: { operations: [] } };
      if (path.endsWith('/assistant-sessions') && request.method === 'GET') return { generation: 1,
        data: path === `/api/contacts/${contactId}/assistant-sessions`
          ? { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId }
          : { sessions: [], current_session_id: null } };
      return { generation: 1,
      data: path.includes('/skills/catalog') || path === '/api/skills' ? { skills: [] }
        : path.endsWith('/selections') ? { selection: null }
        : path.includes('/history-messages?') ? { contact_id: contactId, messages: [], next_cursor: null } : structuredClone(saved) }; } };
  const contacts = new ContactSession(async () => ({ generation: 1, contacts: [contactId, otherContactId].map(contactId => ({
    contactId, displayName: '合成联系人', messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const replies = installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler),
    publish: (channel, state, role) => { events.push({ channel, state: structuredClone(state), role });
      for (const listener of listeners.get(channel) ?? []) listener(undefined, structuredClone(state));
      forward(channel, state, role); } }, backend, contacts, () => null);
  const bridge = createReplyBridge({ invoke: async (channel, ...args) => {
    const value = await handlers.get(channel)(...args); responses.push({ channel, value }); return value;
  }, on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
  removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  await bridge.readSavedSession(scope());
  assert.equal(replies.getState().savedSession?.sessionId, sessionId);
  assert.equal(replies.getState().savedSession?.discussionEntries.length, rounds);
  events.length = 0; responses.length = 0;
  return { bridge, replies, contacts, scope, events, responses, otherContactId, handlers, calls, setForward: (listener) => { forward = listener; } };
}


export { createReplyBridge };
