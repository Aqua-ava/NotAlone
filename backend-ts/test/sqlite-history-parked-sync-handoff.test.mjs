import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';

async function parkedFixture(t, {durable = false} = {}) {
  const cleanup = [], f = await fixture({ after: callback => cleanup.push(callback) },{registryModule:new URL('./fixtures/history-parked-registry.mjs',import.meta.url).href});
  const state = { owner: undefined, releaseOwner: undefined, tail: Promise.resolve(), parks: 0, pages: 0, channels: [], wakes: [], targets: 0, operations: [], extraRows: new Map(), checkpoints: new Map() };
  // 只替代共享进程租约边界；每轮新快照，恢复后必须先读当前目标终页，再读增量。
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
    const loss = Promise.withResolvers(), current = { loss, code: null, scope: null, target: null, terminal: false, closed: false };
    state.channels.push(current);
    const target = async scope => {
      assert.equal(current.closed, false);
      current.target = {...await f.channel.target(scope), descriptor: `synthetic-snapshot-${++state.targets}`};current.terminal = false;
      return current.target;
    };
    return { ...f.channel,
      guardSession: { loss: loss.promise, failureCode: () => current.code },
      inspect: async scope => {
        current.scope = scope;
        return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
          capabilities: { incrementalTail: 'supported', ...(durable ? {durableIncremental: 'supported'} : {}) } };
      },
      target,
      resumeTarget: durable ? async (scope, previous, cursor) => {
        assert.deepEqual(state.checkpoints.get(scope.token.contact_id), {target: previous, cursor}, '恢复点必须属于同一联系人上次真实接受的目标');
        state.operations.push({op: 'resume', contactId: scope.token.contact_id});return target(scope);
      } : undefined,
      page: async (scope, target, cursor) => {
        assert.equal(current.closed, false);assert.deepEqual(target, current.target);current.terminal = true;state.pages++;
        state.operations.push({op: 'page', contactId: scope.token.contact_id, target: target.descriptor});
        state.checkpoints.set(scope.token.contact_id, {target: structuredClone(target), cursor: `tail:${scope.conversationKey}`});
        return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
        records: [record('1', { text: `合成历史：${scope.conversationKey}` }), ...(state.extraRows.get(scope.token.contact_id) ?? [])], completedPartitions: ['shard-a'],
        exhausted: true, resumeCursor: `tail:${scope.conversationKey}` };},
      tail: async (scope, target, cursor) => {
        assert.equal(current.closed, false);assert.deepEqual(target, current.target);assert.equal(current.terminal, true, '恢复不能跳过当前快照终页');
        state.operations.push({op: 'tail', contactId: scope.token.contact_id, target: target.descriptor});
        return { target: target.descriptor, cursorIn: cursor, cursorOut: cursor, records: [], caughtUp: true };
      },
      park: async () => { state.parks++; },
      close: async () => { current.closed = true;loss.resolve(); },
    };
  }, undefined, undefined, undefined, shared);
  history.setFirstHistoryWake(contactId => state.wakes.push(contactId));
  t.after(async () => { await history.close(); await f.service.close(); for (const callback of cleanup.reverse()) await callback(); });
  return { ...f, history, state };
}

test('共享读取器切换联系人后，每轮新快照在同租约读终页并连续两轮保存增量', async t => {
  const f = await parkedFixture(t, {durable: true}), [a, b] = f.saved;
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  assert.equal(f.state.parks,0,'切换联系人前已释放本轮渠道，不再保留停车读者');
  const beforeB = (await f.history.read(b.contact_id)).messages.map(row => row.id);
  const handoff = await f.history.synchronizeIncremental(a.contact_id);
  assert.equal(handoff.phase, 'complete');
  assert.equal(handoff.incremental.phase, 'ready');
  assert.equal(handoff.incremental.failureCode, null);
  assert.deepEqual(f.state.wakes, [], '已认证恢复在当前租约完成交接，无需另开首次读者');
  assert.equal((await f.history.read(a.contact_id)).messages.length, 1, '换目标补齐不重复建立历史消息');
  const extra = [];
  for (let round = 1; round <= 2; round++) {
    extra.push(record(String(round + 1), {text: `合成后续消息${round}`}));f.state.extraRows.set(a.contact_id, extra);
    const caughtUp = await f.history.synchronizeIncremental(a.contact_id);assert.equal(caughtUp.incremental.phase, 'ready');
    const messages = (await f.history.read(a.contact_id)).messages;
    assert.equal(messages.length, extra.length + 1);
    for (const row of extra) assert.equal(messages.filter(message => message.text === row.text).length, 1, '新快照恢复保存后续消息且不重复');
  }
  assert.deepEqual((await f.history.read(b.contact_id)).messages.map(row => row.id), beforeB);
  const tails = f.state.operations.filter(row => row.op === 'tail');assert.equal(tails.length, 3);
  assert.equal(new Set(tails.map(row => row.target)).size, 3, '共享进程复用仍须每轮创建新快照');
  for (const tail of tails) assert.deepEqual(f.state.operations[f.state.operations.indexOf(tail) - 1], {...tail, op: 'page'});
  assert.ok(f.state.channels.every(channel => channel.closed), '每轮读取结束即关闭实际快照');
});

test('无持久检查点时协调器接回首次核验，旧进程错误不能替代当前来源证明', async t => {
  const f = await parkedFixture(t), [a, b] = f.saved;
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  const current = f.state.channels.at(-1);
  current.code = 'history_native_timeout'; current.loss.resolve();
  // 本轮已释放；旧渠道回执不能新增围栏，下一轮仍按当前来源核验。
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
    assert.deepEqual(f.state.wakes, [b.contact_id], '缺少持久检查点时仍接回正式首次核验');
  } finally { await incremental.close(); }
  assert.equal((await f.history.coverage(b.contact_id)).phase, 'running','协调器已建立经核验的新历史目标并交接首次补齐');
  assert.equal((await f.storage.execute('fixture.sourceProofStates',{ownerId:f.contacts.ownerId})).find(row=>row.contact_id===b.contact_id).state,'ok');
  const token = await f.contacts.eligibility(b.contact_id);
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), true);
  await f.history.synchronize(b.contact_id);
  f.state.wakes.length = 0;
  // 上轮已关闭的渠道不再拥有来源资格；旧错误码不能证明当前联系人来源变化。
  const stopped = f.state.channels.at(-1);
  stopped.code = 'history_source_changed'; stopped.loss.resolve();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await f.storage.check();
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate', { token }), true);
  await f.history.requestFirstHistoryRecovery(b.contact_id);
  assert.deepEqual(f.state.wakes, [b.contact_id], '下一轮只按持久来源事实发起当前核验，不沿用旧进程错误');
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

for(const {code,failFirstRecovery} of [{code:'history_native_timeout'},{code:'history_source_changed'},{code:'history_native_timeout',failFirstRecovery:true}])test(`已释放读者迟到${code}不阻止持久恢复${failFirstRecovery?'，资格查询失败后下轮继续':''}`,async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=await parkedFixture(t,{durable:true}),[a,b]=f.saved;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const directory={directory:async()=>{const saved=await f.contacts.syncDirectory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===a.contact_id)};}};
 const incremental=new IncrementalHistoryCoordinator(directory,f.history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 const first=new FirstHistoryCoordinator(directory,f.history);t.after(async()=>{await incremental.close();await first.close();});
 incremental.wake();await incremental.waitForIdle();
 // 真实持久恢复在同一租约读完新快照并交接增量，不沿用旧快照身份。
 assert.equal(incremental.getState().contacts[0].phase,'caught_up');
 await f.history.synchronize(a.contact_id);
 const guard=f.state.channels.at(-1);guard.code=code;guard.loss.resolve();
 for(let index=0;index<12;index++)await Promise.resolve();await f.history.waitForReadIdle(a.contact_id);await f.storage.check();
 const token=await f.contacts.eligibility(a.contact_id);
 // 已关闭渠道的迟到错误不证明当前来源变化，下一轮仍完整核验持久恢复点。
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
 assert.deepEqual(wakes,[],'有效持久恢复在当前租约完成，不另开首次读取');
 assert.equal((await f.history.coverage(a.contact_id)).phase,'complete','完整重验后须自动恢复同步');
 assert.equal((await f.history.read(a.contact_id)).messages.length,1);assert.equal((await f.history.read(b.contact_id)).messages.length,1);
 assert.ok(f.state.channels.every(channel=>channel.closed),'恢复和查询失败均不能遗留空闲快照');
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
