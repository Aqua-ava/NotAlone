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

import { DatabaseSync } from 'node:sqlite';

const databaseFile = f => join(f.root, 'managed/sqlite/notalone.sqlite');
const DAY = 86_400_000;
/** 复制一条现有目标作为模板，生成指定状态与时间的合成目标，并附带若干空抓取页。 */
function seedGoals(f, templateGoalId, count, { state = 'invalidated', ageDays = 3, kind, capturesPerGoal = 2, markers = {} } = {}) {
  const db = new DatabaseSync(databaseFile(f));
  try {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('read_goal').map(c => c.name);
    const template = db.prepare('SELECT * FROM read_goal WHERE id=?').get(templateGoalId);
    let creationNo = Number(db.prepare('SELECT max(creation_no) m FROM read_goal').get().m);
    let acceptanceNo = Number(db.prepare('SELECT max(acceptance_no) m FROM sync_capture').get().m);
    const insertGoal = db.prepare(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    const insertCapture = db.prepare(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no)
      VALUES(?,?,?,?,1,'rt',1,'1','a','b','accepted','d',?)`);
    const ids = [];
    for (let n = 0; n < count; n++) {
      const row = { ...template, id: randomUUID(), state, kind: kind ?? template.kind, creation_no: ++creationNo,
        created_at: Date.now() - ageDays * DAY - n, failure_code: 'synthetic', handoff_from_goal_id: null, ...markers };
      insertGoal.run(...columns.map(c => row[c]));
      for (let c = 0; c < capturesPerGoal; c++) insertCapture.run(row.owner_id, randomUUID(), row.contact_id, row.id, ++acceptanceNo);
      ids.push(row.id);
    }
    return ids;
  } finally { db.close(); }
}
const count = (f, sql, ...args) => {
  const db = new DatabaseSync(databaseFile(f), { readOnly: true });
  try { return Number(db.prepare(sql).get(...args).n); } finally { db.close(); }
};
async function prepared(t) {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  await f.history.synchronize(binding.contact_id);
  const goalId = (await f.history.coverage(binding.contact_id)).incremental.goalId;
  assert.ok(goalId);
  return { f, binding, goalId };
}
const rerun = async ({ f, binding }) => { f.state.historyRecords = [record('1')]; await f.history.synchronize(binding.contact_id); };

test('创建新目标时顺带清理已作废、无记录、未被引用的旧目标，每次有界', async t => {
  const ctx = await prepared(t); const { f, goalId } = ctx;
  const total = () => count(f, 'SELECT COUNT(*) n FROM read_goal');
  const before = total();
  seedGoals(f, goalId, 120, { kind: 'incremental' });
  assert.equal(total(), before + 120);
  await f.history.restart?.();
  // 触发一次创建新目标：重新同步会开新的历史目标并调用清理。
  await f.contacts.setReading(false); await f.contacts.setReading(true);
  await rerun(ctx);
  const after1 = total();
  assert.ok(after1 < before + 120, '旧目标被清理');
  assert.ok(before + 120 - after1 <= 50 * 2, '每次创建最多清理一批（两个创建点各 50）');
  for (let i = 0; i < 4; i++) { await f.contacts.setReading(false); await f.contacts.setReading(true); await rerun(ctx); }
  assert.ok(count(f, "SELECT COUNT(*) n FROM read_goal WHERE failure_code='synthetic'") < 120);
});

test('保留：带记录的目标、未过宽限期、仍有效、被引用与最新一个都不被清理', async t => {
  const ctx = await prepared(t); const { f, goalId } = ctx;
  const stale = seedGoals(f, goalId, 4, { kind: 'incremental' }); // 先于其他目标创建，避免成为"最新"而受保护
  const fresh = seedGoals(f, goalId, 3, { kind: 'incremental', ageDays: 0 });
  const running = seedGoals(f, goalId, 3, { kind: 'history', state: 'running' }); // 仍有效的目标不清理（增量的 running 会在新建目标时被作废，属既有行为）
  const viaHandoff = seedGoals(f, goalId, 1, { kind: 'incremental' });
  const successor = seedGoals(f, goalId, 1, { kind: 'incremental', ageDays: 0, markers: { handoff_from_goal_id: viaHandoff[0] } });
  const withRecords = seedGoals(f, goalId, 2, { kind: 'incremental', capturesPerGoal: 1 });
  const db = new DatabaseSync(databaseFile(f));
  try {
    const capture = db.prepare('SELECT id,owner_id,contact_id FROM sync_capture WHERE goal_id=?').get(withRecords[0]);
    const source = db.prepare('SELECT * FROM capture_record LIMIT 1').get();
    const columns = Object.keys(source);
    db.prepare(`INSERT INTO capture_record(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
      .run(...columns.map(c => c === 'id' ? randomUUID() : c === 'capture_id' ? capture.id : c === 'item_no' ? 900 : source[c]));
  } catch (error) { db.close(); throw error; }
  db.close();
  await f.contacts.setReading(false); await f.contacts.setReading(true);
  await rerun(ctx);
  const alive = id => count(f, 'SELECT COUNT(*) n FROM read_goal WHERE id=?', id) === 1;
  assert.ok([...fresh, ...running, ...viaHandoff, ...successor, withRecords[0]].every(alive), '受保护的目标保留');
  assert.ok(alive(goalId), '当前增量目标保留');
  assert.ok(stale.every(id => !alive(id)), '无记录且未被引用的旧作废目标被清理');
  assert.equal(count(f, 'SELECT COUNT(*) n FROM sync_capture WHERE goal_id=?', withRecords[0]), 1, '带记录目标的抓取页保留');
  assert.equal((await f.history.read(ctx.binding.contact_id)).messages.length, 1, '消息与来源追溯不变');
});

test('共用读取器轮转产生的无进展目标：孤儿 running、被后继取代的空 complete 与被取代的空增量目标一小时后清理，仍需要的保留', async t => {
  const ctx = await prepared(t); const { f, goalId } = ctx;
  const history = { kind: 'history', ageDays: 0.1, markers: { cursor: null, failure_code: null } };
  const orphans = seedGoals(f, goalId, 3, { ...history, state: 'running', markers: { ...history.markers, resume_cursor: null } });
  const superseded = seedGoals(f, goalId, 3, { ...history, state: 'complete', markers: { ...history.markers, resume_cursor: 'tail-old' } });
  const replacedIncremental = seedGoals(f, goalId, 3, { kind: 'incremental', ageDays: 0.1, markers: { failure_code: 'history_snapshot_replaced', pages_accepted: 0 } });
  seedGoals(f, goalId, 1, { kind: 'incremental', ageDays: 0 }); // 同类型最新目标受保护，其余被取代的才可清理
  const recentOrphan = seedGoals(f, goalId, 1, { ...history, ageDays: 0, state: 'running', markers: { ...history.markers, resume_cursor: null } });
  // 最新的完成目标是续读检查点候选，必须保留；比它更新的 running 目标也仍然有效。
  const latestComplete = seedGoals(f, goalId, 1, { ...history, ageDays: 0.05, state: 'complete', markers: { ...history.markers, resume_cursor: 'tail-new' } });
  const newerRunning = seedGoals(f, goalId, 1, { ...history, ageDays: 0, state: 'running', markers: { ...history.markers, resume_cursor: null } });
  await f.contacts.setReading(false); await f.contacts.setReading(true);
  await rerun(ctx);
  const alive = id => count(f, 'SELECT COUNT(*) n FROM read_goal WHERE id=?', id) === 1;
  assert.ok(orphans.every(id => !alive(id)), '后继已完成的孤儿 running 目标被清理');
  assert.ok(superseded.every(id => !alive(id)), '被更新完成目标取代的空 complete 目标被清理');
  assert.ok(replacedIncremental.every(id => !alive(id)), '被新快照取代且无进展的增量目标一小时后清理');
  assert.ok(alive(latestComplete[0]), '没有更新完成目标的 complete 目标是检查点候选，保留');
  assert.ok(alive(newerRunning[0]) && alive(recentOrphan[0]), '一小时内的目标保留');
  assert.ok(alive(goalId), '当前增量目标保留');
  assert.equal((await f.history.read(ctx.binding.contact_id)).messages.length, 1, '消息与来源追溯不变');
});
