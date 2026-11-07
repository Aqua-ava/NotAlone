import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, restart, createChannel, report, target, record, waitFor} from './sqlite-clear-support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

const registryModule = new URL('./fixtures/history/shared-loss-registry.mjs', import.meta.url).href;
const normalUse = scope => ({...report, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
  sourceGeneration: scope.token.source_generation, continuity: 'same-source-instances-normal-use-v1'});

/**
 * 共享读取器失证回归夹具：一个合成共享进程承载多位联系人，进程停止时同一 failureCode 会送达所有守卫，
 * 与真实 SharedWechatClient/WechatHistoryChannel 的 guardSession.failureCode 行为一致。
 */
async function sharedFixture(t, options = {}) {
  // fixture() 的清理钩子收集到本地，和本夹具服务一起按“先关服务、再关存储”的顺序注册，
  // 避免测试框架的前置 after 钩子先关闭存储导致在途服务排空阻塞。
  const cleanups = [];
  const f = await fixture({after: callback => cleanups.push(callback)},
    {registryModule: options.registryModule ?? registryModule});
  const lane = {code: null, channels: [], pages: [], closes: 0, parks: 0,
    pageGate: null, pageError: null, inspectError: null, reportFactory: null, targetFactory: null};
  const create = () => {
    const base = createChannel();
    base.state.pageRecords = [record('shard-a', '1')];
    const loss = Promise.withResolvers();
    const channel = {...base.channel,
      inspect: async scope => {
        if (lane.inspectError) throw new StorageFailure(lane.inspectError);
        if (lane.reportFactory) return await lane.reportFactory(scope);
        return normalUse(scope);
      },
      target: async scope => lane.targetFactory ? await lane.targetFactory(scope) : await base.channel.target(scope),
      page: async (scope, fixed, cursor) => {
        lane.pages.push({contactId: scope.token.contact_id, cursor});
        if (lane.pageGate) await lane.pageGate.promise;
        if (lane.pageError) throw new StorageFailure(lane.pageError);
        return await base.channel.page(scope, fixed, cursor);
      },
      park: async () => { lane.parks++; },
      guardSession: {loss: loss.promise, failureCode: () => lane.code},
      close: async () => { lane.closes++; loss.resolve(); },
    };
    lane.channels.push({channel, loss});
    return channel;
  };
  const shared = {async run(_owner, work) { return await work({}); }};
  const services = [];
  const open = () => {
    const history = new SqliteHistoryService(f.current.storage, f.current.contacts, create,
      undefined, undefined, undefined, shared);
    services.push(history);
    return history;
  };
  const service = open();
  t.after(async () => {
    for (const history of services.reverse()) await history.close().catch(() => {});
    for (const cleanup of cleanups) await cleanup();
  });
  return Object.assign(f, {service, open, lane});
}

const stateOf = f => f.current.storage.execute('fixture.continuityState', {ownerId: f.current.contacts.ownerId});
const fenceFor = (state, contactId) => state.fences.find(row => row.contactId === contactId) ?? null;
const leaseFor = (state, contactId) => state.leases.find(row => row.contactId === contactId) ?? null;
const goalsFor = (state, contactId) => state.goals.filter(row => row.contactId === contactId);
const stopSharedProcess = async (f, code) => {
  f.lane.code = code;
  for (const {loss} of f.lane.channels) loss.resolve();
  await waitFor(async () => {
    const state = await stateOf(f);
    return state.leases.length > 0 && state.leases.every(row => row.state === 'lost');
  }, '共享读取器整体停止后守卫应降级为 lost');
};

test('共享读取器整体停止时来源错误码不批量围栏空闲守卫，下一次读取完整重验后续租', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  await f.service.synchronize(f.contactB);
  let state = await stateOf(f);
  assert.equal(state.fences.length, 0);
  assert.deepEqual(state.leases.map(row => row.state).sort(), ['active', 'active']);

  // 共享进程以来源连续性错误码整体停止：两个空闲守卫都收到同一错误码。
  await stopSharedProcess(f, 'history_source_changed');
  state = await stateOf(f);
  assert.equal(state.fences.length, 0, '共享进程整体停止不能把空闲联系人批量围栏');
  assert.ok(state.leases.every(row => row.state === 'lost'), '守卫只降级为 lost，等下一次读取完整重验');

  const before = goalsFor(state, f.contactA).length;
  const coverage = await f.service.synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  state = await stateOf(f);
  assert.equal(fenceFor(state, f.contactA), null, '元数据重验通过后不得围栏');
  assert.equal(leaseFor(state, f.contactA).state, 'active', '重验成功须在当前运行代次续租');
  assert.ok(goalsFor(state, f.contactA).length > before, '重验成功须用当前读取器建立新目标');
});

test('共享读取器整体停止时只有正在读取的联系人按自身错误围栏，其他守卫只降级', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactB);
  f.lane.pageGate = Promise.withResolvers();
  f.lane.pageError = 'history_source_changed';
  const reading = f.service.synchronize(f.contactA).catch(error => error);
  await waitFor(() => f.lane.pages.length > 0, '联系人A应进入页读取');
  f.lane.code = 'history_source_changed';
  for (const {loss} of f.lane.channels) loss.resolve();
  f.lane.pageGate.resolve();
  await reading;
  await waitFor(async () => (await stateOf(f)).fences.length === 1, '读取中的联系人自身拿到来源错误后应围栏');
  const state = await stateOf(f);
  assert.ok(fenceFor(state, f.contactA), '正在读取的联系人按自己的来源错误围栏');
  assert.equal(fenceFor(state, f.contactB), null, '空闲联系人不得被同一共享进程错误连带围栏');
  assert.equal(leaseFor(state, f.contactB).state, 'lost', '空闲守卫只降级为 lost');
});

test('共享读取器停止后重验发现真实目标变化仍围栏并停读', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  await stopSharedProcess(f, 'history_source_changed');
  const before = goalsFor(await stateOf(f), f.contactA).length;
  f.lane.targetFactory = async scope => ({protocol: 'private-history-v1', descriptor: 'changed-synthetic-target',
    sourceGeneration: scope.token.source_generation, partitions: [...target.partitions],
    tables: [{partition: 'shard-a', instance: 'replaced-table-instance'}, ...target.tables.slice(1)]});
  await assert.rejects(f.service.synchronize(f.contactA), {code: 'history_source_continuity_unverified'});
  const state = await stateOf(f);
  assert.ok(fenceFor(state, f.contactA), '旧目标被替换后重验必须重新围栏');
  assert.equal(goalsFor(state, f.contactA).length, before, '围栏前不得建立新目标');
});

test('共享读取器停止后重验发现来源身份变化仍围栏并停读', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  await stopSharedProcess(f, 'history_source_changed');
  f.lane.reportFactory = async scope => ({...normalUse(scope), accountKey: 'synthetic-other-account'});
  await assert.rejects(f.service.synchronize(f.contactA), {code: 'history_external_scope_changed'});
  const state = await stateOf(f);
  assert.ok(fenceFor(state, f.contactA), '来源身份变化必须围栏');
  assert.equal(leaseFor(state, f.contactA).state, 'lost');
});

test('共享读取器停止后重验不可用仍停读，恢复后完整重验才继续', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  await stopSharedProcess(f, 'history_source_changed');
  const before = goalsFor(await stateOf(f), f.contactA).length;
  f.lane.inspectError = 'history_native_unavailable';
  await assert.rejects(f.service.synchronize(f.contactA), {code: 'history_native_unavailable'});
  let state = await stateOf(f);
  assert.equal(state.fences.length, 0, '重验不可用时只停读，不能把守卫降级当作真实围栏');
  assert.equal(goalsFor(state, f.contactA).length, before, '重验不可用时不得建立新目标');
  assert.equal((await f.service.coverage(f.contactA)).failureCode, 'history_source_continuity_unverified', '重验不可用时读取必须保持停读');
  f.lane.inspectError = null;
  const coverage = await f.service.synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  state = await stateOf(f);
  assert.equal(state.fences.length, 0);
  assert.equal(leaseFor(state, f.contactA).state, 'active');
});

test('读取器缺少受控恢复能力时保留围栏，不建立目标或读取正文', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  const token = await f.current.contacts.eligibility(f.contactA);
  await f.current.storage.execute('history.markContinuityLost', {token});
  let state = await stateOf(f);
  assert.ok(fenceFor(state, f.contactA));
  const before = goalsFor(state, f.contactA).length;
  await assert.rejects(f.service.synchronize(f.contactA), {code: 'history_source_recovery_unsupported'});
  state = await stateOf(f);
  assert.ok(fenceFor(state, f.contactA), '既有围栏不得被新读取或重验删除');
  assert.equal(goalsFor(state, f.contactA).length, before, '围栏期间不得建立新的读取目标');
});

test('干净关闭（守卫 lost）后新运行代次首次读取完整重验并续租，不围栏', {timeout: 15000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  const previousRuntime = leaseFor(await stateOf(f), f.contactA).runtimeId;
  await f.service.close(); // 干净关闭：guardRelease(normalUse) 只把守卫置 lost。
  const closedState = await stateOf(f);
  assert.equal(closedState.fences.length, 0);
  assert.equal(leaseFor(closedState, f.contactA).state, 'lost');
  // 真实新运行代次：重开存储即由存储 worker 更新 database_instance.runtime_id。
  await restart(f, t);
  const nextState = await stateOf(f);
  assert.notEqual(nextState.runtimeId, previousRuntime);
  assert.equal(leaseFor(nextState, f.contactA).runtimeId, previousRuntime, '干净关闭保留旧运行代次的 lost 守卫');
  const coverage = await f.open().synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  const state = await stateOf(f);
  assert.equal(fenceFor(state, f.contactA), null, '干净关闭后的重验不得围栏');
  assert.equal(leaseFor(state, f.contactA).state, 'active');
  assert.equal(leaseFor(state, f.contactA).runtimeId, nextState.runtimeId, '新运行代次重验后应续租当前运行代次');
});

test('硬中断（守卫 active 旧运行代次）后新运行代次首次读取完整重验并续租，不围栏', {timeout: 15000}, async t => {
  const f = await sharedFixture(t);
  await f.service.synchronize(f.contactA);
  let state = await stateOf(f);
  assert.equal(leaseFor(state, f.contactA).state, 'active');
  const crashedRuntime = leaseFor(state, f.contactA).runtimeId;
  // 硬中断不经过关停释放：不调用服务 close，直接重开存储换新运行代次；旧守卫仍是 active 但属于旧代次。
  await restart(f, t);
  state = await stateOf(f);
  assert.notEqual(state.runtimeId, crashedRuntime);
  assert.equal(leaseFor(state, f.contactA).state, 'active');
  assert.equal(leaseFor(state, f.contactA).runtimeId, crashedRuntime);
  const coverage = await f.open().synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  state = await stateOf(f);
  assert.equal(fenceFor(state, f.contactA), null, '硬中断后的首次读取不得只因运行代次变化围栏');
  assert.equal(leaseFor(state, f.contactA).state, 'active');
  assert.equal(leaseFor(state, f.contactA).runtimeId, state.runtimeId, '硬中断后的首次读取应在新运行代次续租');
});

test('共享读取器停止后无 normal-use 基线的联系人下一次读取仍按严格预检围栏', {timeout: 10000}, async t => {
  const f = await sharedFixture(t);
  // 非 normal-use 支持档没有元数据重验基线，只能按严格预检处理。
  f.lane.reportFactory = async scope => ({...report, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
    sourceGeneration: scope.token.source_generation, continuity: 'synthetic-generation-1'});
  await f.service.synchronize(f.contactA);
  let state = await stateOf(f);
  assert.equal(state.fences.length, 0);
  assert.equal(leaseFor(state, f.contactA).state, 'active');
  await stopSharedProcess(f, 'history_source_changed');
  state = await stateOf(f);
  assert.equal(state.fences.length, 0, '共享进程错误码不得直接围栏空闲守卫');
  assert.equal(leaseFor(state, f.contactA).state, 'lost');
  await assert.rejects(f.service.synchronize(f.contactA), {code: 'history_source_continuity_unverified'});
  state = await stateOf(f);
  assert.ok(fenceFor(state, f.contactA), '没有 normal-use 重验基线时，下一次严格预检必须围栏并停读');
});
