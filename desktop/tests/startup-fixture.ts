import type { Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest } from './app-fixture';

const execute = promisify(execFile);
export const projectDirectory = path.resolve('..');
// 仅保留历史fixture签名；当前开发入口不接受Python配置。
export const pythonExecutable = process.env.NOTALONE_HISTORICAL_PYTHON ?? '/historical-only/python';

export async function openStartupDiagnostics(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  for (const name of ['高级', '故障排查']) {
    const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
    if (!await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
  }
}

export async function prepareDatabase(action: 'create' | 'migrate' | 'drop' | 'untracked' | 'drift' | 'restore-drift' | 'incomplete'
  | 'owner-incomplete' | 'restore-owner-timestamp', database?: string): Promise<{ database: string; database_url: string }> {
  if (!process.env.NOTALONE_HISTORICAL_TEST_ROOT || !process.env.NOTALONE_HISTORICAL_PYTHON) throw new Error('旧启动fixture仅允许固定23a历史命令与独立venv；请运行 backend-ts 的 npm run test:historical -- desktop-app <原参数>。');
  const { stdout } = await execute(pythonExecutable, [path.resolve('tests/fixtures/startup-database.py'), action,
    '--project', projectDirectory, ...(database ? ['--database', database] : [])], {
    env: { ...process.env, PYTHONPATH: path.join(projectDirectory, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1' },
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

export const test = appTest.extend<{ databaseState: 'empty' | 'ready' | 'untracked' | 'drift' | 'incomplete' | 'owner-incomplete'; startupDatabase: { database: string; database_url: string; directory: string } }>({
  appWorkingDirectory: '/',
  databaseState: ['empty', { option: true }],
  startupDatabase: async ({ databaseState }, use) => {
    const database = await prepareDatabase('create');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-startup-'));
    try {
      if (databaseState !== 'empty') await prepareDatabase('migrate', database.database);
      if (databaseState !== 'empty' && databaseState !== 'ready') await prepareDatabase(databaseState, database.database);
      await use({ ...database, directory });
    } finally { await prepareDatabase('drop', database.database); await rm(directory, { recursive: true, force: true }); }
  },
  appEnvironment: async ({ startupDatabase }, use) => {
    await use({ NOTALONE_DATABASE_URL: startupDatabase.database_url,
      PATH: '/usr/bin:/bin', CONDA_PREFIX: '', CONDA_DEFAULT_ENV: '', PYTHONPATH: '/synthetic/unavailable' });
  },
  launchConfiguration: async ({}, use) => { await use({ projectDirectory }); },
});
