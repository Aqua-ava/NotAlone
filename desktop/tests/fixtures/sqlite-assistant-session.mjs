import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

// 只替换传输边界；正式ReplySession、SQLite解码器、Main和preload均照常运行。
export async function sqliteAssistantFixture(t, { empty = false } = {}) {
  const ports = await portsPromise;
  const contactId = randomUUID(), sessionId = randomUUID(), requestId = randomUUID(), calls = [];
  const control = { currentSessionId: empty ? null : sessionId, sessions: empty ? [] : [sessionId], failSession: null, readGate: null };
  const entries = new Map([[sessionId, [{ entry_id: randomUUID(), position: '1', role: 'user',
    text: '合成历史讨论输入', request_id: requestId, call_id: null, content_state: 'available' }]]]);
  const backend = { getConnectionGeneration: () => 7, onStateChanged: () => () => {}, subscribeMessages: () => {},
    requestJson: async request => {
      calls.push(request); let data;
      if (request.path.startsWith('/api/deletions?')) data = { operations: [] };
      else if (request.path.endsWith('/assistant-sessions') && request.method === 'POST') {
        const id = randomUUID(); control.sessions.push(id); control.currentSessionId = id; entries.set(id, []); data = { session_id: id };
      } else if (request.path.endsWith('/continue') && request.method === 'POST') {
        const id = request.path.split('/').at(-2);
        if (!control.sessions.includes(id) || Object.keys(request.body).length) throw new Error('合成讨论继续范围无效');
        control.currentSessionId = id; data = { session_id: id };
      } else if (request.path.endsWith('/assistant-sessions')) data = {
        sessions: control.sessions.map(id => ({ session_id: id, is_current: id === control.currentSessionId })), current_session_id: control.currentSessionId };
      else if (request.path.endsWith('/assistant-session/binding')) data = { confirmed: true };
      else if (request.path.includes('/history-messages?')) data = { messages: [], next_cursor: null };
      else if (control.sessions.some(id => request.path.endsWith(`/assistant-sessions/${id}`))) {
        const id = request.path.split('/').at(-1), gate = control.readGate; control.readGate = null;
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        if (control.failSession === id) throw new Error('合成讨论读取失败');
        data = { mode: 'sqlite', session_id: id, runtime_recovery: 'ready', entries: entries.get(id) };
      } else throw new Error(`SQLite夹具未安排的端口：${request.path}`);
      return { generation: 7, data };
    } };
  const contacts = new ports.ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成SQLite联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const handlers = new Map(), replies = ports.installReplyBridge({ handle: (name, handler) => handlers.set(name, handler), publish() {} }, backend, contacts);
  const bridge = ports.createReplyBridge({ invoke: (name, ...args) => handlers.get(name)(...args), on() {}, removeListener() {} });
  t.after(() => contacts.setConnection(undefined));
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = () => ({ contactId, scopeRevision: contacts.getState().scopeRevision });
  await bridge.readSavedSession(scope());
  return { contactId, sessionId, calls, control, entries, contacts, replies, bridge, scope };
}
