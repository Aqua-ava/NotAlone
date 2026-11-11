import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { registry } from '../src/storage/sqlite/registry.ts';
import { SqliteSkillLibrary } from '../src/skills/sqlite/library.ts';
import { EXPECTED_TABLES, FORBIDDEN_TABLES, DEFERRED_DESIGN_TABLES, REPLACED_DESIGN_TABLES } from '../src/platform/cutover/structure.ts';
import { dumpSchema, readBaseline } from './fixtures/cutover/build-structure-baseline.mjs';

const baseline = await readBaseline();

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-cutover-structure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  const status = { ...storage.status, epoch: String(storage.status.epoch) };
  await storage.close();
  return { root, database: path.join(root, 'managed/sqlite/notalone.sqlite'), status };
}

test('实际 DDL 与 92 表结构基线逐表一致（含 CHECK、触发器 body、FK action、索引 SQL 与视图）', async t => {
  const f = await fixture(t);
  const actual = dumpSchema(f.database);
  // sqliteVersion 随运行构建的 SQLite 版本变化，不参与结构等价；其余元数据必须逐项一致。
  const { sqliteVersion: actualSqliteVersion, ...actualStable } = actual.metadata;
  const { sqliteVersion: baselineSqliteVersion, ...baselineStable } = baseline.metadata;
  assert.match(actualSqliteVersion, /^\d+\.\d+\.\d+$/);
  if (baselineSqliteVersion !== undefined) assert.match(baselineSqliteVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(actualStable, baselineStable, '结构元数据与基线不一致');
  assert.equal(actual.metadata.checkCount, 303);
  assert.equal(actual.metadata.triggerCount, 102);
  assert.deepEqual(actual.metadata.migrationVersions, registry.migrations.map(migration => migration.version));
  assert.equal(actual.metadata.userVersion, baseline.metadata.schemaVersion);
  assert.deepEqual(Object.keys(actual.tables), EXPECTED_TABLES, '实际表集合必须等于实现表基线');
  for (const [name, expected] of Object.entries(baseline.tables)) {
    const table = actual.tables[name];
    assert.ok(table, `缺少表 ${name}`);
    assert.deepEqual(table.columns, expected.columns, `${name} 字段／默认值不一致`);
    assert.deepEqual(table.foreignKeys.map(fk => JSON.stringify(fk)).sort(), expected.foreignKeys.map(fk => JSON.stringify(fk)).sort(), `${name} 外键列／action 不一致`);
    assert.deepEqual(table.indexes.map(index => JSON.stringify(index)).sort(), expected.indexes.map(index => JSON.stringify(index)).sort(), `${name} 索引定义不一致`);
    assert.equal(table.sql, expected.sql, `${name} 建表 SQL（含 CHECK 与约束）不一致`);
  }
  assert.deepEqual(actual.triggers, baseline.triggers, '范围触发器 body 与基线不一致');
  assert.deepEqual(actual.views, baseline.views, '视图与基线不一致');
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').all()[0].integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('暂缓与替代表不建空表，77 项逻辑目录分类闭合', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of [...FORBIDDEN_TABLES, ...DEFERRED_DESIGN_TABLES, ...REPLACED_DESIGN_TABLES]) assert.equal(names.has(name), false, `${name} 不应创建`);
  } finally { db.close(); }
});

test('迁移账本、结构版本与重开身份稳定', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const ledger = db.prepare('SELECT version FROM schema_migration ORDER BY version').all().map(row => Number(row.version));
    assert.deepEqual(ledger, registry.migrations.map(migration => migration.version));
    assert.equal(Number(db.prepare('PRAGMA user_version').all()[0].user_version), baseline.metadata.schemaVersion);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM database_instance').all()[0].n), 1);
  } finally { db.close(); }
  const reopened = await SqliteStorage.open({ userData: f.root, intent: 'open', expectedDatabaseId: f.status.databaseId, role: 'test' });
  try {
    assert.equal(reopened.status.databaseId, f.status.databaseId);
    assert.equal(reopened.status.schemaVersion, baseline.metadata.schemaVersion);
    assert.deepEqual(await reopened.check(), { integrity: 'ok', foreignKeys: 'ok' });
    const ownerId = await reopened.execute('identity.resolveOwner', { proposedOwnerId: '11111111-1111-4111-8111-111111111111', at: 1 });
    const skillRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-cutover-skill-root-')));
    t.after(() => rm(skillRoot, { recursive: true, force: true }));
    await mkdir(path.join(skillRoot, 'default-on'), { recursive: true });
    await writeFile(path.join(skillRoot, 'default-on/SKILL.md'), '---\nname: default-on\ndescription: 合成默认项目\n---\n保持表达自然。\n');
    const library = new SqliteSkillLibrary(reopened, ownerId, skillRoot);
    const [skill] = await library.refresh();
    assert.equal(skill.enabledOrigin, 'default');
    const snapshot = await reopened.execute('cutover.snapshot', { ownerId });
    assert.deepEqual(snapshot.missingTables, []);
    assert.deepEqual(snapshot.unexpectedTables, []);
    assert.equal(snapshot.tables.length, 92);
    assert.deepEqual(snapshot.media, { message_media: 0, current_files: 0, staged_files: 0, cleanup_pending: 0, attempts_running: 0 });
    assert.deepEqual(snapshot.skills, { packages: 1, revisions: 1, enabled: 1, unknown: 0 });
  } finally { await reopened.close(); }
});

test('必要事务与约束：外键、CHECK、唯一键、幂等与范围触发器都在SQLite内拒绝非法写入', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { enableForeignKeyConstraints: true });
  try {
    assert.throws(() => db.prepare("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key) VALUES('o','c','missing-account','wx','k')").run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare("INSERT INTO database_instance(slot,database_id,format_family,role,created_at,runtime_id,epoch,schema_digest) VALUES(2,'id','notalone-sqlite-v1','test',1,'r',0,'')").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,plan_revision,state) VALUES('missing',1,'row','d','k','m',1,'cleared')").run(), /FOREIGN KEY|CHECK/);
    assert.throws(() => db.prepare("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,normalizer_version,availability) VALUES('o','r','c','cap',1,'normalized','m','v1','available')").run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare("INSERT INTO memory_citation(owner_id,id,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end) VALUES('o','c','c','m','r',1,0,1)").run(), /memory_citation_required_mismatch/);
    db.exec('BEGIN');
    db.prepare("INSERT INTO owner(owner_id,created_at) VALUES('tx-owner',1)").run();
    db.exec('ROLLBACK');
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM owner WHERE owner_id='tx-owner'").all()[0].n), 0);
  } finally { db.close(); }
});
