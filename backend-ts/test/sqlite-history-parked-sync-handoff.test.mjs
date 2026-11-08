import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';

async function parkedFixture(t) {
  const cleanup = [], f = await fixture({ after: callback => cleanup.push(callback) },{registryModule:new URL('./fixtures/history-parked-registry.mjs',import.meta.url).href});
  const state = { owner: undefined, releaseOwner: undefined, tail: Promise.resolve(), parks: 0, pages: 0, channels: [], wakes: [] };
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
      page: async (scope, target, cursor) => {state.pages++;return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
        records: [record('1', { text: `合成历史：${scope.conversationKey}` })], completedPartitions: ['shard-a'],
        exhausted: true, resumeCursor: `tail:${scope.conversationKey}` };},
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

test('共享读取器切换联系人后增量新目标唤醒首次补齐，同身份快照不再作废旧增量', async t => {
  const f = await parkedFixture(t), [a, b] = f.saved;
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  assert.ok(f.state.parks > 0, '读取另一联系人应停车原读取器');
  const beforeB = (await f.history.read(b.contact_id)).messages.map(row => row.id);
  const handoff = await f.history.synchronizeIncremental(a.contact_id);
  assert.equal(handoff.phase, 'running');
  // 目标复用（阶段 B）：快照身份未变时旧增量目标保持 running 继续续读，不再标记替换失效。
  assert.equal(handoff.incremental.phase, 'ready');
  assert.equal(handoff.incremental.failureCode, null);
  assert.deepEqual(f.state.wakes, [a.contact_id], '普通停车后的新历史目标也必须自动交给首次协调器');
  await f.history.synchronize(a.contact_id);
  const caughtUp = await f.history.synchronizeIncremental(a.contact_id);
  assert.equal(caughtUp.incremental.phase, 'ready');
  assert.deepEqual((await f.history.read(b.contact_id)).messages.map(row => row.id), beforeB);
  assert.equal((await f.history.read(a.contact_id)).messages.length, 1, '换目标补齐不重复建立历史消息');
});

test('空闲守卫瞬时退出后外置首次协调器仍会被唤醒，共享进程错误码须完整重验后才判围栏', async t => {
  const f = await parkedFixture(t), [a, b] = f.saved;
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  const current = f.state.channels.at(-1);
  current.code = 'history_native_timeout'; current.loss.resolve();
  // 等待易失守卫释放和同一存储队列完成，不依赖实际计时。
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
  assert.equal((await f.history.coverage(b.contact_id)).phase, 'running','协调器已建立经核验的新历史目标并交接首次补齐');
  assert.equal((await f.storage.execute('fixture.sourceProofStates',{ownerId:f.contacts.ownerId})).find(row=>row.contact_id===b.contact_id).state,'ok');
  const token = await f.contacts.eligibility(b.contact_id);
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), true);
  await f.history.synchronize(b.contact_id);
  f.state.wakes.length = 0;
  // 共享读取进程整体停止会把同一来源错误码送达所有空闲守卫；错误码本身不能证明该联系人来源变化。
  const stopped = f.state.channels.at(-1);
  stopped.code = 'history_source_changed'; stopped.loss.resolve();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await f.storage.check();
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), true);
  await f.history.requestFirstHistoryRecovery(b.contact_id);
  assert.deepEqual(f.state.wakes, [b.contact_id], '空闲守卫只能触发完整重验，不能据共享进程错误码永久停读');
  // 只有当前读取器完整重验发现真实来源身份变化时才建立围栏。
  const originalInspect = f.channel.inspect;
  f.channel.inspect = async scope => ({...await originalInspect(scope), conversationKey: 'synthetic-changed-conversation'});
  try {
    await assert.rejects(f.history.synchronize(b.contact_id), {code: 'history_external_scope_changed'});
  } finally {
    f.channel.inspect = originalInspect;
  }
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), true, '只允许再次核元数据，不解除已检测到的真实来源围栏');
  assert.equal((await f.history.coverage(b.contact_id)).failureCode,'history_source_continuity_unverified');
  assert.equal(await f.history.bodyAvailable([b.contact_id]),false);
  const source=(await f.history.read(b.contact_id)).messages[0].sourceRecordIds[0];
  await assert.rejects(f.history.source(b.contact_id,source),{code:'history_source_not_found'});
});

for(const {code,failFirstRecovery} of [{code:'history_native_timeout'},{code:'history_source_changed'},{code:'history_native_timeout',failFirstRecovery:true}])test(`增量替换阻塞后守卫${code}按持久恢复资格决定是否唤醒首次${failFirstRecovery?'，恢复查询失败后下轮继续':''}`,async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=await parkedFixture(t),[a,b]=f.saved;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const directory={directory:async()=>{const saved=await f.contacts.syncDirectory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===a.contact_id)};}};
 const incremental=new IncrementalHistoryCoordinator(directory,f.history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 const first=new FirstHistoryCoordinator(directory,f.history);t.after(async()=>{await incremental.close();await first.close();});
 incremental.wake();await incremental.waitForIdle();
 // 目标复用（阶段 B）：同身份快照的目标不被作废，协调器不再出现替换阻塞错误。
 assert.equal(incremental.getState().contacts[0].phase,'caught_up');
 await f.history.synchronize(a.contact_id);
 const guard=f.state.channels.at(-1);guard.code=code;guard.loss.resolve();
 for(let index=0;index<12;index++)await Promise.resolve();await f.history.waitForReadIdle(a.contact_id);await f.storage.check();
 const token=await f.contacts.eligibility(a.contact_id);
 // 共享读取器整体停止带来的错误码只降级守卫，恢复门要求下一次读取完整重验而非永久停读。
 assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate',{token}),true);
 const wakes=[],channels=f.state.channels.length;f.history.setFirstHistoryWake(id=>{wakes.push(id);first.wakeContact(id);});
 if(failFirstRecovery){
  const execute=f.storage.execute.bind(f.storage);let injected=false;
  f.storage.execute=(name,input,...rest)=>{if(name==='history.readPreflight'&&!injected){injected=true;return Promise.reject(new StorageFailure('history_interrupted'));}return execute(name,input,...rest);};
  incremental.start();t.mock.timers.tick(30_000);await incremental.waitForIdle();await first.waitForIdle();
  assert.equal(injected,true);assert.deepEqual(wakes,[]);assert.equal(f.state.channels.length,channels,'查询失败不能绕过资格门启动读者');
  assert.equal(incremental.getState().contacts[0].phase,'degraded','查询暂时失败保守降级，下一轮仍重试恢复');
 }
 incremental.start();t.mock.timers.tick(30_000);await incremental.waitForIdle();await first.waitForIdle();
 assert.deepEqual(wakes,[a.contact_id],'旧增量blocked不能吞掉失守卫后的合法恢复请求');
 assert.equal((await f.history.coverage(a.contact_id)).phase,'complete','完整重验后须自动恢复同步');
});

test('围栏候选仅允许核对，旧读取器缺水位恢复能力仍明确停读', async t => {
  t.mock.timers.enable({apis: ['setInterval']});
  const f = await parkedFixture(t), [a] = f.saved;
  await f.history.synchronize(a.contact_id);
  const token = await f.contacts.eligibility(a.contact_id);
  await f.storage.execute('history.markContinuityLost', {token});
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', {token}), true);
  await assert.rejects(f.history.synchronize(a.contact_id),{code:'history_source_recovery_unsupported'});
  const pageCount=f.state.pages;
  const directory = {directory: async () => {
    const saved = await f.contacts.syncDirectory();
    return {...saved, bindings: saved.bindings.filter(row => row.contact_id === a.contact_id)};
  }};
  const incremental = new IncrementalHistoryCoordinator(directory, f.history, {intervalMs: 30_000, firstHistoryManagedExternally: true});
  const first = new FirstHistoryCoordinator(directory, f.history);
  t.after(async () => { await incremental.close(); await first.close(); });
  const wakes = [];
  f.history.setFirstHistoryWake(id => { wakes.push(id); first.wakeContact(id); });
  incremental.start(); t.mock.timers.tick(30_000); await incremental.waitForIdle(); await first.waitForIdle();
  assert.deepEqual(wakes, [a.contact_id], '只唤醒当前联系人做正式元数据核对');
  assert.equal(f.state.pages,pageCount,'能力不足不能以全量重读替代水位恢复');
  assert.equal(await f.history.bodyAvailable([a.contact_id]),false);
  const source=(await f.history.read(a.contact_id)).messages[0].sourceRecordIds[0];
  await assert.rejects(f.history.source(a.contact_id,source),{code:'history_source_not_found'});
  assert.equal((await f.history.coverage(a.contact_id)).failureCode, 'history_source_continuity_unverified');
});
