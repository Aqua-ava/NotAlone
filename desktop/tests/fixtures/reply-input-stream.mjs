import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { StyleSampleController } from './src/main/style-samples/controller';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { ContactSession, installReplyBridge, createReplyBridge, StyleSampleController } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

export async function replyInputFixture(rounds) {
  const contactId = randomUUID(), otherContactId = randomUUID(), sessionId = randomUUID();
  const saved = { session_id: sessionId, current_input_version_id: null, turns: [], inputs: [] };
  for (let i = 0; i < rounds; i++) {
    const turnId = randomUUID(), inputVersionId = randomUUID();
    saved.turns.push({ turn_id: turnId, input_version_id: inputVersionId, request_key: randomUUID(), state: 'failed',
      interruption_reason: null, input: { content: { type: 'rewrite_draft', draft_text: '合成历史正文。'.repeat(40) } }, placeholder: null, reply: null });
    saved.inputs.push({ input_version_id: inputVersionId, type: 'generation', conversation_binding_id: randomUUID(),
      turn_id: turnId, state: 'active', content: null, placeholder: null });
  }
  const handlers = new Map(), listeners = new Map(), events = [], responses = [], calls = [];
  let forward = () => {};
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(), requestJson: async (request) => { calls.push(request); const { path } = request;
      if (path.endsWith('/replies/prepare')) throw new Error('合成准备失败，记录输入后停止。');
      return { generation: 1,
      data: path.endsWith('/default') ? { session_id: sessionId } : path.includes('/skills/catalog') || path === '/api/skills' ? { skills: [] }
        : path.endsWith('/selections') ? { selection: null }
        : path.includes('/messages?') ? { contact_id: contactId, messages: [], next_cursor: null } : structuredClone(saved) }; } };
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
  new StyleSampleController(backend, contacts, replies);
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  await bridge.readSavedSession(scope());
  assert.equal(replies.getState().savedSession?.turns.length, rounds);
  events.length = 0; responses.length = 0;
  return { bridge, replies, contacts, scope, events, responses, otherContactId, handlers, calls, setForward: (listener) => { forward = listener; } };
}


export { createReplyBridge };
