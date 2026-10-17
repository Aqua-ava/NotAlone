import { expect } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, isolatedAppEnvironment, selectMenu } from './app-fixture';
import { launchApp } from './app-test-gate';

const execute = promisify(execFile);
const project = path.resolve('..');
const python = path.join(process.env.CONDA_PREFIX || '/unconfigured', 'bin/python');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address();
      server.close(() => address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('fixture_port'))); });
  });
}
async function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('fixture_database_stop')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); });
}
const test = appTest.extend<{ corruptActivation: boolean }>({
  corruptActivation: [false, { option: true }],
  appWorkingDirectory: '/',
  appDataPreparation: async ({ appExecutable, corruptActivation }, use) => {
    if (!appExecutable || !appExecutable.endsWith('.app/Contents/MacOS/NotAlone')) throw new Error('受管更新需要真实 App 包');
    const pg = path.resolve(appExecutable, '../../Resources/notalone-runtime/postgres/bin');
    await use(async userData => {
      if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone') throw new Error('旧结构夹具需要 NotAlone Conda');
      const managed = path.join(userData, 'managed'); await mkdir(managed, { mode: 0o700 });
      const password = randomBytes(32).toString('hex'); const port = await freePort();
      const cluster = path.join(managed, 'postgres'); const secret = path.join(managed, 'fixture-password');
      const environment = { PATH: '/usr/bin:/bin', HOME: userData, LANG: 'en_US.UTF-8', LC_ALL: 'C' };
      await writeFile(secret, password, { mode: 0o600 });
      await execute(path.join(pg, 'initdb'), ['-D', cluster, '-U', 'notalone', '--encoding=UTF8', '--locale=C',
        '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--pwfile', secret], { env: environment, timeout: 30_000 });
      await rm(secret);
      await writeFile(path.join(userData, 'managed-update-fixture.json'), '{"fixture":"preserving-data-update"}', { mode: 0o600 });
      const database = spawn(path.join(pg, 'postgres'), ['-D', cluster, '-h', '127.0.0.1', '-p', String(port), '-c', 'unix_socket_directories='], { env: environment, stdio: 'ignore' });
      const target = `postgresql://notalone:${password}@127.0.0.1:${port}/notalone`;
      try {
        await expect.poll(async () => execute(path.join(pg, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port)], { env: environment }).then(() => true, () => false)).toBe(true);
        const seeded = JSON.parse((await execute(python, [path.resolve('tests/fixtures/update-database.py'), 'create', '--project', project,
          '--managed-directory', userData], { env: { ...process.env, PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1', NOTALONE_TEST_MANAGED_URL: target }, timeout: 60_000 })).stdout);
        await writeFile(path.join(managed, 'state.json'), JSON.stringify({ formatVersion: 1, password, bootstrapComplete: true }), { mode: 0o600 });
        await writeFile(path.join(managed, 'runtime.env'), `NOTALONE_DATABASE_URL=${target}\nNOTALONE_OWNER_ID=${seeded.owner}\nNOTALONE_DEEPSEEK_API_KEY=synthetic-not-a-real-key\n`, { mode: 0o600 });
      } finally { database.kill('SIGINT'); await ended(database); }
      if (corruptActivation) {
        const identifier = randomUUID(); const backup = path.join(userData, 'updates', identifier);
        await mkdir(backup, { recursive: true, mode: 0o700 });
        await writeFile(path.join(userData, 'update-operation.json'), JSON.stringify({ formatVersion: 1, fingerprint: 'a'.repeat(64), external: true, backup: identifier }), { mode: 0o600 });
        await writeFile(path.join(backup, 'retired-launch.json'), '{}', { mode: 0o600 });
        await writeFile(path.join(backup, 'checkpoint.json'), '{synthetic-incomplete-checkpoint', { mode: 0o600 });
      }
    });
  },
});

test.describe('未完成激活的恢复记录损坏', () => {
  test.use({ corruptActivation: true });
  test('公开显示恢复状态并阻止连接，不用无效更新按钮掩盖损坏检查点', async ({ runningApp: { app, appProcess, userData } }) => {
    const manager = await app.firstWindow();
    await expect(manager.getByRole('button', { name: '查看恢复说明', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(manager.getByRole('button', { name: '继续备份更新', exact: true })).toHaveCount(0);
    await expect(manager.getByText('已连接', { exact: true })).toHaveCount(0);
    await manager.getByRole('button', { name: '重新检查资料', exact: true }).click();
    await expect(manager.getByRole('button', { name: '查看恢复说明', exact: true })).toBeVisible();
    expect(await readFile(path.join(userData, 'managed/postgres/postmaster.pid')).then(() => true, () => false)).toBe(false);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
  });
});

test('已有受管055资料从公开按钮完成更新，重开保留本人模型与原联系人', async ({ runningApp: { app, appProcess, userData }, appExecutable }) => {
  test.setTimeout(180_000);
  const manager = await app.firstWindow();
  await expect(manager.getByRole('button', { name: '备份并完成更新', exact: true })).toBeVisible({ timeout: 30_000 });
  await manager.getByRole('button', { name: '备份并完成更新', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(manager.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
  await expect(manager.getByRole('button', { name: '选择合成保留联系人', exact: true })).toBeVisible();
  await expect(manager.getByText('1 条消息 · 1 份来源', { exact: true })).toBeVisible();
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
  const reopened = await launchApp({ executablePath: appExecutable, cwd: '/', args: [`--user-data-dir=${userData}`], env: isolatedAppEnvironment(userData) });
  const reopenedProcess = reopened.process();
  await writeFile(test.info().outputPath('reopened-app-owned.json'), JSON.stringify({ pid: reopenedProcess.pid, userData }), { mode: 0o600 });
  try {
    const window = await reopened.firstWindow();
    await expect(window.getByText('已连接', { exact: true })).toBeVisible({ timeout: 40_000 });
    await expect(window.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: '备份并完成更新', exact: true })).toHaveCount(0);
    await selectMenu(reopened, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => reopenedProcess.exitCode, { timeout: 15_000 }).toBe(0);
  } finally { if (reopenedProcess.exitCode === null) await reopened.close(); }
});
