import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { registry as currentRegistry } from '../src/storage/sqlite/registry.ts';

const registryV12 = new URL('./fixtures/incremental/registry-v12.mjs', import.meta.url).href;
const currentVersion = Math.max(...currentRegistry.migrations.map(migration => migration.version));

test('既有 v12 数据库升级到含增量交接列的版本，重开幂等且完整性通过', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-incremental-migration-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test', registryModule: registryV12 });
  assert.equal(storage.status.schemaVersion, 12);
  const databaseId = storage.status.databaseId;
  await storage.close();
  storage = await SqliteStorage.open({ userData: root, intent: 'open', expectedDatabaseId: databaseId, role: 'test' });
  assert.equal(storage.status.schemaVersion, currentVersion, '打开既有库必须应用增量迁移');
  assert.deepEqual(await storage.check(), { integrity: 'ok', foreignKeys: 'ok' });
  await storage.close();
  storage = await SqliteStorage.open({ userData: root, intent: 'open', expectedDatabaseId: databaseId, role: 'test' });
  assert.equal(storage.status.schemaVersion, currentVersion, '重开不重复应用迁移');
  await storage.close();
});
