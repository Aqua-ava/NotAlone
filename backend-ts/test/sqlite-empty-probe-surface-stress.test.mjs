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

/**
 * fenceContinuity 写入点的重载竞态调查（.scratch/fence-origin-attribution）。
 * 只读调查的放大器（不改产品代码）：每个用例内部多轮触发"手动重验 × loss 注入抢在
 * 目标打开前后"与"共享换手 × 重验并发"两变体，统计 fence 行是否出现并通过 t.diagnostic
 * 汇报命中次数。命中不判失败——由人工读取诊断行决定是否进入围栏本源阶段。
 */
const owner = '00000000-0000-4000-8000-000000000111';
const registryUrl = () => new URL('./fixtures/history/goal-reuse-registry.mjs', import.meta.url).href;
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
const absentTarget = () => ({ protocol: 'private-history-v1', descriptor: 'synthetic-no-table-target',
  partitions: ['p1', 'p2'], tables: [], checkedPartitions: ['p1', 'p2'], sourceGeneration: 'source-1' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, { label = '条件', steps = 400, delayMs = 10 } = {}) {
  for (let step = 0; step < steps; step++) {
    let value;
    try { value = await predicate(); } catch {/* 查询失败继续等待 */ }
    if (value) return value;
    await sleep(delayMs);
  }
  throw new Error(`等待超时：${label}`);
}
function createChannel(state) {
  return () => {
    const loss = Promise.withResolvers();
    state.losses.push(loss);
    return {
      guardSession: { loss: loss.promise, failureCode: () => state.lossCode ?? 'history_snapshot_closed' },
      inspect: async scope => { state.inspects++; return absentSupport(scope); },
      target: async scope => { state.targets++; return absentTarget(); },
      page: async (_scope, target, cursor) => {
        state.pages++;
        return { target: target.descriptor, cursorIn: cursor, cursorOut: null, records: [], completedPartitions: [...target.partitions], exhausted: true };
      },
      close: async () => { loss.resolve(); },
    };
  };
}
function stubShared() {
  let state;
  return { run: async (owner, work, releasePreviousOwner) => {
    const mine = releasePreviousOwner;
    if (state && state.owner !== owner) { const previous = state; state = undefined; await previous.release?.(); }
    state = { owner, release: mine };
    try { return await work(); } finally { /* owner 保留到下一次换手（同 SharedWechatClient 合同） */ }
  } };
}
async function stressFixture(t, names = ['a']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-fence-stress-')));
  const state = { inspects: 0, targets: 0, pages: 0, losses: [], lossCode: undefined };
  const f = { root, state, now: 1_800_000_000_000 };
  f.storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test', registryModule: registryUrl() });
  f.contacts = new SqliteContactService(f.storage, owner, {
    account: async () => ({ externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  f.first = new FirstHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history);
  f.history.setFirstHistoryWake(contactId => f.first.wakeContact(contactId));
  f.coordinator = new IncrementalHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history,
    { intervalMs: 5, firstHistoryManagedExternally: true, now: () => f.now });
  t.after(async () => {
    await f.first?.close(); await f.coordinator?.close(); await f.history.close(); await f.contacts.close();
    await f.storage.close(); await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function select(f, names) {
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
const guardLease = (f, contactId) => f.storage.execute('fixture.guardLease', { ownerId: owner })
  .then(rows => rows.find(row => String(row.contact_id) === String(contactId)) ?? null);
const fences = f => f.storage.execute('fixture.fences', { ownerId: owner });

async function settle(f, contactId) {
  f.first.wake();
  await waitUntil(() => f.first.getState().contacts[0]?.phase === 'complete', { label: '首次历史完成' });
  f.coordinator.start(); f.coordinator.wake();
  await waitUntil(async () => {
    const lease = await guardLease(f, contactId);
    return f.coordinator.getState().contacts[0]?.phase === 'waiting_new_messages' && lease?.state === 'lost';
  }, { label: '第一轮空探针释放守卫' });
}

/** 每轮收口（best-effort）：三次短推钟给探针释放机会；超时不视为失败（围栏计数不依赖租约状态）。 */
async function drainToLost(f, contactIds) {
  for (let push = 0; push < 3; push++) {
    f.now += 301_000;
    try {
      await waitUntil(async () => {
        const leases = await Promise.all(contactIds.map(contactId => guardLease(f, contactId)));
        return leases.every(lease => !lease || lease.state !== 'active');
      }, { label: '推钟后无 active 租约', steps: 40 });
    } catch {/* best-effort：下一推或下一轮继续 */ }
  }
}

/** 变体 A：独占通道"手动重验 × loss 注入抢在目标打开前后"竞态；返回本轮 fence 增量。 */
async function variantA(f, contactId) {
  const before = (await fences(f)).length;
  f.state.lossCode = 'history_snapshot_closed';
  const running = f.history.synchronize(contactId);
  try {
    await waitUntil(() => f.state.targets > 0, { label: '目标打开', steps: 200 });
    f.state.losses.at(-1)?.resolve();
    await running.catch(error => ({error: error?.code ?? String(error)}));
  } finally { f.state.lossCode = undefined; }
  await drainToLost(f, [contactId]);
  return (await fences(f)).length - before;
}

/** 变体 B：共享 stub 双联系人"换手 × 重验并发"竞态；返回本轮 fence 增量。 */
async function variantB(f, a, b) {
  const before = (await fences(f)).length;
  f.state.lossCode = 'history_snapshot_closed';
  const first = f.history.synchronize(a.contact_id);
  try {
    await waitUntil(() => f.state.targets >= 1, { label: 'a 目标打开', steps: 200 });
    f.state.losses.at(-1)?.resolve();
    await first.catch(error => ({error: error?.code ?? String(error)}));
    await f.history.synchronize(b.contact_id).catch(error => ({error: error?.code ?? String(error)}));
  } finally { f.state.lossCode = undefined; }
  await drainToLost(f, [a.contact_id, b.contact_id]);
  return (await fences(f)).length - before;
}

test('竞态窗口放大：10 轮变体 A（独占通道手动重验提前失守）+ 10 轮变体 B（共享换手失守）', { timeout: 60_000 }, async t => {
  const report = []; let hits = 0;
  {
    const f = await stressFixture(t, ['a']);
    const [binding] = await select(f, ['a']);
    await settle(f, binding.contact_id);
    for (let round = 1; round <= 10; round++) {
      const fenceDelta = await variantA(f, binding.contact_id);
      report.push(`A#${round} fenceDelta=${fenceDelta}`);
      if (fenceDelta > 0) { hits += 1; report.push(`A#${round} HIT fences=${JSON.stringify(await fences(f))}`); }
    }
  }
  {
    const f = await stressFixture(t, ['a', 'b']);
    const [a, b] = await select(f, ['a', 'b']);
    for (let round = 1; round <= 10; round++) {
      const fenceDelta = await variantB(f, a, b);
      report.push(`B#${round} fenceDelta=${fenceDelta}`);
      if (fenceDelta > 0) { hits += 1; report.push(`B#${round} HIT fences=${JSON.stringify(await fences(f))} leaseA=${JSON.stringify(await guardLease(f, a.contact_id))}`); }
    }
  }
  assert.ok(true);
  report.push(`FENCE-HITS=${hits}/20`);
  for (const line of report) t.diagnostic(line);
});
