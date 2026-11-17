import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyInputFixture as fixture, createReplyBridge } from './fixtures/reply-input-stream.mjs';

for (const rounds of [10, 100, 1000]) test(`${rounds}轮SQLite历史下编辑独立草稿不重传讨论正文`, async (t) => {
  const f = await fixture(rounds);
  f.events.length = 0; f.responses.length = 0;
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    f.contacts.setDraft({ ...f.scope(), text: `合成输入${i}` });
  }
  const bytes = f.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.state)) * (event.role ? 1 : 2), 0)
    + f.responses.reduce((sum, response) => sum + Buffer.byteLength(JSON.stringify(response.value) ?? ''), 0);
  t.diagnostic(JSON.stringify({ rounds, elapsedMs: performance.now() - started, bytes, events: f.events.length, fullStates: f.events.filter(event => event.state.savedSession || event.state.state?.savedSession).length }));
  assert.equal(bytes, 0, '独立草稿由联系人入口管理，不重复广播助手历史');
  assert.equal(f.responses.filter(response => response.value?.savedSession).length, 0, '输入响应不重复携带完整历史');
  const after = await f.bridge.getState();
  assert.equal(after.savedSession.discussionEntries.length, rounds);
  assert.equal(f.contacts.getState().draft, '合成输入19');
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
        scopeRevision: original.scopeRevision, changes: { generationBlock: 'foreground-confirmation-required' } });
    }
    assert.equal(reads, 1);
    const next = { ...original, revision: original.revision + 4, contactId: f.otherContactId,
      scopeRevision: original.scopeRevision + 1, generationBlock: null, savedSession: undefined };
    receive(undefined, { kind: 'snapshot', state: next });
    pending.resolve(original);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen.at(-1).contactId, f.otherContactId);
    assert.equal(seen.at(-1).generationBlock, null);
    assert.equal(seen.at(-1).savedSession, undefined);
    assert.equal(reads, 1);
  } finally { unsubscribe(); }
});
