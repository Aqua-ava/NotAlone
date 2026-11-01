import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const owned = await mkdtemp(join(tmpdir(), 'notalone-source-discussion-'));
after(() => rm(owned, { recursive: true, force: true }));
const outfile = join(owned, 'ports.mjs');
await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { ReplySession } from './src/main/reply/session';
  export { MemoryReadingController } from './src/main/memory/controller';
  export { installSourceDeletionBridge } from './src/main/sources/bridge';
  export { createSourceDeletionBridge } from './src/preload/source-deletion';
  export { coordinateOwnerContextChanges, coordinateSourceContextChanges } from './src/main/reply/owner-context-changes';
`, resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const ports = await import(pathToFileURL(outfile).href);

async function fixture(t) {
  const contactId = randomUUID(), sessionId = randomUUID(), sourceId = randomUUID(), requestId = randomUUID();
  const oldText = '来源删除接纳前保存的合成助手发言';
  const requests = [], changed = [], deletes = Promise.withResolvers(), entered = Promise.withResolvers();
  const control = { text: oldText, readGate: undefined, failReads: false };
  const entry = text => ({ entry_id: randomUUID(), position: '1', role: 'assistant', text,
    request_id: requestId, call_id: randomUUID(), content_state: 'available' });
  const backend = { getConnectionGeneration: () => 7, onStateChanged: () => () => {}, subscribeMessages: () => {},
    requestJson: async request => {
      requests.push(request); let data;
      if (request.method === 'DELETE') {
        assert.equal(request.path, `/api/contacts/${contactId}/sources/${sourceId}`);
        control.text = null; entered.resolve();
        await deletes.promise;
        throw new Error('合成后端已接纳，但删除回包丢失');
      }
      if (request.path.startsWith('/api/deletions?')) data = { operations: [] };
      else if (request.path.endsWith('/sources')) data = { sources: [{ source_id: sourceId, file_name: null, record_count: 1, status: 'active', task_id: null }] };
      else if (request.path.endsWith('/assistant-sessions')) data = { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId };
      else if (request.path.endsWith('/assistant-session/default')) data = { session_id: sessionId };
      else if (request.path.endsWith('/assistant-session/binding')) data = { confirmed: true };
      else if (request.path.endsWith('/selections')) data = { selection: null };
      else if (request.path.includes('/history-messages?')) data = { messages: [], next_cursor: null };
      else if (request.path.endsWith(`/assistant-sessions/${sessionId}`)) {
        const text = control.text, gate = control.readGate; control.readGate = undefined;
        if (gate) await gate.promise;
        if (control.failReads) throw new Error('合成权威读取暂不可用');
        data = { mode: 'sqlite', session_id: sessionId, runtime_recovery: 'blocked', entries: text ? [entry(text)] : [] };
      } else throw new Error(`未安排的合成端口：${request.path}`);
      return { generation: 7, data };
    } };
  const contacts = new ports.ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成联系人', messageCount: 0, sourceCount: 1 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = new ports.ReplySession(contacts, backend);
  const revalidations = [], revalidate = replies.revalidateOwnerContextChange.bind(replies);
  // 来源控制器通知settled后不等待监听者；仅观察真实会话复验Promise，不替换其行为。
  replies.revalidateOwnerContextChange = () => { const pending = revalidate(); revalidations.push(pending); return pending; };
  t.after(() => contacts.setConnection(undefined));
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  const memory = new ports.MemoryReadingController(backend, contacts);
  ports.coordinateOwnerContextChanges(memory, replies);
  const handlers = new Map(), listeners = new Map();
  const sources = ports.installSourceDeletionBridge({ handle: (channel, handler) => handlers.set(channel, handler),
    publish: (channel, state) => listeners.get(channel)?.({}, state) }, backend, contacts, async id => { changed.push(id); await replies.revalidateDeletedSource(id); });
  ports.coordinateSourceContextChanges(sources, replies);
  sources.onDeletion(phase => memory.sourceDeletionChanged(phase));
  const bridge = ports.createSourceDeletionBridge({ invoke: (channel, ...args) => handlers.get(channel)(...args),
    on: (channel, listener) => listeners.set(channel, listener), removeListener: channel => listeners.delete(channel) });
  await replies.readSavedSession(scope); await bridge.refresh(scope);
  assert.equal(replies.getState().savedSession.phase, 'ready');
  assert.equal(replies.getState().savedSession.discussionEntries[0].text, oldText);
  const reads = () => requests.filter(request => request.path.endsWith(`/assistant-sessions/${sessionId}`));
  return { replies, memory, scope, sourceId, oldText, requests, reads, control, changed, bridge, deletes, entered, revalidations };
}

test('来源DELETE回包挂起或丢失时即撤下实际讨论，期间不再读取，未知失败保持空直到权威重读', async t => {
  const f = await fixture(t);
  const deleting = f.bridge.delete({ ...f.scope, sourceId: f.sourceId }); await f.entered.promise;
  assert.equal(JSON.stringify(f.replies.getState()).includes(f.oldText), false, '不能等待DELETE回包才撤下正文');
  assert.deepEqual(f.changed, [], '后端删除回执尚未触发onSourceChanged');
  const before = f.reads().length; await f.replies.readSavedSession(f.scope);
  assert.equal(f.reads().length, before, '来源删除尚未结算时禁止新读取');
  f.control.failReads = true; f.deletes.resolve(); await deleting; await Promise.all(f.revalidations);
  assert.match((await f.bridge.getState()).error, /尚未确认/);
  await f.replies.readSavedSession(f.scope);
  assert.equal(JSON.stringify(f.replies.getState()).includes(f.oldText), false);
  assert.equal(f.replies.getState().savedSession.phase, 'failed');
  f.control.failReads = false; f.control.text = '来源删除后由新权威读取返回的独立讨论';
  await f.replies.readSavedSession(f.scope);
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.equal(f.replies.getState().savedSession.discussionEntries[0].text, f.control.text, '配对settled应解除本次读锁');
});

test('来源started中止既有读取且迟到正文不复活，来源settled不提前解除独立owner变更读锁', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(); f.control.readGate = gate;
  const reading = f.replies.readSavedSession(f.scope);
  const oldRead = f.reads().at(-1);
  const deleting = f.bridge.delete({ ...f.scope, sourceId: f.sourceId }); await f.entered.promise;
  assert.equal(oldRead.signal.aborted, true, '来源started必须撤销既有读取令牌');
  await f.memory.ownerLayeredContextChanged('started');
  gate.resolve(); await reading;
  assert.equal(JSON.stringify(f.replies.getState()).includes(f.oldText), false);
  f.deletes.resolve(); await deleting; await Promise.all(f.revalidations);
  const before = f.reads().length; await f.replies.readSavedSession(f.scope);
  assert.equal(f.reads().length, before, 'source的settled不能替owner提前解锁');
  await f.memory.ownerLayeredContextChanged('settled');
  f.control.text = '两条生命周期各自结算后的权威讨论';
  await f.replies.readSavedSession(f.scope);
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.equal(f.replies.getState().savedSession.discussionEntries[0].text, f.control.text);
});
