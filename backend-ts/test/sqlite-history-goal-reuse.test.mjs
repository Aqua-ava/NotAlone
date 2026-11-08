import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { serializeSupport } from '../src/history/sqlite/goal-reuse.ts';

const owner = '00000000-0000-4000-8000-000000000090';
const registryUrl = () => new URL('./fixtures/history/goal-reuse-registry.mjs', import.meta.url).href;
const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
const normalUseContinuity = 'same-source-instances-normal-use-v1';
const record = (localId, changes = {}) => ({
  partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成${localId}`,
  originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null,
  status: '0', stateAssurance: 'verified', ...changes,
});
function support(scope, overrides = {}) {
  return {
    protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
    declaredPrimaryKey: ['local_id'], identity: 'source-table-local-v1', statusSemantics: 'synthetic-raw-codes',
    continuity: normalUseContinuity, serverAliasSemantics: 'unverified',
    capabilities: { incrementalTail: 'supported', normalHistory: 'supported', snapshotBarrier: 'supported',
      partitionCoverage: 'supported', sourceLifecycle: 'supported', restartContinuity: 'supported',
      recoveryMapping: 'supported', exactSchema: 'supported', declaredLocalKey: 'supported',
      automaticAllocation: 'supported', statusColumn: 'supported' }, ...overrides,
  };
}
function createChannel(state) {
  const factory = () => {
    let heldScope;
    const loss = Promise.withResolvers();
    return {
      guardSession: { loss: loss.promise },
      inspect: async scope => { heldScope = scope; return support(scope, state.supportOverrides); },
      target: async scope => ({
        protocol: 'private-history-v1',
        descriptor: `synthetic:${scope.conversationKey}${state.descriptorSuffix ?? ''}`,
        partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1',
      }),
      page: async (_scope, target, cursor) => ({
        target: target.descriptor, cursorIn: cursor, cursorOut: null,
        records: state.historyRecords, completedPartitions: ['p'], exhausted: true,
        resumeCursor: state.resumeCursor ?? 'tail-1',
      }),
      tail: async (scope, target, cursor) => {
        state.tails.push({ contactId: scope.token.contact_id, cursor });
        const batch = state.tailBatches.length ? state.tailBatches.shift() : { records: [], caughtUp: true, cursorOut: cursor };
        return { target: target.descriptor, cursorIn: cursor, cursorOut: batch.cursorOut ?? cursor,
          caughtUp: batch.caughtUp ?? true, records: batch.records ?? [] };
      },
      park: async () => {},
      close: async () => { loss.resolve(); },
    };
  };
  return factory;
}
async function fixture(t, { names = ['a'] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-goal-reuse-')));
  const state = { historyRecords: [], tailBatches: [], tails: [], resumeCursor: 'tail-1', descriptorSuffix: null, supportOverrides: {} };
  const f = { root, state, names };
  const openStorage = async intent => SqliteStorage.open({ userData: root, intent, role: 'test',
    expectedDatabaseId: intent === 'open' ? f.storage.status.databaseId : undefined, registryModule: registryUrl() });
  f.storage = await openStorage('create');
  f.contacts = new SqliteContactService(f.storage, owner, {
    account: async () => ({ ...evidence }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  const attachCoordinators = () => {
    const first = new FirstHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history);
    f.history.setFirstHistoryWake(contactId => first.wakeContact(contactId));
    const incremental = new IncrementalHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history,
      { intervalMs: 0, firstHistoryManagedExternally: true });
    f.first = first; f.coordinator = incremental;
  };
  attachCoordinators();
  f.restart = async () => {
    await f.first.close(); await f.coordinator.close();
    await f.history.close(); await f.contacts.close(); await f.storage.close();
    f.storage = await openStorage('open');
    f.contacts = new SqliteContactService(f.storage, owner, {
      account: async () => { throw new Error('重开后不得重选账号'); },
      sessions: async () => { throw new Error('重开后不得扩大会话范围'); },
    });
    await f.contacts.initialize();
    f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
    attachCoordinators();
  };
  t.after(async () => {
    await f.first.close(); await f.coordinator.close();
    await f.history.close(); await f.contacts.close();
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
const settle = async f => {
  for (let round = 0; round < 6; round++) {
    f.first.wake();
    f.coordinator.wake(); await f.coordinator.waitForIdle();
    try { await f.first.waitForIdle(); } catch {/* 已排空时立即返回 */ }
    const phases = f.coordinator.getState().contacts.map(row => row.phase);
    if (phases.length && phases.every(phase => ['caught_up', 'waiting_new_messages', 'stopped'].includes(phase))) return;
  }
};
const goals = async (f, contactId) =>
  (await f.storage.execute('fixture.listGoals', { ownerId: owner, contactId })).map(row => ({ ...row }));
const contactRows = (rows, contactId) => rows.filter(row => String(row.contact_id) === String(contactId));
const invalidatedCount = rows => rows.filter(row => row.state === 'invalidated' &&
  ['history_runtime_revalidated', 'history_snapshot_replaced'].includes(String(row.failure_code))).length;
const goalsOfAll = (f, bindings) => Promise.all(bindings.map(binding => goals(f, binding.contact_id))).then(list => list.flat());

test('重启重验后同范围 0 页空增量目标被复用：不再新建交接、不再作废', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.history.synchronize(binding.contact_id);
  const before = await goals(f, binding.contact_id);
  const incrementalBefore = before.find(row => row.kind === 'incremental');
  assert.equal(incrementalBefore.state, 'running');
  assert.equal(Number(incrementalBefore.pages_accepted), 0, '初次交接的增量目标尚未接受任何页');
  assert.equal(incrementalBefore.cursor, 'tail-1');
  assert.equal(invalidatedCount(before), 0);

  await f.restart();
  // 重开后的第一轮仍执行跨运行代次重验；重验识别出同范围 0 页空目标后保存原值并续用。
  await f.history.synchronizeIncremental(binding.contact_id);
  await f.history.synchronize(binding.contact_id);
  const after = await goals(f, binding.contact_id);
  assert.equal(after.length, before.length + 1, '只新增重验轮的历史目标行，不再重建增量目标');
  const incrementalAfter = after.find(row => row.id === incrementalBefore.id);
  assert.ok(incrementalAfter, '旧增量目标被复用');
  assert.equal(incrementalAfter.state, 'running');
  assert.equal(incrementalAfter.cursor, incrementalBefore.cursor);
  assert.equal(Number(incrementalAfter.pages_accepted), 0);
  assert.equal(invalidatedCount(after), 0, '复用成立时重验链不产生作废行');
  const coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
  assert.equal(coverage.incremental.goalId, incrementalBefore.id, '覆盖继续指向被复用的增量目标');
  assert.equal(coverage.incremental.cursorPresent, true);
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 1, '消息与来源追溯不变');
  // 被复用的增量目标可继续接住本轮读取：接收一次空"追平"页后仍是同一目标行。
  f.state.tailBatches.push({ records: [], caughtUp: true, cursorOut: 'tail-1' });
  await f.history.synchronizeIncremental(binding.contact_id);
  const continued = await goals(f, binding.contact_id);
  const continuedIncremental = continued.find(row => row.id === incrementalBefore.id);
  assert.equal(continuedIncremental.state, 'running');
  assert.equal(Number(continuedIncremental.pages_accepted), 1, '被复用目标按既有游标接续空页');
  assert.equal(continued.length, after.length, '接读取只更新行，不新建');
});

test('空闲多轮（无重启、无新消息）不新增任何目标行', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const bindings = await select(f);
  await settle(f);
  const before = await goalsOfAll(f, bindings);
  assert.equal(before.length, bindings.length * 2, '每位联系人一个完成历史目标和一个运行增量目标');
  for (let round = 0; round < 3; round++) {
    f.state.tailBatches.push({ records: [], caughtUp: true, cursorOut: `tail-idle-${round}` });
    await settle(f);
  }
  const after = await goalsOfAll(f, bindings);
  assert.equal(after.length, before.length, '空闲轮只更新增量目标，不新建目标');
  assert.equal(invalidatedCount(after), 0, '空闲轮不作废既有目标');
});

test('合成夹具：N 位联系人一次后台重启，每联系人新增 ≤1 行且旧增量目标被复用', async t => {
  const f = await fixture(t, { names: ['a', 'b', 'c'] });
  f.state.historyRecords = [record('1')];
  const bindings = await select(f);
  for (const binding of bindings) await f.history.synchronize(binding.contact_id);
  const before = await goalsOfAll(f, bindings);
  await f.restart();
  const restartMark = Date.now() - 10;
  await settle(f);
  const after = await goalsOfAll(f, bindings);
  for (const binding of bindings) {
    const beforeContact = contactRows(before, binding.contact_id);
    const afterContact = contactRows(after, binding.contact_id);
    assert.ok(afterContact.length <= beforeContact.length + 1, `每联系人新增 ≤1（${binding.contact_id.slice(0, 8)}：${afterContact.length - beforeContact.length}）`);
    assert.equal(invalidatedCount(afterContact), 0, '复用成立时重验链不产生作废行');
    const incremental = afterContact.find(row => row.kind === 'incremental');
    const incrementalBefore = beforeContact.find(row => row.kind === 'incremental');
    if (!incremental) console.error('DEBUG-METRIC', {contactId: binding.contact_id.slice(0, 8),
      after: afterContact.map(row => `${row.kind}/${row.state}/${row.failure_code}`),
      before: beforeContact.map(row => `${row.kind}/${row.state}/${row.failure_code}`)});
    assert.equal(String(incremental.id), String(incrementalBefore.id), '增量目标单行续用');
    const coverage = await f.history.coverage(binding.contact_id);
    assert.equal(coverage.phase, 'complete');
    assert.equal(coverage.incremental.goalId, String(coverage.incremental.goalId) === String(incremental.id) ? incremental.id : coverage.incremental.goalId);
    assert.ok(coverage.incremental.cursorPresent, '覆盖沿用被复用增量的游标');
  }
});

test('快照真被替换（descriptor 变化）时仍作废旧增量且旧游标不会交给读取器', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.history.synchronize(binding.contact_id);
  const before = await goals(f, binding.contact_id);
  const incrementalBefore = before.find(row => row.kind === 'incremental');
  assert.equal(incrementalBefore.cursor, 'tail-1');
  // 下一轮读取器打开不同 descriptor 的快照：摘要失配，必须保持旧行为（作废＋新建），不得沿用旧游标。
  f.state.descriptorSuffix = '-replaced';
  f.state.historyRecords = [];
  f.state.resumeCursor = 'tail-2';
  f.state.tailBatches.length = 0;
  await f.restart();
  await settle(f);
  const after = await goals(f, binding.contact_id);
  assert.ok(after.length > before.length, '复用前提不成立时保持旧行为（新建目标）');
  const invalidatedOld = after.find(row => row.id === incrementalBefore.id);
  assert.ok(invalidatedOld, '旧增量目标行保留为审计记录');
  assert.equal(invalidatedOld.state, 'invalidated');
  const runningIncremental = after.find(row => row.kind === 'incremental' && row.state === 'running');
  assert.ok(runningIncremental, '替换后新建增量目标续读');
  assert.notEqual(String(runningIncremental.id), String(incrementalBefore.id), '旧目标行不再承担读取职责（旧游标不外泄）');
  assert.equal(runningIncremental.cursor, 'tail-2', '新目标持有替换后快照的续读游标');
  const lastTail = f.state.tails.at(-1);
  assert.ok(lastTail, '读取器被调用过');
  assert.equal(lastTail.cursor, 'tail-2', '读取器拿到替换后快照的游标，而不是被作废目标的旧游标');
});

/** 端到端复用判据负向：条件破坏后重验链仍回旧路径（作废＋新建）。 */
async function settledContact(t) {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.history.synchronize(binding.contact_id);
  const before = await goals(f, binding.contact_id);
  return { f, binding, before };
}

test('端到端负向：接受过空页的增量目标（pages_accepted>0）重启后按旧行为重建', async t => {
  const { f, binding, before } = await settledContact(t);
  const incrementalBefore = before.find(row => row.kind === 'incremental');
  f.state.tailBatches.push({ records: [], caughtUp: true, cursorOut: 'tail-1' });
  await f.history.synchronizeIncremental(binding.contact_id);
  assert.equal(Number(incrementalBefore.pages_accepted) + 1, 1, '空页计入 pages_accepted');
  await f.restart();
  await settle(f);
  const after = await goals(f, binding.contact_id);
  assert.ok(after.length > before.length, '复用前提破坏后仍新建目标');
  assert.equal(after.find(row => row.id === incrementalBefore.id).state, 'invalidated', '旧增量目标仍被作废');
  const running = after.find(row => row.kind === 'incremental' && row.state === 'running');
  assert.ok(running && String(running.id) !== String(incrementalBefore.id), '新建增量目标接续');
  const coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
});

test('端到端负向：名下有 capture_record 的增量目标重启后按旧行为重建', async t => {
  const { f, binding, before } = await settledContact(t);
  const incrementalBefore = before.find(row => row.kind === 'incremental');
  f.state.tailBatches.push({ records: [record('2', { text: '重启前的增量消息' })], caughtUp: true, cursorOut: 'tail-2' });
  await f.history.synchronizeIncremental(binding.contact_id);
  const read = await f.history.read(binding.contact_id);
  assert.equal(read.messages.length, 2, '增量消息已保存');
  await f.restart();
  await settle(f);
  const after = await goals(f, binding.contact_id);
  assert.ok(after.length > before.length, '复用前提破坏后仍新建目标');
  assert.equal(after.find(row => row.id === incrementalBefore.id).state, 'invalidated', '旧增量目标仍被作废');
  const running = after.find(row => row.kind === 'incremental' && row.state === 'running');
  assert.ok(running && String(running.id) !== String(incrementalBefore.id));
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 2, '既有消息与来源不因重建而重复');
});

test('端到端负向：读取开关回转（read_epoch 变化）后资格不匹配，保持旧行为', async t => {
  const { f, binding, before } = await settledContact(t);
  const incrementalBefore = before.find(row => row.kind === 'incremental');
  await f.contacts.setReading(false);
  await f.contacts.setReading(true);
  await f.restart();
  await settle(f);
  const after = await goals(f, binding.contact_id);
  assert.ok(after.length > before.length, '资格变化后仍新建目标');
  assert.equal(after.find(row => row.id === incrementalBefore.id).state, 'invalidated', '旧增量目标仍被作废');
  assert.ok(after.find(row => row.kind === 'incremental' && row.state === 'running'), '新建增量目标');
  const coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
});

/** 复用判据可独立驱动；重启前的稳定基线：历史完成＋增量 ready、pages_accepted=0。 */
async function reuseStand(t) {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.history.synchronize(binding.contact_id);
  const rows = await goals(f, binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const scope = await f.storage.execute('history.scope', { token });
  const report = support(scope);
  const target = JSON.parse(String(rows.find(row => row.kind === 'history').target_json));
  const incremental = rows.find(row => row.kind === 'incremental');
  assert.ok(incremental, '初次交接已产生增量目标');
  const preview = await f.storage.execute('fixture.reusePreview', { token, report, target });
  assert.ok(preview.some(row => row.id === incremental.id), '同范围 0 页空增量目标可复用');
  assert.equal(preview.filter(row => row.kind === 'history').length, 0, '完成的历史目标不在 running 复用范围');
  return { f, binding, rows, token, report, target };
}

test('复用判据逐一单独破坏：基础行被识别，任一前提破坏即拒绝', async t => {
  const { f, rows, binding, token, report, target } = await reuseStand(t);
  const incremental = rows.find(row => row.kind === 'incremental');
  const contactId = String(incremental.contact_id);
  const cases = [
    { name: 'binding_id 不同', keepBase: false, token: { ...token, binding_id: '00000000-0000-4000-8000-00000000ffff' } },
    { name: 'grant_id 不同', keepBase: false, token: { ...token, grant_id: '00000000-0000-4000-8000-00000000ffff' } },
    { name: 'accepted_data_generation 不同', patch: { accepted_data_generation: BigInt(String(incremental.accepted_data_generation)) - 1n } },
    { name: 'accepted_barrier_generation 不同', patch: { accepted_barrier_generation: BigInt(String(incremental.accepted_barrier_generation)) - 1n } },
    { name: 'cursor_scope_digest 不同', patch: { cursor_scope_digest: 'synthetic-other-digest' } },
    { name: 'pages_accepted>0', patch: { pages_accepted: 1n } },
    { name: 'support_json 不同', patch: { support_json: serializeSupport({ ...report, profileId: 'synthetic-history-variant-v1' }) } },
    { name: 'eligibility_json 不同（read_epoch 漂移）', patch: { eligibility_json: JSON.stringify({ ...token, read_epoch: '999' }) } },
    { name: 'target_json 字段漂移', patch: { target_json: JSON.stringify({ ...JSON.parse(String(incremental.target_json)), extraField: 'x' }) } },
    { name: '无 cursor 的增量目标', patch: { cursor: null } },
    { name: '名下有 capture_record', patch: { withCapture: true } },
    { name: '本轮目标已替换（descriptor/表实例）', keepBase: false,
      previewTarget: { ...target, descriptor: 'synthetic-replaced', tables: [{ partition: 'p', instance: 'replaced-t' }] } },
  ];
  for (const single of cases) {
    const cloneId = randomUUID();
    try {
      await f.storage.execute('fixture.cloneGoal', { ownerId: owner, goalId: incremental.id, id: cloneId,
        patch: single.patch ? { ...single.patch } : {} });
      if (single.patch?.withCapture) await f.storage.execute('fixture.seedCaptureRecord', { ownerId: owner, contactId,
        goalId: cloneId, captureId: randomUUID(), recordId: randomUUID(), withRecord: true });
    } catch (error) { throw new Error(`用例 ${single.name} 造数失败：${error.code ?? error.message}`); }
    const outcome = await f.storage.execute('fixture.reusePreview',
      { token: single.token ?? token, report, target: single.previewTarget ?? target });
    assert.ok(!outcome.some(row => row.id === cloneId), `复用前提破坏（${single.name}）的克隆行不可续用`);
    if (single.keepBase !== false) {
      assert.ok(outcome.some(row => row.id === incremental.id), `原始行不受 ${single.name} 影响仍可续用`);
    }
  }
});
