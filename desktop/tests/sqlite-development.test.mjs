import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import {registry} from '../../backend-ts/src/storage/sqlite/registry.ts';
import {SqliteStorage} from '../../backend-ts/src/storage/sqlite/client.ts';

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-database-startup-')));
after(() => rm(directory, { recursive: true, force: true }));
const built = await build({ entryPoints: ['src/main/startup/sqlite-development.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'subject.mjs'), built.outputFiles[0].text);
const { SqliteDevelopmentProbe } = await import(path.join(directory, 'subject.mjs'));
const project = path.resolve('..');
const structureBaseline = JSON.parse(await readFile(path.join(project, 'backend-ts/test/fixtures/cutover/structure-baseline.json'), 'utf8'));

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
  assert.equal(created.schemaVersion, registry.migrations.at(-1).version);
  assert.deepEqual(created.capabilities, ['contacts', 'skills', 'history', 'discussions', 'memory']);
  const configuration = await readFile(path.join(f.userData, 'sqlite-development.json'), 'utf8');
  const parsed = JSON.parse(configuration);
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.intent, 'open');
  assert.equal(parsed.role, 'test');
  assert.equal(parsed.skillPackageRoot, path.join(project, 'reply-skills/romance'));
  await assert.rejects(access(path.join(f.userData, 'skill-packages')), { code: 'ENOENT' });
  assert.match(parsed.expectedDatabaseId, /^[a-zA-Z0-9_-]{1,128}$/);
  const contacts = probe.getContactConfiguration();
  assert.equal(contacts.expectedDatabaseId, parsed.expectedDatabaseId);
  const reopened = await new SqliteDevelopmentProbe(f.userData, project).run(() => true);
  assert.equal(reopened.phase, 'prepared');
  assert.equal(reopened.code, 'sqlite_prepared');
});

test('取消或非开发项目时不启动存储子进程', async t => {
  const f = await fixture('cancelled');
  t.after(f.cleanup);
  const cancelled = await new SqliteDevelopmentProbe(f.userData, project).run(() => false);
  assert.deepEqual(cancelled, { phase: 'blocked', code: 'sqlite_cancelled', maintenance: true });
  assert.equal(await exists(path.join(f.userData, 'managed/sqlite/notalone.sqlite')), false);
});

test('正常开发入口接受App数据目录外的Skill根，重开保留配置与数据库身份', async t => {
  const f = await fixture('external-skills');
  t.after(f.cleanup);
  const skillPackageRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-skill-originals-')));
  t.after(() => rm(skillPackageRoot, { recursive:true, force:true }));
  const initial = new SqliteDevelopmentProbe(f.userData, project);
  assert.equal((await initial.run(() => true)).phase, 'ready');
  const configurationPath = path.join(f.userData, 'sqlite-development.json');
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
  configuration.skillPackageRoot = skillPackageRoot;
  await writeFile(configurationPath, JSON.stringify(configuration));
  const reopened = new SqliteDevelopmentProbe(f.userData, project);
  assert.equal((await reopened.run(() => true)).phase, 'prepared');
  assert.equal(reopened.getContactConfiguration().expectedDatabaseId, configuration.expectedDatabaseId);
  assert.equal(reopened.getContactConfiguration().skillPackageRoot, skillPackageRoot);
  assert.equal(JSON.parse(await readFile(configurationPath, 'utf8')).skillPackageRoot, skillPackageRoot);
  await assert.rejects(access(path.join(f.userData, 'skill-packages')), { code: 'ENOENT' });
});


test('桌面预检传递既有本人身份且不使当前存储租约失效', async t => {
  const f=await fixture('preflight-lease');t.after(f.cleanup);
  const first=new SqliteDevelopmentProbe(f.userData,project);
  assert.equal((await first.run(()=>true)).phase,'ready');
  const config=first.getContactConfiguration();
  assert.match(config.expectedOwnerId,/^[a-zA-Z0-9_-]{1,128}$/);
  const storage=await SqliteStorage.open({userData:f.userData,intent:'open',role:'test',expectedDatabaseId:config.expectedDatabaseId});
  try {
    const second=new SqliteDevelopmentProbe(f.userData,project),prepared=await second.run(()=>true);
    assert.equal(prepared.phase,'prepared');assert.equal(prepared.schemaVersion,undefined);
    assert.equal(second.getContactConfiguration().expectedOwnerId,config.expectedOwnerId);
    assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
  } finally {await storage.close();}
});
