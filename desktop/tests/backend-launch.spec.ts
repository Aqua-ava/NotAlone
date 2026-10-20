import { expect } from '@playwright/test';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test as backendTest } from './backend-fixture';
import { selectMenu } from './app-fixture';

const test = backendTest.extend({
  appEnvironment: async ({ backend }, use) => {
    await rm(backend.infoPath);
    await use({
      NOTALONE_BACKEND_INFO: backend.infoPath,
      NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env'),
      PATH: '/usr/bin:/bin', CONDA_PREFIX: '', CONDA_DEFAULT_ENV: '', PYTHONPATH: '/synthetic/unavailable',
      // 机器 gate 使用本轮已显式迁移的随机测试库；owner 未初始化且没有业务调用。
      NOTALONE_DATABASE_URL: backend.database_url,
    });
  },
  launchConfiguration: [{
    pythonExecutable: path.join(process.env.CONDA_PREFIX ?? '/unconfigured', 'bin/python'),
    projectDirectory: path.resolve('..'),
  }, { option: true }],
});

test('App 用受控绝对 Python 和项目启动真实 BackendServer，认证退出后回收宿主', async ({ runningApp: { app, appProcess }, backend }) => {
  expect(process.env.CONDA_DEFAULT_ENV, '验收须先激活 NotAlone Conda').toBe('NotAlone');
  const manager = await app.firstWindow();
  await manager.evaluate(async () => {
    await Promise.all([window.notalone.backend.retryConnection(), window.notalone.backend.retryConnection(), window.notalone.backend.retryConnection()]);
  });
  await expect(manager.getByRole('status')).toContainText('已连接', { timeout: 15_000 });
  await expect.poll(() => manager.evaluate(() => window.notalone.backend.getState())).toMatchObject({ phase: 'connected', reused: false });
  const fields = new Map((await readFile(backend.infoPath, 'utf8')).trim().split('\n').map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)] as const;
  }));
  const response = await fetch(`http://${fields.get('address')}/api/runtime/status`, { headers: { Authorization: `Bearer ${fields.get('token')}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: 'running' });
  await manager.screenshot({ path: test.info().outputPath('real-backend-connected.png') });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await expect.poll(async () => { try { await access(backend.infoPath); return true; } catch { return false; } }).toBe(false);
});
