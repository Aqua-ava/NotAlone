import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { registry as currentRegistry } from '../src/storage/sqlite/registry.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';

const request = (key, sourceId) => ({ ownerId: 'o', requestKey: key, scope: { kind: 'source', contactId: 'a', sourceId } });
const registryModule = name => new URL(`./fixtures/sqlite/${name}`, import.meta.url).href;

async function open(userData, options) {
  return SqliteStorage.open({ userData, role: 'test', ...options });
}

test('完成操作同事务收敛台账：逐行清零、摘要条数与删除前一致、未完成操作原样保留', async t => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'notalone-deletion-ledger-prune-')));
  const moduleUrl = registryModule('deletion-registry.mjs');
  let storage = await open(userData, { intent: 'create', registryModule: moduleUrl });
  const holders = new ActiveHolders();
  const service = () => new DeletionService(storage, holders, new ManagedFiles(userData));
  t.after(async () => { await storage.close(); await rm(userData, { recursive: true, force: true }); });
  await storage.execute('sample.seed', {});
  // 第二个操作保持未完成（fenced），它的逐行记录不得被第一个操作的完成清理波及。
  await storage.execute('sample.refill', {});
  const done = await service().plan(request('delete-1', 'r1'));
  assert.equal(done.targets.length, 2);
  const pending = await service().plan(request('delete-2', 'r3'));
  assert.equal(pending.targets.length, 1);

  const finished = await service().advance({ ownerId: 'o', operationId: done.operationId });
  assert.equal(finished.state, 'completed');
  // 完成后快照不再带逐行目标，只带操作级摘要。
  assert.equal(finished.targets.length, 0);
  assert.deepEqual(JSON.parse(finished.targetSummary), { 'sample:sample_body': 2 });

  const database = join(userData, 'managed/sqlite/notalone.sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM deletion_target WHERE operation_id=?').get(done.operationId).n, 0);
    const summary = db.prepare('SELECT target_summary s FROM deletion_operation WHERE operation_id=?').get(done.operationId).s;
    assert.deepEqual(JSON.parse(summary), { 'sample:sample_body': 2 });
    // 摘要条数与删除前逐行记录一致（2 条），且不含任何行键。
    assert.equal(Object.values(JSON.parse(summary)).reduce((sum, n) => sum + n, 0), 2);
    assert.match(summary, /sample_body/); assert.doesNotMatch(summary, /owner_id|m1|cross/);
    // 未完成操作：逐行记录与摘要空缺原样保留。
    assert.equal(db.prepare('SELECT count(*) n FROM deletion_target WHERE operation_id=?').get(pending.operationId).n, 1);
    assert.equal(db.prepare('SELECT target_summary s FROM deletion_operation WHERE operation_id=?').get(pending.operationId).s, null);
  } finally { db.close(); }
  const status = await service().status({ ownerId: 'o', operationId: pending.operationId });
  assert.equal(status.targets.length, 1);
  assert.equal(status.targetSummary, null);
  // 幂等重入 completed 操作不再重建逐行记录。
  assert.equal((await service().advance({ ownerId: 'o', operationId: done.operationId })).state, 'completed');
  const db2 = new DatabaseSync(database, { readOnly: true });
  try { assert.equal(db2.prepare('SELECT count(*) n FROM deletion_target WHERE operation_id=?').get(done.operationId).n, 0); } finally { db2.close(); }
});

test('48迁移为存量已完成操作补摘要并清逐行记录，未完成操作不受影响', async t => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'notalone-deletion-ledger-prune-migrate-')));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const legacyModule = registryModule('deletion-ledger-prune-legacy-registry.mjs');
  let storage = await open(userData, { intent: 'create', registryModule: legacyModule });
  assert.equal(storage.status.schemaVersion, 47, '存量种子固定在尚未精简台账的历史结构');
  await storage.execute('fixture.legacyLedger', {});
  const databaseId = storage.status.databaseId;
  await storage.close();
  const database = join(userData, 'managed/sqlite/notalone.sqlite');
  const before = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(before.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='done-1'").get().n, 4);
    assert.equal(before.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='stuck-1'").get().n, 2);
    assert.equal(before.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='failed-1'").get().n, 1);
    // 47 版库尚无 target_summary 列，逐行记录在完成后全部保留。
  } finally { before.close(); }

  storage = await open(userData, { intent: 'open', expectedDatabaseId: databaseId, registryModule: registryModule('deletion-registry.mjs') });
  t.after(() => storage.close());
  assert.equal(storage.status.schemaVersion, currentRegistry.migrations.at(-1).version + 1); // 当前注册表 + 夹具 sample 迁移
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='done-1'").get().n, 0);
    const summary = db.prepare("SELECT target_summary s FROM deletion_operation WHERE operation_id='done-1'").get().s;
    // 摘要条数与迁移前逐行记录一致：2 message + 1 capture_record + 1 file。
    assert.deepEqual(JSON.parse(summary), { 'history:message': 2, 'history:capture_record': 1, 'discussion:file': 1 });
    // 未完成操作原样保留，摘要仍为空。
    assert.equal(db.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='stuck-1'").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='failed-1'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id IN ('stuck-1','failed-1') AND state='pending'").get().n, 2);
    for (const op of ['stuck-1', 'failed-1']) assert.equal(db.prepare('SELECT target_summary s FROM deletion_operation WHERE operation_id=?').get(op).s, null);
  } finally { db.close(); }
});
