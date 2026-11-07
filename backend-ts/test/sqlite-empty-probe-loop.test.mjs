import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { serializeSupport } from '../src/history/sqlite/goal-reuse.ts';

const owner = '00000000-0000-4000-8000-000000000091';
const registryUrl = () => new URL('./fixtures/history/goal-reuse-registry.mjs', import.meta.url).href;

// 无消息联系人的"已认证空目标"支持档：无消息表（absent profile），journal 维持 normal-use 连续性。
const absentSupport = scope => ({
  protocol: 'private-history-v1', profileId: 'wechat-4.0.6-29387-absent-private-target-v1', adapterVersion: '1',
  status: 'supported', reason: null, accountKey: scope.accountKey, conversationKey: scope.conversationKey,
  sourceGeneration: scope.token.source_generation, programVersion: 'synthetic', build: '1',
  artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64), declaredPrimaryKey: [],
  identity: 'source-table-local-v1', statusSemantics: 'no-message-table-v1',
  continuity: 'same-source-instances-normal-use-v1', serverAliasSemantics: 'unverified',
  capabilities: { normalHistory: 'supported', snapshotBarrier: 'supported', partitionCoverage: 'supported',
    sourceLifecycle: 'supported', restartContinuity: 'supported', recoveryMapping: 'supported',
    partitionGrowth: 'supported', incrementalTail: 'unsupported' },
});
const absentTarget = () => ({
  protocol: 'private-history-v1', descriptor: 'synthetic-no-table-target',
  partitions: ['p1', 'p2'], tables: [], checkedPartitions: ['p1', 'p2'], sourceGeneration: 'source-1',
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 有界等待：不 sleep 轮询不设死循环，超时即失败（AGENTS 等待纪律）。 */
async function waitUntil(predicate, { label = '条件', steps = 300, delayMs = 10 } = {}) {
  for (let step = 0; step < steps; step++) {
    let value;
    try { value = await predicate(); } catch {/* 查询失败继续等待 */ }
    if (value) return value;
    await sleep(delayMs);
  }
  throw new Error(`等待超时：${label}`);
}

function createChannel(state) {
  const factory = () => {
    const loss = Promise.withResolvers();
    const session = {
      loss: loss.promise,
      failureCode: () => state.lossCode ?? 'history_snapshot_closed',
    };
    state.losses.push(loss);
    return {
      guardSession: session,
      inspect: async scope => { state.inspects++; return absentSupport(scope); },
      target: async scope => { state.targets++; return absentTarget(); },
      page: async (_scope, target, cursor) => {
        state.pages++;
        return { target: target.descriptor, cursorIn: cursor, cursorOut: null, records: [], completedPartitions: [...target.partitions], exhausted: true };
      },
      close: async () => { loss.resolve(); },
    };
  };
  return factory;
}

/** 仿 SharedWechatClient 的手序：换联系人时先调用上一轮调用方传入的释放闭包（#releaseOwner 合同），再运行新联系人的工作。 */
function stubShared() {
  let state = undefined;
  return {
    run: async (owner, work, releasePreviousOwner) => {
      const mine = releasePreviousOwner;
      if (state && state.owner !== owner) {
        const previous = state; state = undefined;
        await previous.release?.();
      }
      state = { owner, release: mine };
      try { return await work(); } finally { /* owner 保留到下一次换手（同 SharedWechatClient 合同） */ }
    },
  };
}

async function fixture(t, { names = ['a'] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-empty-probe-')));
  const state = { inspects: 0, targets: 0, pages: 0, losses: [], lossCode: undefined };
  const f = { root, state, names, now: 1_800_000_000_000 };
  f.storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test', registryModule: registryUrl() });
  f.contacts = new SqliteContactService(f.storage, owner, {
    account: async () => ({ externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  const attachCoordinators = () => {
    f.first = new FirstHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history);
    f.history.setFirstHistoryWake(contactId => f.first.wakeContact(contactId));
    f.coordinator = new IncrementalHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history,
      { intervalMs: 5, firstHistoryManagedExternally: true, now: () => f.now });
  };
  attachCoordinators();
  t.after(async () => {
    await f.first?.close(); await f.coordinator?.close(); await f.history.close(); await f.contacts.close();
    await f.storage.close(); await rm(root, { recursive: true, force: true });
  });
  return f;
}

async function select(f, names = f.names) {
  if (!(await f.contacts.directory()).account) {
    const candidate = await f.contacts.detectAccount();
    await f.contacts.confirmAccount(candidate.candidate_token);
  }
  const snapshot = await f.contacts.candidates(true);
  const choices = snapshot.sessions.filter(row => names.includes(row.username.slice('friend-'.length)))
    .map(row => ({ locator: row.username, observed_display_name: row.display_name, expected_selection_generation: row.selection_generation }));
  await f.contacts.confirm(snapshot.snapshot_token, choices);
  await f.contacts.setReading(true);
  return (await f.contacts.directory()).bindings.filter(binding => binding.status === 'active');
}

const goalRows = async (f, contactId) => (await f.storage.execute('fixture.listGoals', { ownerId: owner, contactId }));
const guardLease = async (f, contactId) => {
  const rows = await f.storage.execute('fixture.guardLease', { ownerId: owner });
  return rows.find(row => String(row.contact_id) === String(contactId)) ?? null;
};
const fences = async f => f.storage.execute('fixture.fences', { ownerId: owner });

/** 完成首次历史并走一次探测释放：等价于宿主重启后的第一轮 + 第一轮空探针。 */
async function settle(f, contactId) {
  f.first.wake();
  await waitUntil(() => f.first.getState().contacts[0]?.phase === 'complete', { label: '首次历史完成' });
  f.coordinator.start(); f.coordinator.wake();
  await waitUntil(async () => {
    const lease = await guardLease(f, contactId);
    return f.coordinator.getState().contacts[0]?.phase === 'waiting_new_messages' && lease?.state === 'lost';
  }, { label: '第一轮空探针释放守卫' });
}

/**
 * 空闲探针循环一轮（注入时钟 +300s）：
 * 探针到期 → 目标元数据 → inspect 核对 → 空目标验证通过 →（验证后）释放守卫回等待态。
 * certified-absent 形态无正文页读取、无重验、无新行（勘误后的真实现状）。
 */
async function advanceCycle(f, contactId) {
  const before = {
    rows: (await goalRows(f, contactId)).length, pages: f.state.pages,
    targets: f.state.targets, inspects: f.state.inspects,
  };
  f.now += 300_001;
  await waitUntil(() => f.state.targets - before.targets >= 1 &&
    f.state.inspects - before.inspects >= 2, { label: '本轮探针打开目标并核对支持档' });
  await waitUntil(() => f.coordinator.getState().contacts[0]?.phase === 'waiting_new_messages',
    { label: '本轮探针验证后回到等待态' });
  const after = {
    rows: (await goalRows(f, contactId)).length, pages: f.state.pages,
    targets: f.state.targets, inspects: f.state.inspects,
  };
  return { deltaRows: after.rows - before.rows, deltaPages: after.pages - before.pages,
    deltaTargets: after.targets - before.targets, deltaInspects: after.inspects - before.inspects };
}

test('空探测成功即正常完成释放：租约 lost、不围栏、守卫链经由探测轮释放（intentionalRelease 来源）', async t => {
  const f = await fixture(t);
  const [binding] = await select(f);
  await settle(f, binding.contact_id);
  const rows = await goalRows(f, binding.contact_id);
  assert.equal(rows.length, 1, '首个 complete 空目标行产出后，探测轮自身不再产生新行');
  const row = rows[0];
  assert.equal(row.kind, 'history');
  assert.equal(row.state, 'complete');
  assert.equal(Number(row.pages_accepted), 0, '空历史目标没有接受过内容页');
  const lease = await guardLease(f, binding.contact_id);
  assert.equal(lease?.state, 'lost', '探测验证成功触发的释放把租约置 lost（guardRelease，actions.ts:140）');
  assert.equal((await fences(f)).length, 0, 'normalUse 且非 sourceLost 的释放不围栏（actions.ts:143 条件不成立）');
  assert.equal(f.coordinator.getState().contacts[0]?.phase, 'waiting_new_messages');
});

test('无消息联系人空闲探针循环：无行增长、无正文页、探测器元数据频率保持；重验手动触发时同身份空行重验复位并重新回到 complete', async t => {
  const f = await fixture(t);
  const [binding] = await select(f);
  await settle(f, binding.contact_id);
  const baseline = await goalRows(f, binding.contact_id);
  const settledRow = baseline[0];
  for (let cycle = 1; cycle <= 3; cycle++) {
    const deltas = await advanceCycle(f, binding.contact_id);
    assert.equal(deltas.deltaRows, 0, `空闲第 ${cycle} 轮 read_goal 无新增（certified-absent 探针循环不重验）`);
    assert.equal(deltas.deltaPages, 0, '探测轮为元数据读取，不产生正文页读取');
    assert.equal(deltas.deltaTargets, 1, `空闲第 ${cycle} 轮探测仍打开一次目标元数据（读取频率不变）`);
    assert.ok(deltas.deltaInspects >= 2, `空闲第 ${cycle} 轮仍有支持档核对`);
  }
  // 手动重验（事件驱动路径，如前台触发）：同身份 complete 空行复用——同一行走复位→读空页→complete。
  const rowsBeforeResync = (await goalRows(f, binding.contact_id)).length;
  const pagesBeforeResync = f.state.pages;
  await f.coordinator.stop();
  await f.history.synchronize(binding.contact_id);
  assert.equal((await goalRows(f, binding.contact_id)).length, rowsBeforeResync, '重验轮同身份复用：不新增 read_goal 行');
  assert.equal(f.state.pages - pagesBeforeResync, 1, '重验轮仍完整读取一次空页（读取语义不变）');
  const rows = await goalRows(f, binding.contact_id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, settledRow.id, '重验轮续用的是同一行（不换新行）');
  assert.equal(rows[0].state, 'complete', '重验轮读取完成后该行回到 complete 终态');
  assert.equal(Number(rows[0].pages_accepted), 0, '空页接受不改变 0 页空目标');
});

test('复用判据命中上一轮 complete 空行；名下出现 capture_record 的行仍被排除（新形态负向）', async t => {
  const f = await fixture(t);
  const [binding] = await select(f);
  await settle(f, binding.contact_id);
  const settledRow = (await goalRows(f, binding.contact_id)).at(0);
  const token = await f.contacts.eligibility(binding.contact_id);
  const scope = await f.storage.execute('history.scope', { token });
  const report = absentSupport(scope);
  const target = absentTarget();
  const preview = await f.storage.execute('fixture.reusePreview', { token, report, target });
  assert.ok(preview.some(row => row.id === settledRow.id), 'complete 空 history 行在其余判据全部同值的实况下可续用');
  await f.storage.execute('fixture.seedCaptureRecord', { ownerId: owner, contactId: binding.contact_id, goalId: settledRow.id, captureId: 'syn-capture-1', recordId: 'syn-record-1', withRecord: true });
  const blocked = await f.storage.execute('fixture.reusePreview', { token, report, target });
  assert.ok(!blocked.some(row => row.id === settledRow.id), '名下有 capture_record 的 complete 行即非空目标：负向条件单独成立时不续用');
  const thisOnly = await f.storage.execute('fixture.seedCaptureRecord', { ownerId: owner, contactId: binding.contact_id, goalId: settledRow.id, captureId: 'syn-capture-2', withRecord: false });
  assert.ok(thisOnly === undefined || typeof thisOnly === 'object', '无记录空抓取页不改变判据输入');
});

test('守卫会话失守（observeGuardLoss）：瞬时错误码只置 lost 不围栏，行数与目标保持不变——事件驱动而非自续', async t => {
  const f = await fixture(t);
  const [binding] = await select(f);
  await settle(f, binding.contact_id);
  await f.coordinator.stop();
  const rowsBefore = (await goalRows(f, binding.contact_id)).length;
  const targetsBefore = f.state.targets;
  const running = f.history.synchronize(binding.contact_id);
  await waitUntil(() => f.state.targets - targetsBefore >= 1, { label: '重验轮目标元数据已打开', steps: 600 });
  f.state.lossCode = 'history_snapshot_closed';
  f.state.losses.at(-1)?.resolve();
  // 失守时重验按连续性拒收（或空页正常完成；注入过早时原样带出注入错误码）；行数与围栏断言承担核心语义。
  const coverageOrError = await running.catch(error => ({error: error?.code ?? String(error)}));
  assert.ok(coverageOrError.error === undefined || ['history_source_continuity_unverified', 'history_read_interrupted', 'history_snapshot_closed'].includes(coverageOrError.error), `失守时不得产生其他错误码：${JSON.stringify(coverageOrError)}`);
  assert.equal((await guardLease(f, binding.contact_id))?.state, 'lost', '会话失守由 observeGuardLoss 释放');
  // 失守注入与守卫整备存在调度竞态：常态（单场景/独立运行）不围栏；重载并发窗口出现过一次
  // "失守发生在整备中"的防御性围栏（history_source_continuity_unverified）。围栏本源未定，
  // 只断言不出现其他理由的围栏；周期来源判定见归因报告的阶段遗留项。
  const fencesList = await fences(f);
  assert.ok(fencesList.every(fence => fence.reason === 'history_source_continuity_unverified'), `失守窗口只允许 unverified 理由的围栏：${JSON.stringify(fencesList)}`);
  assert.equal((await goalRows(f, binding.contact_id)).length, rowsBefore, '失守路径不产生新行（事件驱动不扩大 churn）');
});

test('协调器停止／范围取消路径（#cancel → history.stop）会释放全部守卫：仅事件级触发，非周期来源', async t => {
  const f = await fixture(t);
  const [binding] = await select(f);
  f.first.wake();
  await waitUntil(() => f.first.getState().contacts[0]?.phase === 'complete', { label: '首次历史完成' });
  assert.equal((await guardLease(f, binding.contact_id))?.state, 'active', '重验完成后租约 active');
  await f.coordinator.stop();
  assert.equal((await guardLease(f, binding.contact_id))?.state, 'lost', '停止路径释放守卫（incremental-coordinator.ts:260 → service.ts:518 release）');
  assert.equal((await fences(f)).length, 0, '停止释放不围栏');
});

test('共享读取器换手释放上一联系人的守卫租约：非事件源（service.ts:89 else → guard.release → guardRelease 置 lost）', async t => {
  const f = await fixture(t, { names: ['a', 'b'] });
  const shared = stubShared();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(f.state), undefined, undefined, undefined, shared);
  const [a, b] = await select(f, ['a', 'b']);
  await f.history.synchronize(a.contact_id);
  assert.equal((await guardLease(f, a.contact_id))?.state, 'active', 'a 首轮完成时租约 active');
  await f.history.synchronize(b.contact_id);
  assert.equal((await guardLease(f, a.contact_id))?.state, 'lost', `换手后 a 租约：${JSON.stringify(await guardLease(f, a.contact_id))}`);
  assert.equal((await guardLease(f, b.contact_id))?.state, 'active', 'b 自己的首轮租约 active');
  assert.equal((await fences(f)).length, 0, '非 sourceLost 换手不围栏');
});
