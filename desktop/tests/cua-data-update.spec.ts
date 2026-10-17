import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';
import { launchApp } from './app-test-gate';

const execute = promisify(execFile);
const project = path.resolve('..');
const python = path.join(process.env.CONDA_PREFIX || '/unconfigured', 'bin/python');
const test = appTest.extend({
  appDataPreparation: async ({}, use) => {
    let database: string | undefined;
    const fixture = (action: string, name?: string) => execute(python, [path.resolve('tests/fixtures/update-database.py'), action,
      '--project', project, ...(name ? ['--database', name] : [])], {
      env: { ...process.env, PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1' }, timeout: 60_000,
    });
    try {
      await use(async directory => {
        const source = JSON.parse((await fixture('create')).stdout); database = source.database;
        const env = path.join(directory, 'legacy.env');
        await writeFile(env, `NOTALONE_DATABASE_URL=${source.database_url}\nNOTALONE_OWNER_ID=${source.owner}\nNOTALONE_DEEPSEEK_API_KEY=synthetic-cua-not-a-real-key\n`, { mode: 0o600 });
        // 旧开发工具确实不存在；接续只能使用待验 App 包自己的运行时。
        await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({
          pythonExecutable: '/synthetic/retired-installation/python', projectDirectory: '/synthetic/retired-installation/project',
          envFilePath: env, backendInfoPath: path.join(directory, 'legacy-backend.info'),
        }), { mode: 0o600 });
      });
    } finally { if (database) await fixture('drop', database); }
  },
  appWorkingDirectory: '/',
});

test.skip(process.env.NOTALONE_CUA_UPDATE !== '1', '仅供主 Agent 实际 Computer Use 验收时显式运行。');
test('CUA只管理旧资料验收实例与重开，不代替实际更新和查看操作', async ({ runningApp: { app, appProcess, userData }, appExecutable }) => {
  test.setTimeout(20 * 60_000);
  if (!appExecutable) throw new Error('需要实际 App 包');
  const nonce = randomUUID();
  const record = test.info().outputPath('cua-ready.json');
  const signal = test.info().outputPath('cua-reopen.json');
  const manager = await app.firstWindow();
  await expect(manager.getByRole('button', { name: '备份并完成更新', exact: true })).toBeVisible({ timeout: 30_000 });
  await writeFile(record, JSON.stringify({ nonce, stage: 'waiting-for-cua-update', pid: appProcess.pid, appExecutable, userData, signal }), { mode: 0o600 });
  // 业务按钮、资料查看与原生菜单退出均由主 Agent 用 Computer Use 操作。
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 12 * 60_000 });
  await expect.poll(() => appProcess.exitCode, { timeout: 12 * 60_000 }).toBe(0);
  await expect.poll(async () => {
    try { const value = JSON.parse(await readFile(signal, 'utf8')); return value.nonce === nonce && value.action === 'reopen'; }
    catch { return false; }
  }, { timeout: 12 * 60_000 }).toBe(true);
  const reopened = await launchApp({ executablePath: appExecutable, cwd: '/', args: [`--user-data-dir=${userData}`], env: isolatedAppEnvironment(userData) });
  const reopenedProcess = reopened.process();
  try {
    const window = await reopened.firstWindow();
    await expect(window.getByText('已连接', { exact: true })).toBeVisible({ timeout: 60_000 });
    await writeFile(record, JSON.stringify({ nonce, stage: 'reopened-for-cua', pid: reopenedProcess.pid, appExecutable, userData, signal }), { mode: 0o600 });
    await expect.poll(() => reopenedProcess.exitCode, { timeout: 12 * 60_000 }).toBe(0);
  } finally { if (reopenedProcess.exitCode === null) await reopened.close().catch(() => {}); }
});
