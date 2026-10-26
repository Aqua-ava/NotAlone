import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(tmpdir(), 'notalone-startup-guards-'));
const built = await build({ entryPoints: ['src/main/startup/diagnostics.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'subject.mjs'), built.outputFiles[0].text);
const { StartupDiagnostics } = await import(path.join(directory, 'subject.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

async function fixture(name) {
  const userData = path.join(directory, name);
  const projectDirectory = path.join(userData, 'project');
  const infoPath = path.join(userData, 'backend.info');
  const marker = path.join(userData, 'schema-was-updated');
  await mkdir(path.join(projectDirectory, 'backend-ts/src/platform/database'), { recursive: true });
  await mkdir(path.join(projectDirectory, 'backend-ts/profile'), { recursive: true });
  await writeFile(path.join(projectDirectory, 'backend-ts/src/launch.ts'), '// 合成启动入口\n');
  await writeFile(path.join(projectDirectory, 'backend-ts/profile/host.patch.yml'), '[]\n');
  await writeFile(path.join(projectDirectory, 'backend-ts/src/platform/database/host-storage.ts'), `
    import {existsSync} from 'node:fs';
    export class HostStorage {static async open(){return new HostStorage()}
      async compatibility(){return {code:existsSync(${JSON.stringify(marker)})?'ready':'migration_pending'}} async close(){} }
  `);
  await writeFile(path.join(projectDirectory, 'backend-ts/src/schema-prepare-cli.ts'), `
    import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(marker)},'updated');console.log('{"code":"ready"}');
  `);
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({ projectDirectory, backendInfoPath: infoPath }));
  return { userData, marker, infoPath, config: { runtime: 'dsh', source: 'external', projectDirectory, infoPath }, diagnostics: new StartupDiagnostics(userData) };
}

test('等待模型或轮询间隙的旧后台仍存活时，不以数据库暂时无连接为依据更新结构', async () => {
  const current = await fixture('running-backend');
  await writeFile(current.infoPath, `address=127.0.0.1:12345\ntoken=synthetic_token\npid=${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(current.diagnostics.ensureReady(current.config, () => true));
  assert.equal(current.diagnostics.getState().code, 'database_writers_present');
  assert.equal(await readFile(current.marker, 'utf8').catch(() => ''), '');
  await rm(current.infoPath);
  await current.diagnostics.ensureReady(current.config, () => true);
  assert.equal(current.diagnostics.getState().code, 'ready');
  assert.equal(await readFile(current.marker, 'utf8'), 'updated');
});

const completed = { formatVersion: 1, external: true, completed: true,
  fingerprint: 'a'.repeat(64), activeFingerprint: 'b'.repeat(64), backup: '12345678-1234-1234-1234-123456789abc' };
for (const [name, receipt] of [['interrupted', { formatVersion: 1, external: true }], ['damaged', null],
  ['missing-backup', { ...completed, backup: undefined }], ['unknown-fields', { ...completed, unknown: true }]]) {
  test(`旧更新${name}现场在运行任何结构命令前停止，不改配置和凭证`, async () => {
    const current = await fixture(name);
    await writeFile(path.join(current.userData, 'update-operation.json'), JSON.stringify(receipt), { mode: 0o600 });
    const original = await readFile(path.join(current.userData, 'backend-launch.json'));
    const files = await readdir(current.userData);
    await assert.rejects(current.diagnostics.ensureReady(current.config, () => true));
    assert.equal(current.diagnostics.getState().code, 'runtime_configuration_invalid');
    assert.deepEqual(await readFile(path.join(current.userData, 'backend-launch.json')), original);
    assert.deepEqual(await readdir(current.userData), files);
  });
}

test('已完成旧更新不依赖已清除的备份目录，继续使用现有外置配置', async () => {
  const current = await fixture('completed-history');
  await writeFile(path.join(current.userData, 'update-operation.json'), JSON.stringify(completed), { mode: 0o600 });
  await current.diagnostics.ensureReady(current.config, () => true);
  assert.equal(current.diagnostics.getState().code, 'ready');
  assert.equal((await readdir(current.userData)).includes('updates'), false);
});

test('旧复制库只有verified标记而没有完成凭证时，不能当成可用库启动', async () => {
  const current = await fixture('unconfirmed-copy');
  await mkdir(path.join(current.userData, 'managed'));
  await writeFile(path.join(current.userData, 'managed/import-pending.json'), '{"formatVersion":1,"verified":true}', { mode: 0o600 });
  await assert.rejects(current.diagnostics.ensureReady({ ...current.config, source: 'managed' }, () => true));
  assert.equal(current.diagnostics.getState().code, 'runtime_configuration_invalid');
  assert.equal(await readFile(current.marker, 'utf8').catch(() => ''), '');
});

test('DSH普通诊断复用TS存储兼容性，Python诊断模块缺失仍可核验固定状态', async () => {
  const current = await fixture('typescript-diagnostic');
  const { copyFile, symlink } = await import('node:fs/promises');
  await mkdir(path.join(current.config.projectDirectory, 'backend-ts/src'), { recursive: true });
  await copyFile(path.resolve('../backend-ts/src/platform/database/host-storage.ts'), path.join(current.config.projectDirectory, 'backend-ts/src/platform/database/host-storage.ts'));
  await symlink(path.resolve('../backend-ts/node_modules'), path.join(current.config.projectDirectory, 'backend-ts/node_modules'), 'dir');
  const previousUrl = process.env.NOTALONE_DATABASE_URL;
  process.env.NOTALONE_DATABASE_URL = '';
  try {
    await assert.rejects(current.diagnostics.ensureReady({ ...current.config, runtime: 'dsh' }, () => true));
    assert.equal(current.diagnostics.getState().code, 'database_unconfigured');
    assert.equal(await readFile(current.marker, 'utf8').catch(() => ''), '');
  } finally {
    if (previousUrl === undefined) delete process.env.NOTALONE_DATABASE_URL;
    else process.env.NOTALONE_DATABASE_URL = previousUrl;
  }
});

test('DSH的TS执行组件不可用时固定报错，不静默回退Python普通诊断', async () => {
  const current = await fixture('typescript-component-failed');
  await mkdir(path.join(current.config.projectDirectory, 'backend-ts/src'), { recursive: true });
  await writeFile(path.join(current.config.projectDirectory, 'backend-ts/src/platform/database/host-storage.ts'), 'invalid typescript source synthetic secret');
  await assert.rejects(current.diagnostics.ensureReady({ ...current.config, runtime: 'dsh' }, () => true));
  assert.equal(current.diagnostics.getState().code, 'runtime_components_unavailable');
  assert.equal(await readFile(current.marker, 'utf8').catch(() => ''), '');
});

test('默认DSH待更新经Node准备结构后仍用TS只读复验', async () => {
  const current = await fixture('typescript-schema-prepare');
  await current.diagnostics.ensureReady({ ...current.config, runtime: 'dsh' }, () => true);
  assert.equal(current.diagnostics.getState().code, 'ready');
  assert.equal(await readFile(current.marker, 'utf8'), 'updated');
});

test('取消DSH普通诊断回收本次TS子进程，不遗留后台读取', async () => {
  const current = await fixture('typescript-cancel');
  const started = path.join(current.userData, 'ts-started');
  const stopped = path.join(current.userData, 'ts-stopped');
  await mkdir(path.join(current.config.projectDirectory, 'backend-ts/src'), { recursive: true });
  await writeFile(path.join(current.config.projectDirectory, 'backend-ts/src/platform/database/host-storage.ts'), `
    import {writeFileSync} from 'node:fs';
    export class HostStorage { static async open() {return new HostStorage()}
      async compatibility(){
        process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});
        writeFileSync(${JSON.stringify(started)},'started');
        return new Promise(()=>{setInterval(()=>{},1000)});
      } async close(){} }
  `);
  const { watch } = await import('node:fs');
  const watching = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('合成TS诊断未启动')); }, 5000);
    const watcher = watch(current.userData, (_event, file) => {
      if (file === 'ts-started') { clearTimeout(timer); watcher.close(); resolve(); }
    });
  });
  const pending = current.diagnostics.ensureReady({ ...current.config, runtime: 'dsh' }, () => true);
  await watching;
  current.diagnostics.cancel();
  await pending;
  assert.equal(await readFile(stopped, 'utf8'), 'stopped');
  assert.equal(await readFile(current.marker, 'utf8').catch(() => ''), '');
});
