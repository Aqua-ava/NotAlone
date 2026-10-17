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
  const pythonExecutable = path.join(userData, 'synthetic-python');
  const infoPath = path.join(userData, 'backend.info');
  const marker = path.join(userData, 'schema-was-updated');
  await mkdir(path.join(projectDirectory, 'backend/src/notalone/server'), { recursive: true });
  await writeFile(path.join(projectDirectory, 'backend/src/notalone/server/command.py'), '# 合成后台入口\n');
  await writeFile(path.join(projectDirectory, 'backend/src/notalone/startup_diagnostics.py'), '# 合成只读诊断\n');
  await writeFile(pythonExecutable, `#!${process.execPath}
const fs=require('node:fs');
const changed=${JSON.stringify(marker)};
const updating=process.argv.includes('notalone.startup_database');
if(updating) fs.writeFileSync(changed,'updated');
console.log(JSON.stringify({code:updating||fs.existsSync(changed)?'ready':'migration_pending'}));
`, { mode: 0o700 });
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({ pythonExecutable, projectDirectory, backendInfoPath: infoPath }));
  return { userData, marker, infoPath, config: { source: 'external', pythonExecutable, projectDirectory, infoPath }, diagnostics: new StartupDiagnostics(userData) };
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
