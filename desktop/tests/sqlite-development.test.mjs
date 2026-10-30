import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-database-startup-')));
after(() => rm(directory, { recursive: true, force: true }));
const built = await build({ entryPoints: ['src/main/startup/sqlite-development.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'subject.mjs'), built.outputFiles[0].text);
const { SqliteDevelopmentProbe } = await import(path.join(directory, 'subject.mjs'));
const project = path.resolve('..');

async function fixture(name) {
  const userData = await realpath(await mkdtemp(path.join(tmpdir(), `notalone-${name}-`)));
  return { userData, cleanup: () => rm(userData, { recursive: true, force: true }) };
}
async function exists(location) { try { await readFile(location); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

test('正常开发入口默认创建同一新SQLite实例，重开沿用 database_id', async t => {
  const f = await fixture('create');
  t.after(f.cleanup);
  const probe = new SqliteDevelopmentProbe(f.userData, project);
  const created = await probe.run(() => true);
  assert.equal(created.phase, 'ready');
  assert.equal(created.code, 'sqlite_ready');
  assert.equal(created.schemaVersion, 21);
  assert.deepEqual(created.capabilities, ['contacts', 'skills', 'history', 'discussions', 'memory']);
  const configuration = await readFile(path.join(f.userData, 'sqlite-development.json'), 'utf8');
  const parsed = JSON.parse(configuration);
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.intent, 'open');
  assert.equal(parsed.role, 'test');
  assert.match(parsed.expectedDatabaseId, /^[a-zA-Z0-9_-]{1,128}$/);
  const contacts = probe.getContactConfiguration();
  assert.equal(contacts.expectedDatabaseId, parsed.expectedDatabaseId);
  const reopened = await new SqliteDevelopmentProbe(f.userData, project).run(() => true);
  assert.equal(reopened.phase, 'ready');
  assert.equal(reopened.code, 'sqlite_reopened');
});

test('取消或非开发项目时不启动存储子进程', async t => {
  const f = await fixture('cancelled');
  t.after(f.cleanup);
  const cancelled = await new SqliteDevelopmentProbe(f.userData, project).run(() => false);
  assert.deepEqual(cancelled, { phase: 'blocked', code: 'sqlite_cancelled', maintenance: true });
  assert.equal(await exists(path.join(f.userData, 'managed/sqlite/notalone.sqlite')), false);
});
