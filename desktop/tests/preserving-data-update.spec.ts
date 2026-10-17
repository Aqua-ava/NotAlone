import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, selectMenu } from './app-fixture';

const execute = promisify(execFile);
const project = path.resolve('..');
const python = path.join(process.env.CONDA_PREFIX || '/unconfigured', 'bin/python');
type Legacy = { database: string; database_url: string; owner: string; contact: string; directory: string };

const test = appTest.extend<{ legacy: Legacy; legacyState: 'ready' | 'drift' }>({
  legacyState: ['ready', { option: true }],
  legacy: async ({ legacyState }, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone') throw new Error('旧版合成夹具需要 NotAlone Conda。');
    const run = (action: string, database?: string) => execute(python, [path.resolve('tests/fixtures/update-database.py'), action,
      '--project', project, ...(database ? ['--database', database] : [])], {
      env: { ...process.env, PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1' }, timeout: 60_000,
    });
    const legacy = JSON.parse((await run('create')).stdout);
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-update-legacy-'));
    try {
      if (legacyState === 'drift') await run('drift', legacy.database);
      await writeFile(path.join(directory, 'legacy.env'), `NOTALONE_DATABASE_URL=${legacy.database_url}\nNOTALONE_OWNER_ID=${legacy.owner}\nNOTALONE_DEEPSEEK_API_KEY=synthetic-not-a-real-model-key\n`, { mode: 0o600 });
      await use({ ...legacy, directory });
    } finally { await run('drop', legacy.database); await rm(directory, { force: true, recursive: true }); }
  },
  appWorkingDirectory: '/',
  appEnvironment: { PATH: '/usr/bin:/bin', CONDA_PREFIX: '', CONDA_DEFAULT_ENV: '', PYTHONPATH: '/synthetic/unavailable' },
  launchConfiguration: async ({ legacy }, use) => { await use({ pythonExecutable: python, projectDirectory: project,
    envFilePath: path.join(legacy.directory, 'legacy.env'), backendInfoPath: path.join(legacy.directory, 'backend.info') }); },
});

test('已有本机安装通过一次公开备份更新保留联系人并切到包内后台', async ({ runningApp: { app, appProcess } }) => {
  test.setTimeout(180_000);
  const manager = await app.firstWindow();
  const update = manager.getByRole('button', { name: '备份并完成更新', exact: true });
  await expect(update).toBeVisible({ timeout: 20_000 });
  await update.click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 120_000 });
  await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
  await expect(manager.getByText('合成保留联系人', { exact: true })).toBeVisible();
  await expect(manager.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible();
  await expect(manager.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
});

test.describe('旧版资料历史有差异时的公开恢复动作', () => {
  test.use({ legacyState: 'drift' });
  test('不显示无效更新按钮，只读重新检查修复后的旧记录才允许更新', async ({ runningApp: { app, appProcess }, legacy }) => {
    test.setTimeout(180_000);
    const manager = await app.firstWindow();
    await expect(manager.getByRole('button', { name: '重新检查资料', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(manager.getByRole('button', { name: '继续备份更新', exact: true })).toHaveCount(0);
    await expect(manager.getByRole('button', { name: '备份并完成更新', exact: true })).toHaveCount(0);
    await expect(manager.getByRole('button', { name: '查看恢复说明', exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '重新检查资料', exact: true }).click();
    await expect(manager.getByText('正在只读重新检查资料…', { exact: true })).toBeVisible();
    await expect(manager.getByRole('button', { name: '重新检查资料', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(manager.getByText('资料版本记录有差异，不能直接更新。请保留原资料并使用原版 App 恢复。', { exact: true })).toBeVisible();
    // 仅恢复本夹具故意改坏的既有正式摘要，不是产品写账本的能力。
    await execute(python, [path.resolve('tests/fixtures/update-database.py'), 'restore-drift', '--project', project, '--database', legacy.database],
      { env: { ...process.env, PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1' }, timeout: 30_000 });
    await manager.getByRole('button', { name: '重新检查资料', exact: true }).click();
    await expect(manager.getByRole('button', { name: '备份并完成更新', exact: true })).toBeVisible({ timeout: 30_000 });
    await manager.getByRole('button', { name: '备份并完成更新', exact: true }).click();
    await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 90_000 });
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15_000 }).toBe(0);
  });
});
