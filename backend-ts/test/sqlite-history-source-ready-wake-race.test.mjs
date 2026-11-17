import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';

async function strictTargetFixture(t, { sharedReader = true } = {}) {
 const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
 const state = { owner: null, release: null, tail: Promise.resolve(), current: null, serial: 0, pages: [], tails: [], resumes: 0, resumeAvailable: true, channels: [], beforeInspect: null };
 const shared = { async run(owner, work, release, signal) {
  const previous = state.tail; let unlock; state.tail = new Promise(resolve => { unlock = resolve; }); await previous;
  try {
   assert.equal(signal?.aborted ?? false, false);
   if (state.owner !== owner) { await state.release?.(); state.current = null; }
   state.owner = owner; state.release = release; return await work({});
  } finally { unlock(); }
 } };
 const create = () => {
  const loss = Promise.withResolvers(), entry = { loss, code: null }; state.channels.push(entry);
  const select = (scope, target) => state.current = { contactId: scope.token.contact_id,
   target: { ...target, descriptor: `snapshot-${++state.serial}` }, tailCursor: null };
  const current = (scope, target) => {
   if (scope.token.contact_id !== state.current?.contactId || target.descriptor !== state.current?.target.descriptor)
    throw new StorageFailure('history_target_unverified');
   return state.current;
  };
  return { ...f.channel, guardSession: { loss: loss.promise, failureCode: () => entry.code },
   inspect: async scope => { const before=state.beforeInspect;state.beforeInspect=null;await before?.();return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
    capabilities: { incrementalTail: 'supported', durableIncremental: 'supported' } }; },
   target: async scope => select(scope, f.target).target,
   resumeTarget: async (scope, previous) => { state.resumes++; return state.resumeAvailable?select(scope, previous).target:null; },
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


test('首次派发与来源准备相撞后，来源重验释放读取器再唤醒使已失效新目标自动完成', {timeout:5000}, async t => {
 const cleanup=[],f=await strictTargetFixture({after:fn=>cleanup.push(fn)}),[a,b]=f.saved;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const directoryEntered=Promise.withResolvers(),directoryRelease=Promise.withResolvers();let holdDirectory=true;
 const first=new FirstHistoryCoordinator({directory:async()=>{
  const current=await f.contacts.syncDirectory();if(holdDirectory){holdDirectory=false;directoryEntered.resolve();await directoryRelease.promise;}
  return {...current,bindings:current.bindings.filter(row=>row.contact_id===a.contact_id)};
 }},f.history);
 const inspectEntered=Promise.withResolvers(),inspectRelease=Promise.withResolvers(),released=Promise.withResolvers();
 let preparing;const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{const result=await execute(name,input,...rest);if(name==='history.guardRelease'&&input.token.contact_id===a.contact_id)released.resolve();return result;};
 t.after(async()=>{directoryRelease.resolve();inspectRelease.resolve();await preparing?.catch(()=>{});await first.close();f.storage.execute=execute;for(const clean of cleanup.reverse())await clean();});
 const wakes=[];f.history.setFirstHistoryWake(id=>{wakes.push(id);first.wakeContact(id);});
 // 模拟读取器无法恢复旧检查点：增量只建立待补齐目标，并请求首次协调器接管。
 f.state.resumeAvailable=false;
 await f.history.synchronizeIncremental(a.contact_id);await directoryEntered.promise;
 assert.equal((await f.history.coverage(a.contact_id)).phase,'running');
 await released.promise;
 f.state.beforeInspect=async()=>{inspectEntered.resolve();await inspectRelease.promise;};
 preparing=f.history.ensureSourceReady(a.contact_id);await inspectEntered.promise;
 directoryRelease.resolve();await first.waitForIdle();
 assert.equal(first.getState().contacts.find(row=>row.contactId===a.contact_id).phase,'incomplete','同联系人来源准备正在读取时首次派发不能并行读取');
 assert.equal(first.getState().contacts.find(row=>row.contactId===a.contact_id).lastError,'history_already_running');
 inspectRelease.resolve();await preparing;await first.waitForIdle();
 assert.equal((await f.history.coverage(a.contact_id)).phase,'complete','成功重验必须重新唤醒被互斥阻断的首次读取');
 assert.deepEqual(wakes,[a.contact_id,a.contact_id]);
 const token=await f.contacts.eligibility(a.contact_id);assert.equal(await execute('history.preflightGeneration',{token}),true);
 assert.equal((await f.history.read(a.contact_id)).messages.length,1);
});
