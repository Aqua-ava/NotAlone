import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';

async function strictTargetFixture(t, { sharedReader = true } = {}) {
 const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
 const state = { owner: null, release: null, tail: Promise.resolve(), current: null, serial: 0, pages: [], tails: [], resumes: 0 };
 const shared = { async run(owner, work, release, signal) {
  const previous = state.tail; let unlock; state.tail = new Promise(resolve => { unlock = resolve; }); await previous;
  try {
   assert.equal(signal?.aborted ?? false, false);
   if (state.owner !== owner) { await state.release?.(); state.current = null; }
   state.owner = owner; state.release = release; return await work({});
  } finally { unlock(); }
 } };
 const create = () => {
  const loss = Promise.withResolvers();
  const select = (scope, target) => state.current = { contactId: scope.token.contact_id,
   target: { ...target, descriptor: `snapshot-${++state.serial}` }, tailCursor: null };
  const current = (scope, target) => {
   if (scope.token.contact_id !== state.current?.contactId || target.descriptor !== state.current?.target.descriptor)
    throw new StorageFailure('history_target_unverified');
   return state.current;
  };
  return { ...f.channel, guardSession: { loss: loss.promise },
   inspect: async scope => ({ ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
    capabilities: { incrementalTail: 'supported', durableIncremental: 'supported' } }),
   target: async scope => select(scope, f.target).target,
   resumeTarget: async (scope, previous) => { state.resumes++; return select(scope, previous).target; },
   page: async (scope, target, cursor) => {
    const selected = current(scope, target); state.pages.push({ contactId: scope.token.contact_id, target: target.descriptor });
    selected.tailCursor = `checkpoint-${state.serial}`;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
     records: [record('1', { text: `合成历史：${scope.conversationKey}` })], completedPartitions: ['shard-a'],
     exhausted: true, resumeCursor: selected.tailCursor };
   },
   tail: async (scope, target, cursor) => {
    const selected = current(scope, target); assert.equal(cursor, selected.tailCursor, '新目标必须先读取历史页后才能增量');
    state.tails.push(scope.token.contact_id);
    return { target: target.descriptor, cursorIn: cursor, cursorOut: cursor, records: [], caughtUp: true };
   },
   park: async () => {}, close: async () => loss.resolve(),
  };
 };
 const history = new SqliteHistoryService(f.storage, f.contacts, create, undefined, undefined, undefined, sharedReader ? shared : undefined);
 t.after(async () => { await history.close(); await f.service.close(); for (const fn of cleanup.reverse()) await fn(); });
 return { ...f, history, state };
}

test('两位联系人交替建立增量目标后首次接续使用当前原生目标', async t => {
 const f = await strictTargetFixture(t), [a, b] = f.saved;
 await f.history.synchronize(a.contact_id); await f.history.synchronize(b.contact_id);
 const bMessages = (await f.history.read(b.contact_id)).messages.map(row => row.id);
 await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true}); await f.history.synchronizeIncremental(b.contact_id,undefined,{followHistoryHandoff:true});
 const before = f.state.serial;
 const completed = await f.history.synchronize(a.contact_id);
 assert.equal(completed.phase, 'complete'); assert.equal(f.state.serial, before + 1);
 assert.equal(f.state.pages.at(-1).target, f.state.current.target.descriptor);
 assert.equal((await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true})).incremental.phase, 'ready');
 assert.deepEqual((await f.history.read(b.contact_id)).messages.map(row => row.id), bMessages);
 assert.equal((await f.history.read(a.contact_id)).messages.length, 1, '替换目标不得重复建立规范消息');
});

test('原生目标释放后只使用下一次重验建立的目标', async t => {
 const f = await strictTargetFixture(t), [a, b] = f.saved;
 await f.history.synchronize(a.contact_id); await f.history.synchronize(b.contact_id);
 await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true});
 const before = f.state.serial;
 assert.equal((await f.history.synchronize(a.contact_id)).phase, 'complete');
 assert.equal(f.state.serial, before+1);
 assert.equal((await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true})).incremental.phase, 'ready');
});

test('来源准备释放元数据目标后，历史按已接受检查点建立自己的目标', async t => {
 const f = await strictTargetFixture(t, { sharedReader: false }), [a] = f.saved;
 await f.history.synchronize(a.contact_id);
 await f.history.stop(a.contact_id);
 await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true});
 const oldPendingTarget = f.state.current.target.descriptor;
 await f.history.ensureSourceReady(a.contact_id);
 assert.notEqual(f.state.current.target.descriptor, oldPendingTarget);
 const before = f.state.serial, resumes = f.state.resumes;
 assert.equal((await f.history.synchronize(a.contact_id)).phase, 'complete');
 assert.equal(f.state.serial, before+1); assert.equal(f.state.resumes, resumes+1);
 assert.equal(f.state.pages.at(-1).target, f.state.current.target.descriptor);
 assert.equal((await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true})).incremental.phase, 'ready');
 assert.equal((await f.history.read(a.contact_id)).messages.length, 1);
});
