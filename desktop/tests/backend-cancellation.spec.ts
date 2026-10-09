import { expect } from '@playwright/test';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as backendTest } from './backend-fixture';
import { selectMenu } from './app-fixture';

const test = backendTest.extend<{ syntheticProject: string }>({
  syntheticProject: async ({ backend }, use) => {
    const project = path.join(backend.directory, 'project');
    await mkdir(path.join(project, 'backend'), { recursive: true });
    await cp(path.resolve('../backend/src'), path.join(project, 'backend/src'), {
      recursive: true, filter: (source) => !source.includes('__pycache__'),
    });
    await cp(path.resolve('../backend/database/migrations'), path.join(project, 'backend/database/migrations'), { recursive: true });
    await writeFile(path.join(project, 'backend/src/notalone/server/command.py'), await readFile(path.resolve('tests/fixtures/backend-command.py')));
    await use(project);
  },
  appEnvironment: async ({ backend }, use) => {
    await rm(backend.infoPath);
    await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_DATABASE_URL: backend.database_url,
      NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env'),
      NOTALONE_TEST_START_MARKER: path.join(backend.directory, 'startup-marker') });
  },
  launchConfiguration: [undefined, { option: true }],
});

test('连接初始化中明确退出，不再启动新的后端子进程', async ({ runningApp: { app, appProcess, userData }, backend, syntheticProject }) => {
  expect(process.env.CONDA_DEFAULT_ENV, '验收须先激活 NotAlone Conda').toBe('NotAlone');
  const manager = await app.firstWindow();
  await expect(manager.getByRole('button', { name: '重试连接' })).toBeEnabled();
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
    pythonExecutable: path.join(process.env.CONDA_PREFIX!, 'bin/python'), projectDirectory: syntheticProject,
  }));
  // 两个具名操作按同一 renderer 的 IPC 顺序到达；不等待连接完成就明确退出。
  await manager.evaluate(() => {
    void window.notalone.backend.retryConnection().catch(() => {});
    void window.notalone.backend.quit().catch(() => {});
  });
  await expect.poll(() => appProcess.exitCode).toBe(0);
  const started = await access(path.join(backend.directory, 'startup-marker')).then(() => true, () => false);
  expect(started, '退出后不能再创建合成后端进程').toBe(false);
});

const startedTest = test.extend({
  appEnvironment: async ({ backend }, use) => {
    await rm(backend.infoPath);
    await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_DATABASE_URL: backend.database_url,
      NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env'),
      NOTALONE_TEST_START_MARKER: path.join(backend.directory, 'startup-marker'),
      NOTALONE_TEST_START_RELEASE: path.join(backend.directory, 'startup-release'),
      NOTALONE_TEST_SIGNAL_MARKER: path.join(backend.directory, 'signal-marker'),
      NOTALONE_TEST_EXIT_MARKER: path.join(backend.directory, 'exit-marker') });
  },
  launchConfiguration: async ({ syntheticProject }, use) => {
    await use({ pythonExecutable: path.join(process.env.CONDA_PREFIX ?? '/unconfigured', 'bin/python'), projectDirectory: syntheticProject });
  },
});

startedTest('子进程已创建而握手未完成时退出，仍通过真实 BackendServer 认证收尾', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  const release = path.join(backend.directory, 'startup-release');
  try {
    await expect.poll(async () => access(path.join(backend.directory, 'startup-marker')).then(() => true, () => false)).toBe(true);
    await expect(manager.getByRole('status')).toContainText('连接中');
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect(manager.getByRole('status')).toContainText('正在停读');
    await writeFile(release, 'synthetic release');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(await readFile(path.join(backend.directory, 'exit-marker'), 'utf8')).toBe('synthetic cleanup complete');
    expect(await access(path.join(backend.directory, 'signal-marker')).then(() => true, () => false)).toBe(false);
    expect(await access(backend.infoPath).then(() => true, () => false)).toBe(false);
  } finally { await writeFile(release, 'synthetic release'); }
});
