import { expect } from '@playwright/test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    await writeFile(path.join(project, 'backend/src/notalone/server/command.py'), await readFile(path.resolve('tests/fixtures/backend-command.py')));
    await use(project);
  },
  appEnvironment: async ({ backend }, use) => {
    await rm(backend.infoPath);
    await use({ NOTALONE_BACKEND_INFO: backend.infoPath,
      NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env'),
      NOTALONE_TEST_START_MARKER: path.join(backend.directory, 'startup-marker') });
  },
  launchConfiguration: async ({ syntheticProject }, use) => {
    await use({ pythonExecutable: path.join(process.env.CONDA_PREFIX ?? '/unconfigured', 'bin/python'), projectDirectory: syntheticProject });
  },
});

test('本 App 子进程启动失败后明确重试能创建新运行时，旧退出不能覆盖成功状态', async ({ runningApp: { app, appProcess } }) => {
  expect(process.env.CONDA_DEFAULT_ENV, '验收须先激活 NotAlone Conda').toBe('NotAlone');
  const manager = await app.firstWindow();
  await expect(manager.getByText('本机服务连接失败，请重试。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await manager.getByRole('button', { name: '重试连接' }).click();
  await expect(manager.getByRole('status')).toContainText('已连接', { timeout: 15_000 });
  await expect(manager.getByText('已启动并验证本机运行时。', { exact: true })).toBeVisible();
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
});
