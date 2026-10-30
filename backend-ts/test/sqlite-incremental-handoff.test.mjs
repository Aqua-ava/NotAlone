import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { assertHistoryReadBoundary } from '../src/history/sqlite/suppression.ts';

const owner = '00000000-0000-4000-8000-000000000086';
const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
const record = (localId, changes = {}) => ({
  partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成${localId}`,
  originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null, stateAssurance: 'verified', status: '0', ...changes,
});
function support(scope, overrides = {}) {
  return {
    protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
    declaredPrimaryKey: ['local_id'], identity: 'source-table-local-v1', statusSemantics: 'synthetic-raw-codes',
    continuity: 'synthetic-source-1', serverAliasSemantics: 'unverified', capabilities: { incrementalTail: 'supported' }, ...overrides,
  };
}
function createChannel(state) {
  return () => {
    state.creates++;
    return {
      inspect: async scope => support(scope, state.supportOverrides),
      target: async scope => {
        state.targetDescriptor = `synthetic:${scope.conversationKey}`;
        return { protocol: 'private-history-v1', descriptor: state.targetDescriptor, partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' };
      },
      page: async (_scope, target, cursor) => ({
        target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: ['p'], exhausted: true,
        records: state.historyRecords, ...(state.resumeCursor === null ? {} : { resumeCursor: state.resumeCursor }),
      }),
      close: async () => {},
    };
  };
}
async function fixture(t, names = ['a']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-incremental-handoff-')));
  const state = { creates: 0, supportOverrides: {}, historyRecords: [], resumeCursor: 'tail-1', targetDescriptor: null };
  const metadata = () => ({
    account: async () => ({ ...evidence }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  const f = { root, state };
  f.storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  f.contacts = new SqliteContactService(f.storage, owner, metadata());
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  t.after(async () => { await f.history.close(); await f.contacts.close(); await f.storage.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
async function select(f) {
  const candidate = await f.contacts.detectAccount();
  await f.contacts.confirmAccount(candidate.candidate_token);
  const snapshot = await f.contacts.candidates(true);
  await f.contacts.confirm(snapshot.snapshot_token, snapshot.sessions.map(row => ({ locator: row.username, observed_display_name: row.display_name, expected_selection_generation: row.selection_generation })));
  await f.contacts.setReading(true);
  return (await f.contacts.directory()).bindings[0];
}

test('历史终页在同一事务固定续读游标并原子创建增量目标', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  const coverage = await f.history.synchronize(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
  assert.equal(coverage.incremental.phase, 'ready', '终页续读游标交付后增量目标已就绪，不存在交接窗口');
  assert.equal(coverage.incremental.cursorPresent, true);
  assert.equal(coverage.incremental.pagesAccepted, 0);
  assert.ok(coverage.incremental.goalId);
  assert.ok(coverage.incremental.resumedFromGoalId, '增量目标记录交接来源');
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 1);
});

test('历史终页没有保守续读游标时增量显式不可用，不伪造交接', async t => {
  const f = await fixture(t);
  f.state.resumeCursor = null;
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  const coverage = await f.history.synchronize(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
  assert.equal(coverage.incremental.phase, 'unavailable');
  assert.equal(coverage.incremental.failureCode, 'history_incremental_unavailable');
  assert.equal(coverage.incremental.goalId, null);
  assert.equal(coverage.incremental.cursorPresent, false);
});

test('续读游标绑定完整作用域：支持档或账号变化后禁止沿用旧检查点', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  await f.history.synchronize(binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const scope = await f.storage.execute('history.scope', { token });
  const at = Date.now();
  const begin = (report, current = token) => f.storage.execute('history.beginIncremental', { token: current, report, id: randomUUID(), at });
  // 同一许可下的支持档变化：在任何读取恢复前由支持复验拦截。
  await assert.rejects(begin(support(scope, { build: '2' })), { code: 'history_support_changed' });
  // 关闭再开启产生新许可；旧检查点仍须与当前作用域证据一致才能续读。
  await f.contacts.setReading(false); await f.contacts.setReading(true);
  const refreshed = await f.contacts.eligibility(binding.contact_id);
  await assert.rejects(begin(support({ ...scope, token: refreshed }, { build: '2' }), refreshed), { code: 'history_cursor_scope_changed' });
  await assert.rejects(begin(support({ ...scope, token: refreshed }, { accountKey: 'other-account' }), refreshed), { code: 'history_cursor_scope_changed' });
  // 同一作用域但许可代次变化可以续读：由新目标承载，不复活旧目标。
  const resumed = await begin(support({ ...scope, token: refreshed }), refreshed);
  assert.equal(resumed.cursor, 'tail-1');
  const coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.incremental.pagesAccepted, 0);
  assert.notEqual(coverage.incremental.goalId, coverage.incremental.resumedFromGoalId);
});

test('同一响应重放幂等，不同响应用同一捕获id被拒绝', async t => {
  const f = await fixture(t);
  f.state.resumeCursor = null;
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  const token = await f.contacts.eligibility(binding.contact_id);
  const report = support({ token, accountKey: 'synthetic-account', conversationKey: 'friend-a' });
  const target = { protocol: 'private-history-v1', descriptor: 'synthetic:friend-a', partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' };
  await f.storage.execute('history.preflightContinuity', { token, target });
  const goal = await f.storage.execute('history.begin', { token, target, report, id: randomUUID(), at: Date.now() });
  const page = { target: target.descriptor, cursorIn: null, cursorOut: null, completedPartitions: ['p'], exhausted: true, records: [record('9')] };
  const captureId = randomUUID();
  const input = { token, goalId: goal.id, captureId, page, at: Date.now(), runtimeToken: f.storage.status.runtimeId };
  const first = await f.storage.execute('history.acceptPage', input);
  const replay = await f.storage.execute('history.acceptPage', input);
  assert.equal(replay.messageCount, first.messageCount);
  assert.equal(replay.pageCount, 1, '同一响应重放不新增捕获');
  await assert.rejects(f.storage.execute('history.acceptPage', { ...input, page: { ...page, records: [record('10')] } }), { code: 'history_capture_replay_conflict' });
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 1);
  // 关闭后目标不得再接受迟到页。
  await f.contacts.setReading(false);
  await assert.rejects(f.storage.execute('history.acceptPage', { ...input, captureId: randomUUID(), at: Date.now() + 1 }), error => error instanceof StorageFailure && error.code === 'read_not_authorized');
});

test('增量响应重放幂等：同捕获同页不重复推进，同捕获不同页被拒绝', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  await f.history.synchronize(binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const coverage = await f.history.coverage(binding.contact_id);
  const goalId = coverage.incremental.goalId;
  assert.ok(goalId);
  assert.equal(f.state.targetDescriptor, 'synthetic:friend-a');
  const page = { target: f.state.targetDescriptor, cursorIn: 'tail-1', cursorOut: 'tail-2', caughtUp: true, records: [record('2')] };
  const captureId = randomUUID();
  const input = { token, goalId, captureId, page, at: Date.now(), runtimeToken: f.storage.status.runtimeId };
  const first = await f.storage.execute('history.acceptIncrementalPage', input);
  const replay = await f.storage.execute('history.acceptIncrementalPage', input);
  assert.equal(first.incremental.pagesAccepted, 1);
  assert.equal(replay.incremental.pagesAccepted, 1, '同一响应重放不重复推进检查点');
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 2);
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { ...input, page: { ...page, records: [record('3')] } }), { code: 'history_capture_replay_conflict' });
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 2);
});

test('捕获回执绑定联系人和目标：同响应不可跨 goal 或联系人冒充幂等重放', async t => {
  const f = await fixture(t, ['a', 'b']);
  await select(f);
  const bindings = (await f.contacts.directory()).bindings;
  const [a, b] = bindings;
  const target = { protocol: 'private-history-v1', descriptor: 'synthetic:shared-target', partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' };
  const begin = async contactId => {
    const token = await f.contacts.eligibility(contactId);
    const scope = await f.storage.execute('history.scope', { token });
    const report = support(scope);
    await f.storage.execute('history.preflightContinuity', { token, target });
    const goal = await f.storage.execute('history.begin', { token, target, report, id: randomUUID(), at: Date.now() });
    return { token, report, goal };
  };
  const first = await begin(a.contact_id);
  const captureId = randomUUID();
  const page = { target: target.descriptor, cursorIn: null, cursorOut: null, completedPartitions: ['p'], exhausted: true, records: [record('shared')] };
  const firstInput = { token: first.token, goalId: first.goal.id, captureId, page, at: Date.now(), runtimeToken: f.storage.status.runtimeId };
  await f.storage.execute('history.acceptPage', firstInput);
  await f.storage.execute('history.acceptPage', firstInput);

  const secondGoal = await begin(a.contact_id);
  await assert.rejects(f.storage.execute('history.acceptPage', { ...firstInput, token: secondGoal.token, goalId: secondGoal.goal.id }), { code: 'history_capture_replay_conflict' });

  const otherContact = await begin(b.contact_id);
  await assert.rejects(f.storage.execute('history.acceptPage', { ...firstInput, token: otherContact.token, goalId: otherContact.goal.id }), { code: 'history_capture_replay_conflict' });
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', firstInput), { code: 'history_goal_kind_invalid' });
});

test('增量捕获回执不能通过历史接口重放', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  await f.history.synchronize(binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const incremental = await f.history.coverage(binding.contact_id);
  assert.ok(incremental.incremental.goalId);
  const page = { target: f.state.targetDescriptor, cursorIn: 'tail-1', cursorOut: 'tail-2', caughtUp: true, records: [record('2')] };
  const captureId = randomUUID();
  const input = { token, goalId: incremental.incremental.goalId, captureId, page, at: Date.now(), runtimeToken: f.storage.status.runtimeId };
  await f.storage.execute('history.acceptIncrementalPage', input);
  await assert.rejects(f.storage.execute('history.acceptPage', input), { code: 'history_goal_kind_invalid' });
});

test('增量捕获回执绑定联系人和目标：不能跨新目标或联系人跳过写入', async t => {
  const f = await fixture(t, ['a', 'b']);
  const a = await select(f);
  const b = (await f.contacts.directory()).bindings.find(binding => binding.contact_id !== a.contact_id);
  assert.ok(b);
  f.state.historyRecords = [record('1')];
  await f.history.synchronize(a.contact_id);
  await f.history.synchronize(b.contact_id);
  const firstToken = await f.contacts.eligibility(a.contact_id);
  const firstCoverage = await f.history.coverage(a.contact_id);
  const firstGoalId = firstCoverage.incremental.goalId;
  assert.ok(firstGoalId, JSON.stringify(firstCoverage));
  const firstScope = await f.storage.execute('history.scope', { token: firstToken });
  const firstPage = { target: `synthetic:${firstScope.conversationKey}`, cursorIn: 'tail-1', cursorOut: 'tail-2', caughtUp: true, records: [record('incremental-shared')] };
  const captureId = randomUUID();
  const firstInput = { token: firstToken, goalId: firstGoalId, captureId, page: firstPage, at: Date.now(), runtimeToken: f.storage.status.runtimeId };
  await f.storage.execute('history.acceptIncrementalPage', firstInput);

  await f.contacts.setReading(false); await f.contacts.setReading(true);
  const beginNewGoal = async contactId => {
    const token = await f.contacts.eligibility(contactId);
    const scope = await f.storage.execute('history.scope', { token });
    const goal = await f.storage.execute('history.beginIncremental', { token, report: support(scope), id: randomUUID(), at: Date.now() });
    return { token, goal };
  };
  const newGoalA = await beginNewGoal(a.contact_id);
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { ...firstInput, token: newGoalA.token, goalId: newGoalA.goal.id }), { code: 'history_capture_replay_conflict' });

  const newGoalB = await beginNewGoal(b.contact_id);
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { ...firstInput, token: newGoalB.token, goalId: newGoalB.goal.id }), { code: 'history_capture_replay_conflict' });
});

test('增量页的旧 cursor_in 无法覆盖已提交检查点', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  await f.history.synchronize(binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const goalId = (await f.history.coverage(binding.contact_id)).incremental.goalId;
  const stale = { target: f.state.targetDescriptor, cursorIn: 'tail-before-checkpoint', cursorOut: 'tail-stale', caughtUp: true, records: [record('2')] };
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { token, goalId, captureId: randomUUID(), page: stale, at: Date.now(), runtimeToken: f.storage.status.runtimeId }), { code: 'history_page_invalid' });
  const coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.incremental.pagesAccepted, 0);
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 1);
});

test('清空代次与删除围栏下读取边界保持拒绝，不因重试放开', () => {
  const base = { owner_id: 'owner', contact_id: 'contact', barrier_generation: '0' };
  assert.doesNotThrow(() => assertHistoryReadBoundary({ get: () => undefined }, base, { kind: 'incremental' }));
  assert.throws(() => assertHistoryReadBoundary({ get: () => undefined }, { ...base, barrier_generation: '1' }, { kind: 'history' }), { code: 'history_suppression_unverified' });
  assert.throws(() => assertHistoryReadBoundary({ get: () => ({ 1: 1 }) }, base, { kind: 'incremental' }), { code: 'history_suppression_unverified' });
});
