/** 结构基线生成器：从全部已登记迁移的真实隔离实例导出可复现的 SQLite 结构快照。
 *
 * 用法（backend-ts 目录）：
 *   node test/fixtures/cutover/build-structure-baseline.mjs
 * 只写入同目录 structure-baseline.json，不删除或复用任何用户数据库。
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../../../src/storage/sqlite/client.ts';

export const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
export function dumpSchema(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()) {
      tables[name] = {
        columns: db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all().map(c => ({ name: c.name, type: c.type, notnull: Number(c.notnull), dflt_value: c.dflt_value ?? null, pk: Number(c.pk) })),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all().map(f => ({ id: Number(f.id), seq: Number(f.seq), table: f.table, from: f.from, to: f.to, on_update: f.on_update, on_delete: f.on_delete, match: f.match })),
        indexes: db.prepare(`PRAGMA index_list(${JSON.stringify(name)})`).all().map(i => ({
          name: i.name, unique: Number(i.unique), partial: Number(i.partial), origin: i.origin,
          columns: db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map(c => c.name),
          sql: db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").all(i.name)[0]?.sql ?? null,
        })),
        sql: normalizeSql(db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').all(name)[0]?.sql ?? ''),
      };
    }
    const triggers = db.prepare("SELECT name,tbl_name AS tableName,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()
      .map(row => ({ name: row.name, table: row.tableName, sql: normalizeSql(row.sql) }));
    const views = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name").all()
      .map(row => ({ name: row.name, sql: normalizeSql(row.sql) }));
    const ledger = db.prepare('SELECT version FROM schema_migration ORDER BY version').all().map(row => Number(row.version));
    const checks = Object.values(tables).reduce((sum, table) => sum + (table.sql.match(/CHECK\s*\(/g) ?? []).length, 0);
    return {
      metadata: {
        schemaVersion: ledger.length, migrationVersions: ledger,
        userVersion: Number(db.prepare('PRAGMA user_version').all()[0].user_version),
        sqliteVersion: db.prepare('SELECT sqlite_version() AS v').all()[0].v,
        tableCount: Object.keys(tables).length,
        fieldCount: Object.values(tables).reduce((sum, table) => sum + table.columns.length, 0),
        foreignKeyGroups: Object.values(tables).reduce((sum, table) => sum + new Set(table.foreignKeys.map(fk => fk.id)).size, 0),
        triggerCount: triggers.length, checkCount: checks, viewCount: views.length,
      },
      tables, triggers, views,
    };
  } finally { db.close(); }
}

async function main() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-structure-baseline-')));
  try {
    const storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
    await storage.close();
    const fixture = dumpSchema(path.join(root, 'managed/sqlite/notalone.sqlite'));
    await writeFile(path.join(directory, 'structure-baseline.json'), `${JSON.stringify(fixture, null, 1)}\n`);
    console.log(JSON.stringify(fixture.metadata));
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
export const readBaseline = async () => JSON.parse(await readFile(new URL('./structure-baseline.json', import.meta.url), 'utf8'));
