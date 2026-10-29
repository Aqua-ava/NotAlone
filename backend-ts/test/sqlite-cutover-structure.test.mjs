import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { EXPECTED_TABLES, FORBIDDEN_TABLES, DEFERRED_DESIGN_TABLES, REPLACED_DESIGN_TABLES } from '../src/platform/cutover/structure.ts';

const baseline = JSON.parse(await readFile(new URL('./fixtures/cutover/structure-baseline.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-cutover-structure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  const status = { ...storage.status, epoch: String(storage.status.epoch) };
  await storage.close();
  return { root, database: path.join(root, 'managed/sqlite/notalone.sqlite'), status };
}
function dumpTables(db) {
  const tables = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()) {
    tables[name] = {
      columns: db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all().map(c => ({ name: c.name, type: c.type, notnull: Number(c.notnull), pk: Number(c.pk) })),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all().map(f => ({ table: f.table, from: f.from, to: f.to })),
      indexes: db.prepare(`PRAGMA index_list(${JSON.stringify(name)})`).all().map(i => ({ name: i.name, unique: Number(i.unique), partial: Number(i.partial), origin: i.origin,
        columns: db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map(c => c.name) })),
      checks: 0, strict: true, triggers: [],
    };
  }
  return tables;
}

test('实际 DDL 与 77 表目录分类后的 82 表结构基线逐表一致', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const tables = dumpTables(db);
    for (const [name, expected] of Object.entries(baseline.tables)) {
      const actual = tables[name];
      assert.ok(actual, `缺少表 ${name}`);
      assert.deepEqual(actual.columns, expected.columns, `${name} 字段不一致`);
      assert.deepEqual(actual.foreignKeys.map(fk => JSON.stringify(fk)).sort(), expected.foreignKeys.map(fk => JSON.stringify(fk)).sort(), `${name} 外键不一致`);
      assert.deepEqual(actual.indexes.map(i => JSON.stringify(i)).sort(), expected.indexes.map(i => JSON.stringify(i)).sort(), `${name} 索引不一致`);
      assert.ok(expected.strict, `${name} 必须为 STRICT`);
    }
    assert.deepEqual(Object.keys(tables).sort(), EXPECTED_TABLES, '实际表集合必须等于实现表基线');
    const triggerRows = db.prepare("SELECT name,tbl_name AS tableName FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    assert.deepEqual(Object.fromEntries(triggerRows.map(row => [row.name, row.tableName])), baseline.triggers, '范围触发器集合与基线不一致');
    assert.equal(db.prepare('PRAGMA integrity_check').all()[0].integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('暂缓与替代表不建空表，逻辑目录 77 项分类闭合', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of [...FORBIDDEN_TABLES, ...DEFERRED_DESIGN_TABLES, ...REPLACED_DESIGN_TABLES]) assert.equal(names.has(name), false, `${name} 不应创建`);
  } finally { db.close(); }
});

test('迁移账本 1..15、结构版本与重开身份稳定', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const ledger = db.prepare('SELECT version FROM schema_migration ORDER BY version').all().map(row => Number(row.version));
    assert.deepEqual(ledger, Array.from({ length: 15 }, (_, index) => index + 1));
    assert.equal(Number(db.prepare('PRAGMA user_version').all()[0].user_version), 15);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM database_instance').all()[0].n), 1);
  } finally { db.close(); }
  const reopened = await SqliteStorage.open({ userData: f.root, intent: 'open', expectedDatabaseId: f.status.databaseId, role: 'test' });
  try {
    assert.equal(reopened.status.databaseId, f.status.databaseId);
    assert.equal(reopened.status.schemaVersion, 15);
    assert.deepEqual(await reopened.check(), { integrity: 'ok', foreignKeys: 'ok' });
    const snapshot = await reopened.execute('cutover.snapshot', { ownerId: await reopened.execute('identity.resolveOwner', { proposedOwnerId: '11111111-1111-4111-8111-111111111111', at: 1 }) });
    assert.deepEqual(snapshot.missingTables, []);
    assert.deepEqual(snapshot.unexpectedTables, []);
    assert.equal(snapshot.tables.length, 82);
    assert.deepEqual(snapshot.media, { message_media: 0, current_files: 0, staged_files: 0, cleanup_pending: 0, attempts_running: 0 });
    assert.deepEqual(snapshot.skills, { packages: 0, revisions: 0, enabled: 0, unknown: 0 });
  } finally { await reopened.close(); }
});

test('必要事务与约束：外键、CHECK、唯一键和范围触发器都在SQLite内拒绝非法写入', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.database, { enableForeignKeyConstraints: true });
  try {
    assert.throws(() => db.prepare("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key) VALUES('o','c','missing-account','wx','k')").run(), /FOREIGN KEY/);
    assert.throws(() => db.prepare("INSERT INTO database_instance VALUES(2,'id','notalone-sqlite-v1','test',1,'r',0,'')").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,normalizer_version,availability) VALUES('o','r','c','cap',1,'normalized','m','v1','available')").run(), /capture_record_binding_mismatch/);
    assert.throws(() => db.prepare("INSERT INTO memory_citation(owner_id,id,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end) VALUES('o','c','c','m','r',1,0,1)").run(), /memory_citation_required_mismatch/);
    db.exec('BEGIN');
    db.prepare("INSERT INTO owner(owner_id,created_at) VALUES('tx-owner',1)").run();
    db.exec('ROLLBACK');
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM owner WHERE owner_id='tx-owner'").all()[0].n), 0);
  } finally { db.close(); }
});
