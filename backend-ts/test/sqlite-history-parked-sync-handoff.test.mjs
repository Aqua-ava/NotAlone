import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';

async function parkedFixture(t) {
  const cleanup = [], f = await fixture({ after: callback => cleanup.push(callback) });
  const state = { owner: undefined, releaseOwner: undefined, tail: Promise.resolve(), parks: 0, channels: [], wakes: [] };
  // 只替代原生进程租约边界；顺序、停车回调、历史目标、守卫和存储均走生产服务。
  const shared = { async run(owner, work, releasePreviousOwner, signal) {
    const previous = state.tail;
    let unlock; state.tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    try {
      assert.equal(signal?.aborted ?? false, false);
      if (state.owner !== undefined && state.owner !== owner) await state.releaseOwner?.();
      state.owner = owner; state.releaseOwner = releasePreviousOwner;
      return await work({});
    } finally { unlock(); }
  } };
  const history = new SqliteHistoryService(f.storage, f.contacts, () => {
    const loss = Promise.withResolvers(), current = { loss, code: null, scope: null };
    state.channels.push(current);
    return { ...f.channel,
      guardSession: { loss: loss.promise, failureCode: () => current.code },
      inspect: async scope => {
        current.scope = scope;
        return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
          capabilities: { incrementalTail: 'supported' } };
      },
      page: async (scope, target, cursor) => ({ target: target.descriptor, cursorIn: cursor, cursorOut: null,
        records: [record('1', { text: `合成历史：${scope.conversationKey}` })], completedPartitions: ['shard-a'],
        exhausted: true, resumeCursor: `tail:${scope.conversationKey}` }),
      tail: async (_scope, target, cursor) => ({ target: target.descriptor, cursorIn: cursor, cursorOut: cursor,
        records: [], caughtUp: true }),
      park: async () => { state.parks++; },
      close: async () => { loss.resolve(); },
    };
  }, undefined, undefined, undefined, shared);
  history.setFirstHistoryWake(contactId => state.wakes.push(contactId));
  t.after(async () => { await history.close(); await f.service.close(); for (const callback of cleanup.reverse()) await callback(); });
  return { ...f, history, state };
}

test('共享读取器切换联系人后增量新目标唤醒首次补齐，旧增量游标保持失效', async t => {
  const f = await parkedFixture(t), [a, b] = f.saved;
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  assert.ok(f.state.parks > 0, '读取另一联系人应停车原读取器');
  const beforeB = (await f.history.read(b.contact_id)).messages.map(row => row.id);
  const handoff = await f.history.synchronizeIncremental(a.contact_id);
  assert.equal(handoff.phase, 'running');
  assert.equal(handoff.incremental.phase, 'invalidated');
  assert.equal(handoff.incremental.failureCode, 'history_snapshot_replaced');
  assert.deepEqual(f.state.wakes, [a.contact_id], '普通停车后的新历史目标也必须自动交给首次协调器');
  await f.history.synchronize(a.contact_id);
  const caughtUp = await f.history.synchronizeIncremental(a.contact_id);
  assert.equal(caughtUp.incremental.phase, 'ready');
  assert.deepEqual((await f.history.read(b.contact_id)).messages.map(row => row.id), beforeB);
  assert.equal((await f.history.read(a.contact_id)).messages.length, 1, '换目标补齐不重复建立历史消息');
});

test('空闲守卫瞬时退出后外置首次协调器仍会被唤醒，真实来源变化不借此恢复', async t => {
  const f = await parkedFixture(t), [a, b] = f.saved;
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  const current = f.state.channels.at(-1);
  current.code = 'history_native_timeout'; current.loss.resolve();
  // 等待失效回调和同一存储队列中的持久失效完成，不依赖实际计时。
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await f.history.waitForReadIdle(b.contact_id);
  await f.storage.check();
  const directory = { directory: async () => {
    const saved = await f.contacts.directory();
    return { ...saved, bindings: saved.bindings.filter(row => row.contact_id === b.contact_id) };
  } };
  const incremental = new IncrementalHistoryCoordinator(directory, f.history, { intervalMs: 0, firstHistoryManagedExternally: true });
  try {
    incremental.wake(); await incremental.waitForIdle();
    assert.deepEqual(f.state.wakes, [b.contact_id], '空闲时失去守卫也须请求First恢复，不能等不存在的在途catch');
  } finally { await incremental.close(); }
  assert.equal((await f.history.coverage(b.contact_id)).phase, 'incomplete');
  const token = await f.contacts.eligibility(b.contact_id);
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), true);
  await f.history.synchronize(b.contact_id);
  f.state.wakes.length = 0;
  const changed = f.state.channels.at(-1);
  changed.code = 'history_source_changed'; changed.loss.resolve();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await f.storage.check();
  await f.history.requestFirstHistoryRecovery(b.contact_id);
  assert.deepEqual(f.state.wakes, []);
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), false);
});
