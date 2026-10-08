import { expect } from '@playwright/test';
import path from 'node:path';
import { SyntheticBackend, test as backendTest } from './backend-fixture';
import { selectMenu } from './app-fixture';

const test = backendTest.extend({ appEnvironment: async ({ backend }, use) => {
  backend.service.statusDelay = 6200;
  backend.service.statusState = 'stopped';
  await use({ NOTALONE_BACKEND_INFO: backend.infoPath, NOTALONE_ENV_FILE: path.join(backend.directory, 'synthetic.env') });
} });

test('连接尝试超时后更换握手，旧状态响应不能覆盖新连接或关闭另一运行时', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByText('本机服务连接失败，请重试。', { exact: true })).toBeVisible({ timeout: 7000 });
  const replacement = new SyntheticBackend();
  try {
    await replacement.start();
    await replacement.writeHandshake(backend.infoPath);
    await manager.getByRole('button', { name: '重试连接' }).click();
    await expect(manager.getByRole('status')).toContainText('已连接');
    await expect.poll(() => backend.service.deliveredStatuses(), { timeout: 7000 }).toBe(1);
    await expect(manager.getByRole('status')).toContainText('已连接');
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(await replacement.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
    expect(await backend.service.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
  } finally { await replacement.close(); }
});
