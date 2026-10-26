import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const ports = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { SourceDeletionController } from './src/main/sources/controller';
  export { MemoryReadingController } from './src/main/memory/controller';
  export { ReplySession } from './src/main/reply/session';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function fixture(t) {
  const { ContactSession, ReplySession, BackendRequestFailure } = await ports;
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const sessions = new Map(ids.map(id => [id, randomUUID()]));
  const requests = [], listeners = new Set();
  let generation = 7;
  const control = { barrier: undefined, missing: new Set(), block: null };
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeMessages: observer => observer.connected(),
    requestJson: async request => {
      requests.push(request);
      if (request.path.startsWith('/api/deletions?')) return { generation: 7, data: { operations: [] } };
      const id = request.path.split('/')[3];
      await control.barrier?.(request);
      if (control.respond) { const data = control.respond(request); if (data) return { generation: 7, data }; }
      if (control.missing.has(id)) throw new BackendRequestFailure('response', 404, 'not_found');
      if (request.path.endsWith('/selections')) return { generation: 7, data: { selection: null } };
      return { generation: 7, data: request.path.endsWith('/assistant-session/default')
        ? { session_id: sessions.get(id) }
        : { session_id: sessions.get(id), current_input_version_id: null, turns: [], inputs: [] } };
    },
  };
  const contacts = new ContactSession(async () => ({ generation: 7,
    contacts: ids.map((contactId, i) => ({ contactId, displayName: `合成联系人${i}`, messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = new ReplySession(contacts, backend, () => control.block);
  t.after(() => { generation++; for (const listener of listeners) listener(); });
  const select = contactId => { contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
    return { contactId, scopeRevision: contacts.getState().scopeRevision }; };
  const ready = contactId => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('内容恢复未在有界时间完成')); }, 1500);
    const unsubscribe = replies.onStateChanged(state => {
      if (state.contactId === contactId && state.savedSession?.phase === 'ready') {
        clearTimeout(timer); unsubscribe(); resolve(state);
      }
    });
  });
  return { ids, sessions, requests, control, contacts, replies, select, ready, backend };
}

test('快速 A→B→C 立即显示最后联系人，仅稳定后的 C 读取讨论', async t => {
  const f = await fixture(t); const [a, b, c] = f.ids;
  f.control.block = 'foreground-confirmation-required'; f.replies.refreshGenerationEligibility();
  f.select(a); f.select(b); f.select(c);
  assert.equal(f.replies.getState().contactId, c);
  f.control.block = null; f.replies.refreshGenerationEligibility();
  assert.equal(f.replies.getState().savedSession.phase, 'loading');
  assert.equal(f.requests.length, 0, '短暂途经的联系人不应立即读取讨论');
  await f.ready(c);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(request => request.path.includes(c)));
});

test('显式读取立即执行，B 迟到结果不能覆盖 C', async t => {
  const f = await fixture(t); const [, b, c] = f.ids;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.control.barrier = request => request.path.includes(b) ? gate : undefined;
  const bScope = f.select(b);
  const reading = f.replies.readSavedSession(bScope);
  assert.equal(f.requests.length, 1, '明确读取不经过稳定等待');
  const cScope = f.select(c);
  await f.replies.readSavedSession(cScope);
  release(); await reading;
  assert.equal(f.replies.getState().contactId, c);
  assert.equal(f.replies.getState().savedSession.sessionId, f.sessions.get(c));
});


test('切回 A 复用草稿缓存，但已删除讨论不会恢复旧输入', async t => {
  const f = await fixture(t); const [a, b] = f.ids;
  const first = f.select(a); await f.replies.readSavedSession(first);
  f.contacts.setDraft({ ...first, text: '合成未提交草稿' });
  await f.replies.updateRequirements({ ...first, requirements: '合成临时要求' });
  await f.replies.readSavedSession(f.select(b));
  f.select(a); await f.ready(a);
  assert.equal(f.contacts.getState().draft, '合成未提交草稿');
  assert.equal(f.replies.getState().requirements, '合成临时要求');
  await f.replies.readSavedSession(f.select(b));
  f.control.missing.add(a);
  await f.replies.readSavedSession(f.select(a));
  assert.equal(f.replies.getState().savedSession.phase, 'failed');
  assert.equal(f.contacts.getState().draft, '');
  assert.equal(f.replies.getState().requirements, '');
});


test('授权变化保留已选联系人和手工草稿，旧来源读取及删除提交失效', async t => {
  const f = await fixture(t);
  const { SourceDeletionController } = await ports;
  const scope = f.select(f.ids[0]);
  f.contacts.setDraft({ ...scope, text: '合成手工草稿' });
  const sources = new SourceDeletionController(f.backend, f.contacts, async () => {});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.control.barrier = request => request.path.endsWith('/sources') ? gate : undefined;
  f.control.respond = request => request.path.endsWith('/sources') ? { sources: [] } : undefined;
  const reading = sources.refresh(scope);
  f.contacts.invalidateReadingScope();
  assert.equal(f.contacts.getState().selectedContactId, scope.contactId);
  assert.equal(f.contacts.getState().draft, '合成手工草稿');
  release(); await reading;
  assert.equal(sources.getState().phase, 'idle');
  await assert.rejects(sources.delete({ ...scope, sourceId: randomUUID() }), /来源范围已变化/);
  const fresh = { ...scope, scopeRevision: f.contacts.getState().scopeRevision };
  await sources.refresh(fresh);
  assert.equal(sources.getState().phase, 'ready');
});

for (const failure of [false, true]) test(`授权撤销及恢复后，消息和关系概览迟到${failure ? '失败' : '成功'}不得复活`, async t => {
  const f = await fixture(t);
  const { MemoryReadingController } = await ports;
  const scope = f.select(f.ids[0]);
  const memory = new MemoryReadingController(f.backend, f.contacts);
  f.contacts.onStateChanged(() => memory.synchronizeScope());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const isContext = request => /\/(messages\?|relationship-overview$)/.test(request.path);
  f.control.barrier = request => isContext(request) ? gate.then(() => {
    if (failure) throw new Error('合成迟到失败');
  }) : undefined;
  f.control.respond = request => request.path.includes('/messages?') ? { messages: [{
    message_id: randomUUID(), speaker: 'contact', message_type: 'text', text: '合成旧授权正文',
    media_placeholder: null, occurred_at: null, quoted: null,
  }], next_cursor: null } : request.path.endsWith('/relationship-overview') ? { overview: {
    version: 1, scope_kind: 'contact', contact_id: scope.contactId,
    projection_revision: 'a'.repeat(64), memory_revision: 1, built_at: '2026-10-23T00:00:00Z', entries: [],
  } } : undefined;
  const reading = Promise.all([f.replies.loadMessages(scope), memory.refreshOverview(scope)]);
  f.contacts.invalidateReadingScope();
  f.contacts.invalidateReadingScope();
  release(); await reading;
  assert.deepEqual(f.replies.getState().messages.items, []);
  assert.notEqual(f.replies.getState().messages.phase, 'failed');
  assert.deepEqual(memory.getState().overview, { phase: 'idle', value: null });
  await assert.rejects(f.replies.loadMessages(scope), /变化|失效/);
  await assert.rejects(memory.refreshOverview(scope), /失效/);
  assert.throws(() => f.contacts.setDraft({ ...scope, text: '旧范围提交' }), /变化/);
  f.control.barrier = undefined;
  const fresh = { ...scope, scopeRevision: f.contacts.getState().scopeRevision };
  await f.replies.readSavedSession(fresh);
  await Promise.all([f.replies.loadMessages(fresh), memory.refreshOverview(fresh)]);
  assert.equal(f.replies.getState().messages.items[0].text, '合成旧授权正文');
  assert.equal(memory.getState().overview.phase, 'ready');
});

test('授权变化打断目录刷新时重新读取，不停留在旧加载态', async t => {
  const { ContactSession } = await ports;
  let release;
  let reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const contacts = new ContactSession(async () => {
    if (++reads === 2) await gate;
    return { generation: 7, contacts: [] };
  });
  contacts.setConnection(7);
  await new Promise(resolve => setImmediate(resolve));
  const old = contacts.refreshContacts();
  contacts.invalidateReadingScope();
  release(); await old;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contacts.getState().directoryPhase, 'ready');
  assert.equal(reads, 3);
});
