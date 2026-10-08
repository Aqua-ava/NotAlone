import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest } from './app-fixture';

const execute = promisify(execFile);
export const projectDirectory = path.resolve('..');
export const pythonExecutable = path.join(process.env.CONDA_PREFIX ?? '/unconfigured', 'bin/python');

export async function prepareDatabase(action: 'create' | 'migrate' | 'drop' | 'untracked' | 'drift' | 'restore-drift' | 'incomplete', database?: string): Promise<{ database: string; database_url: string }> {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone') throw new Error('验收须先激活 NotAlone Conda。');
  const { stdout } = await execute(pythonExecutable, [path.resolve('tests/fixtures/startup-database.py'), action,
    '--project', projectDirectory, ...(database ? ['--database', database] : [])], {
    env: { ...process.env, PYTHONPATH: path.join(projectDirectory, 'backend/src'), NOTALONE_DISABLE_DOTENV: '1' },
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

export const test = appTest.extend<{ databaseState: 'empty' | 'ready' | 'untracked' | 'drift' | 'incomplete'; startupDatabase: { database: string; database_url: string; directory: string } }>({
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
  launchConfiguration: async ({}, use) => { await use({ pythonExecutable, projectDirectory }); },
});
