import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { runDefaultDatabaseStartup } from '../src/platform/cutover/startup.ts';
import { inspectCutover, BUSINESS_TARGETS } from '../src/platform/cutover/startup.ts';
import { discoverLegacyTargets } from '../src/platform/cutover/targets.ts';
import { authorizationPath, cutoverDirectory, manifestPath, startupConfigPath } from '../src/platform/cutover/control.ts';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-cutover-rehearsal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function directory(location) { await mkdir(location, { recursive: true, mode: 0o700 }); }
async function file(location, content) { await mkdir(path.dirname(location), { recursive: true, mode: 0o700 }); await writeFile(location, content, { mode: 0o600 }); }
async function exists(location) { try { await lstat(location); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function legacyLayout(root, { writerPid } = {}) {
  await directory(path.join(root, 'managed/postgres/base'));
  await directory(path.join(root, 'managed/postgres/global'));
  await file(path.join(root, 'managed/postgres/PG_VERSION'), '16\n');
  await file(path.join(root, 'managed/state.json'), JSON.stringify({ formatVersion: 1, password: 'a'.repeat(64), bootstrapComplete: true }) + '\n');
  await file(path.join(root, 'managed/runtime.env'), 'NOTALONE_DATABASE_URL=postgresql://notalone:secret@127.0.0.1:5432/notalone\nNOTALONE_DEEPSEEK_API_KEY=synthetic-model-key\n');
  const archive = path.join(root, 'managed/updates', randomUUID());
  await directory(archive);
  await file(path.join(archive, 'database.dump'), 'synthetic-old-pg-dump');
  await file(path.join(archive, 'checkpoint.json'), '{"format_version":1}\n');
  const owner = randomUUID(), contact = randomUUID(), session = randomUUID();
  await directory(path.join(root, 'assistant-runtime', owner, contact, session));
  await file(path.join(root, 'assistant-runtime', owner, contact, session, 'session.json'), '{"synthetic":"session"}\n');
  await file(path.join(root, 'skill-packages/existing-skill/SKILL.md'), '# synthetic skill\n');
  await file(path.join(root, 'originals/wechat-photo.jpg'), 'external-original');
  await file(path.join(root, 'managed/import-pending.json'), '{"formatVersion":1,"verified":true}\n');
  if (writerPid) await file(path.join(root, 'managed/backend.info'), `address=127.0.0.1:1\ntoken=synthetic\npid=${writerPid}\n`);
  return { owner, contact, session, archive };
}
async function authorizeBusinessTargets(root) {
  const targets = discoverLegacyTargets(root).filter(target => BUSINESS_TARGETS.includes(target.kind));
  assert.ok(targets.length > 0, '合成旧目标必须被识别');
  await directory(cutoverDirectory(root));
  await file(authorizationPath(root), JSON.stringify({ formatVersion: 1, approvedAt: 1, scope: 'synthetic',
    targets: targets.map(target => ({ id: target.id, disposition: 'clean' })) }) + '\n');
  await chmod(cutoverDirectory(root), 0o700);
  return targets;
}
async function openStorage(root) { return SqliteStorage.open({ userData: root, intent: 'open', expectedDatabaseId: JSON.parse(await readFile(startupConfigPath(root), 'utf8')).expectedDatabaseId, role: 'test' }); }

test('空隔离根默认创建同一新SQLite实例，重开沿用 database_id 与 owner', async t => {
  const root = await fixture(t);
  const first = await runDefaultDatabaseStartup({ userData: root, now: () => 1000 });
  assert.equal(first.phase, 'ready');
  assert.equal(first.code, 'sqlite_ready');
  assert.equal(first.created, true);
  assert.equal(first.schemaVersion, 16);
  assert.deepEqual(first.configuration.capabilities, ['contacts', 'skills', 'history', 'discussions', 'memory']);
  const config = JSON.parse(await readFile(startupConfigPath(root), 'utf8'));
  assert.equal(config.expectedDatabaseId, first.databaseId);
  assert.equal((await lstat(startupConfigPath(root))).mode & 0o777, 0o600);
  assert.equal((await lstat(cutoverDirectory(root))).mode & 0o777, 0o700);
  const second = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(second.phase, 'ready');
  assert.equal(second.code, 'sqlite_reopened');
  assert.equal(second.databaseId, first.databaseId);
  assert.equal(second.ownerId, first.ownerId);
  const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'));
  assert.equal(manifest.phase, 'completed');
  assert.equal(manifest.target.databaseId, first.databaseId);
  assert.ok(manifest.checks.every(check => check.state === 'passed'));
});

test('遗产业务目标未授权时保持维护态，不清理、不建新库、不写启动配置', async t => {
  const root = await fixture(t);
  const layout = await legacyLayout(root);
  const result = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(result.phase, 'maintenance');
  assert.equal(result.code, 'cutover_authorization_required');
  assert.equal(await exists(path.join(root, 'managed/sqlite/notalone.sqlite')), false);
  assert.equal(await exists(startupConfigPath(root)), false);
  assert.equal(await exists(path.join(root, 'managed/postgres/PG_VERSION')), true);
  assert.equal(await exists(path.join(layout.archive, 'database.dump')), true);
  assert.equal(await exists(path.join(root, 'assistant-runtime', layout.owner, layout.contact, layout.session)), true);
  const manifest = inspectCutover(root).manifest;
  assert.equal(manifest.phase, 'blocked');
  assert.ok(manifest.legacyTargets.some(target => target.kind === 'legacy_pg_cluster' && target.state === 'pending'));
});

test('无法证明归属的旧目标阻断切换，且不被删除', async t => {
  const root = await fixture(t);
  await directory(path.join(root, 'managed/updates'));
  await file(path.join(root, 'managed/updates/unexpected.bin'), 'unknown-bytes');
  const result = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(result.phase, 'maintenance');
  assert.equal(result.code, 'cutover_legacy_target_unclassified');
  assert.equal(await exists(path.join(root, 'managed/updates/unexpected.bin')), true);
  assert.equal(await exists(startupConfigPath(root)), false);
});

test('旧写入者仍存活时阻断；停写并授权后完成清理、保留模型密钥/Skill/外部原件并切配置', async t => {
  const root = await fixture(t);
  const writer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
  t.after(() => { try { writer.kill('SIGKILL'); } catch { /* 已退出。 */ } });
  const layout = await legacyLayout(root, { writerPid: writer.pid });
  const running = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(running.phase, 'maintenance');
  assert.equal(running.code, 'cutover_legacy_writer_running');
  assert.equal(await exists(path.join(root, 'managed/postgres/PG_VERSION')), true);
  writer.kill('SIGTERM');
  await new Promise(resolve => writer.once('exit', resolve));
  await authorizeBusinessTargets(root);
  const result = await runDefaultDatabaseStartup({ userData: root, allowSyntheticAuthorization: true });
  assert.equal(result.phase, 'ready', JSON.stringify(result));
  assert.equal(result.created, true);
  // 旧业务对象按已确认范围清理；控制面本身保留。
  assert.equal(await exists(path.join(root, 'managed/postgres')), false);
  assert.equal(await exists(path.join(root, 'managed/state.json')), false);
  assert.equal(await exists(path.join(layout.archive, 'database.dump')), false);
  assert.equal(await exists(path.join(root, 'assistant-runtime')), false);
  assert.equal(await exists(path.join(root, 'managed/import-pending.json')), false);
  // 模型密钥保留；旧数据库连接与密码行去掉。
  const environment = await readFile(path.join(root, 'managed/runtime.env'), 'utf8');
  assert.match(environment, /NOTALONE_DEEPSEEK_API_KEY=synthetic-model-key/);
  assert.doesNotMatch(environment, /NOTALONE_DATABASE_URL/);
  // 用户 Skill 原目录与微信外部原件保留，空库不触发孤儿删除或默认停用。
  assert.equal(await readFile(path.join(root, 'skill-packages/existing-skill/SKILL.md'), 'utf8'), '# synthetic skill\n');
  assert.equal(await readFile(path.join(root, 'originals/wechat-photo.jpg'), 'utf8'), 'external-original');
  const manifest = inspectCutover(root).manifest;
  assert.equal(manifest.phase, 'completed');
  assert.ok(manifest.checks.find(check => check.name === 'skill_empty_safe')?.state === 'passed');
  assert.ok(manifest.writerChecks.every(check => check.state === 'stopped'));
  const storage = await openStorage(root);
  try {
    const ownerId = await storage.execute('identity.resolveOwner', { proposedOwnerId: randomUUID(), at: 1 });
    const snapshot = await storage.execute('cutover.snapshot', { ownerId });
    assert.equal(snapshot.skills.packages, 0);
    assert.equal(snapshot.counts.messages, 0);
    assert.equal(snapshot.counts.contacts, 0);
  } finally { await storage.close(); }
  const reopened = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(reopened.databaseId, result.databaseId);
  assert.equal(reopened.ownerId, result.ownerId);
});

test('清理失败保留维护态；修复现场后用同一操作重试，不重建空库', async t => {
  const root = await fixture(t);
  const layout = await legacyLayout(root);
  await symlink('/etc/hosts', path.join(root, 'assistant-runtime', layout.owner, layout.contact, layout.session, 'link'));
  await authorizeBusinessTargets(root);
  const failed = await runDefaultDatabaseStartup({ userData: root, allowSyntheticAuthorization: true });
  assert.equal(failed.phase, 'maintenance');
  assert.equal(failed.code, 'cutover_cleanup_failed');
  assert.equal(await exists(path.join(root, 'assistant-runtime')), true);
  // 清理未完成前不创建新实例，避免失败时留下无法归属的空库。
  assert.equal(await exists(path.join(root, 'managed/sqlite/notalone.sqlite')), false);
  const databaseId = JSON.parse(await readFile(manifestPath(root), 'utf8')).target?.databaseId;
  assert.equal(databaseId, undefined);
  await rm(path.join(root, 'assistant-runtime', layout.owner, layout.contact, layout.session, 'link'));
  const retried = await runDefaultDatabaseStartup({ userData: root, allowSyntheticAuthorization: true });
  assert.equal(retried.phase, 'ready', JSON.stringify(retried));
  const reopened = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(reopened.databaseId, retried.databaseId, '重试必须沿用已记录的目标实例');
  assert.equal((await (await import('node:fs/promises')).readdir(path.join(root, 'managed/sqlite'))).filter(name => name === 'notalone.sqlite').length, 1);
  const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'));
  const runtimeTarget = manifest.legacyTargets.find(target => target.kind === 'legacy_assistant_runtime');
  assert.equal(runtimeTarget.state, 'cleaned');
  assert.ok(runtimeTarget.attempts >= 2);
});

test('创建目标后异常不以新空库掩盖失败；目标身份未记录时停止并保留现场', async t => {
  const root = await fixture(t);
  let injected = false;
  const factory = {
    async open(options) {
      const storage = await SqliteStorage.open(options);
      if (options.intent === 'create' && !injected) {
        injected = true; await storage.close();
        const error = new Error('synthetic create failure');
        error.code = 'storage_failed';
        throw error;
      }
      return storage;
    },
  };
  const failed = await runDefaultDatabaseStartup({ userData: root, storageFactory: factory });
  assert.equal(failed.phase, 'maintenance');
  assert.equal(await exists(path.join(root, 'managed/sqlite/notalone.sqlite')), true);
  const retried = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(retried.phase, 'maintenance');
  assert.equal(retried.code, 'cutover_target_unrecorded');
  const files = (await import('node:fs/promises')).readdir(path.join(root, 'managed/sqlite'));
  assert.deepEqual((await files).filter(name => name === 'notalone.sqlite').length, 1);
  assert.equal(await exists(startupConfigPath(root)), false);
});

test('启动配置被篡改时拒绝启动，目标数据库缺失时不自动重建', async t => {
  const root = await fixture(t);
  const ready = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(ready.phase, 'ready');
  await file(startupConfigPath(root), JSON.stringify({ ...JSON.parse(await readFile(startupConfigPath(root), 'utf8')), expectedDatabaseId: 'other-instance' }) + '\n');
  const conflict = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(conflict.phase, 'maintenance');
  assert.equal(conflict.code, 'cutover_configuration_conflict');
  await file(startupConfigPath(root), JSON.stringify({ formatVersion: 1, intent: 'open', role: 'test', expectedDatabaseId: ready.databaseId,
    capabilities: ready.configuration.capabilities, skillPackageRoot: ready.configuration.skillPackageRoot }) + '\n');
  await rm(path.join(root, 'managed/sqlite/notalone.sqlite'));
  const missing = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(missing.phase, 'maintenance');
  assert.equal(missing.code, 'cutover_storage_failed');
  assert.equal(await exists(path.join(root, 'managed/sqlite/notalone.sqlite')), false);
});

test('新库为空但受管媒体区有旧文件时核验失败；移除后沿用同一目标实例完成切换', async t => {
  const root = await fixture(t);
  await file(path.join(root, 'managed/media/leftover.jpg'), 'legacy-media');
  const blocked = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(blocked.phase, 'maintenance');
  assert.equal(blocked.code, 'cutover_checks_failed');
  assert.equal(await exists(startupConfigPath(root)), false);
  const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'));
  assert.ok(manifest.checks.find(check => check.name === 'media_closure')?.state === 'failed');
  const databaseId = manifest.target.databaseId;
  await rm(path.join(root, 'managed/media/leftover.jpg'));
  const ready = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(ready.phase, 'ready', JSON.stringify(ready));
  assert.equal(ready.databaseId, databaseId);
  assert.equal(ready.code, 'sqlite_reopened');
});

test('synthetic 授权不得清理非隔离根；真实根必须使用 confirmed_local', async t => {
  const root = await fixture(t);
  const layout = await legacyLayout(root);
  await authorizeBusinessTargets(root);
  const blocked = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(blocked.phase, 'maintenance');
  assert.equal(blocked.code, 'cutover_authorization_invalid');
  assert.equal(await exists(path.join(root, 'managed/postgres/PG_VERSION')), true);
  assert.equal(await exists(path.join(layout.archive, 'database.dump')), true);
  assert.equal(await exists(path.join(root, 'managed/sqlite/notalone.sqlite')), false);
  const manifest = JSON.parse(await readFile(manifestPath(root), 'utf8'));
  assert.equal(manifest.phase, 'blocked');
  // confirmed_local（本地确认）不受隔离根门禁限制，但仍需覆盖精确目标。
  await file(authorizationPath(root), JSON.stringify({ formatVersion: 1, approvedAt: 2, scope: 'confirmed_local',
    targets: discoverLegacyTargets(root).filter(target => BUSINESS_TARGETS.includes(target.kind)).map(target => ({ id: target.id, disposition: 'clean' })) }) + '\n');
  const ready = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(ready.phase, 'ready', JSON.stringify(ready));
  assert.equal(await exists(path.join(root, 'managed/postgres')), false);
});

test('清理完成后目标创建失败保留维护态，不恢复旧writer也不建第二个空库', async t => {
  const root = await fixture(t);
  await legacyLayout(root);
  await authorizeBusinessTargets(root);
  let injected = false;
  const factory = { async open(options) {
    const storage = await SqliteStorage.open(options);
    if (options.intent === 'create' && !injected) {
      injected = true; await storage.close();
      const error = new Error('synthetic create failure after cleanup'); error.code = 'storage_failed'; throw error;
    }
    return storage;
  } };
  const failed = await runDefaultDatabaseStartup({ userData: root, allowSyntheticAuthorization: true, storageFactory: factory });
  assert.equal(failed.phase, 'maintenance');
  assert.equal(failed.code, 'cutover_storage_failed');
  // 旧业务对象已在同一操作中清理；失败后不回退旧 writer、不写启动配置。
  assert.equal(await exists(path.join(root, 'managed/postgres')), false);
  assert.equal(await exists(path.join(root, 'assistant-runtime')), false);
  assert.equal(await exists(startupConfigPath(root)), false);
  const retried = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(retried.phase, 'maintenance');
  assert.equal(retried.code, 'cutover_target_unrecorded');
  assert.equal(await exists(startupConfigPath(root)), false);
  const files = (await import('node:fs/promises')).readdir(path.join(root, 'managed/sqlite'));
  assert.equal((await files).filter(name => name === 'notalone.sqlite').length, 1);
});

test('清理后配置切换前重新出现旧写入者时停止切换', async t => {
  const root = await fixture(t);
  await legacyLayout(root);
  await authorizeBusinessTargets(root);
  const writer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
  t.after(() => { try { writer.kill('SIGKILL'); } catch { /* 已退出。 */ } });
  let injected = false;
  const factory = { async open(options) {
    const storage = await SqliteStorage.open(options);
    if (options.intent === 'create' && !injected) {
      injected = true;
      // 模拟清理完成后、切换配置前旧写入者重新启动并发布握手。
      await file(path.join(root, 'managed/backend.info'), `address=127.0.0.1:1\ntoken=synthetic\npid=${writer.pid}\n`);
    }
    return storage;
  } };
  const blocked = await runDefaultDatabaseStartup({ userData: root, allowSyntheticAuthorization: true, storageFactory: factory });
  assert.equal(blocked.phase, 'maintenance');
  assert.equal(blocked.code, 'cutover_legacy_writer_running');
  assert.equal(await exists(startupConfigPath(root)), false);
  writer.kill('SIGTERM');
  await new Promise(resolve => writer.once('exit', resolve));
  const ready = await runDefaultDatabaseStartup({ userData: root });
  assert.equal(ready.phase, 'ready', JSON.stringify(ready));
  assert.equal(await exists(startupConfigPath(root)), true);
});
