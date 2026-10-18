import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyInputFixture as fixture, createReplyBridge } from './fixtures/reply-input-stream.mjs';

for (const rounds of [10, 100, 1000]) test(`${rounds}轮历史输入只传增量且权威读取仍完整`, async (t) => {
  const f = await fixture(rounds);
  const before = await f.bridge.getState();
  const updates = [];
  if (f.bridge.onStateUpdated) f.bridge.onStateUpdated(event => updates.push(event));
  f.events.length = 0; f.responses.length = 0;
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    const options = { tone: 'original', instruction: `合成输入${i}`, includeRelationshipContext: false };
    await f.bridge.updateInput({ type: 'options', update: { ...f.scope(), options } });
  }
  const bytes = f.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.state)) * (event.role ? 1 : 2), 0)
    + f.responses.reduce((sum, response) => sum + Buffer.byteLength(JSON.stringify(response.value) ?? ''), 0);
  t.diagnostic(JSON.stringify({ rounds, elapsedMs: performance.now() - started, bytes, events: f.events.length, fullStates: f.events.filter(event => event.state.savedSession || event.state.state?.savedSession).length }));
  assert.ok(bytes < 50_000, '输入IPC不应随完整历史线性增长');
  assert.ok(f.events.every(event => event.role === 'helper'), '回复输入只发助手窗口');
  assert.equal(f.responses.filter(response => response.value?.savedSession).length, 0, '输入响应不重复携带完整历史');
  assert.equal(updates.length, 20);
  assert.equal(updates[0].baseRevision, before.revision);
  assert.equal(updates.at(-1).changes.options.instruction, '合成输入19');
  const after = await f.bridge.getState();
  assert.equal(after.savedSession.turns.length, rounds);
  assert.equal(after.options.instruction, '合成输入19');
});

test('完整读取和命令回显同修订只通知一次，切换后旧范围增量不能恢复', async () => {
  const f = await fixture(10), seen = [];
  const unsubscribe = f.bridge.onStateChanged(state => seen.push(state));
  try {
    await f.bridge.getState();
    const initial = seen.length;
    await f.bridge.updateInput({ type: 'options', update: { ...f.scope(), options: {
      tone: 'original', instruction: '当前最新要求。', includeRelationshipContext: false } } });
    assert.equal(seen.length, initial + 1);
    await f.bridge.getState();
    assert.equal(seen.length, initial + 1);
    const previous = f.scope();
    f.contacts.selectContact({ ...previous, contactId: f.otherContactId });
    await assert.rejects(f.bridge.updateInput({ type: 'options', update: { ...previous, options: {
      tone: 'original', instruction: '迟到旧范围要求。', includeRelationshipContext: false } } }));
    assert.equal(seen.at(-1).contactId, f.otherContactId);
    assert.equal(seen.at(-1).options.instruction, '');
  } finally { unsubscribe(); }
});

test('增量缺口只开一轮权威读取，迟到旧快照不覆盖新联系人', async () => {
  const f = await fixture(10), original = await f.bridge.getState(), pending = Promise.withResolvers(), seen = [];
  let receive, reads = 0;
  const bridge = createReplyBridge({
    invoke: async channel => {
      if (channel === 'reply:subscribe') { receive(undefined, { kind: 'snapshot', state: original }); return; }
      reads++; return pending.promise;
    },
    on: (_channel, listener) => { receive = listener; }, removeListener: () => {},
  });
  const unsubscribe = bridge.onStateChanged(state => seen.push(state));
  try {
    for (let revision = original.revision + 2; revision <= original.revision + 3; revision++) {
      receive(undefined, { kind: 'patch', baseRevision: revision - 1, revision, contactId: original.contactId,
        scopeRevision: original.scopeRevision, changes: { direction: '迟到旧联系人文字。' } });
    }
    assert.equal(reads, 1);
    const next = { ...original, revision: original.revision + 4, contactId: f.otherContactId,
      scopeRevision: original.scopeRevision + 1, direction: '', savedSession: undefined, result: null };
    receive(undefined, { kind: 'snapshot', state: next });
    pending.resolve(original);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen.at(-1).contactId, f.otherContactId);
    assert.equal(seen.at(-1).direction, '');
    assert.equal(seen.at(-1).savedSession, undefined);
    assert.equal(reads, 1);
  } finally { unsubscribe(); }
});
