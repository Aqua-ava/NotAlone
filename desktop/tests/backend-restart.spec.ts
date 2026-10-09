import { expect } from '@playwright/test';
import { SyntheticBackend, test } from './backend-fixture';
import { selectMenu } from './app-fixture';

test('已连接后端重启换端口和 token，明确重试验证新握手，退出仍固定新验证目标', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  const replacement = new SyntheticBackend();
  const unrelated = new SyntheticBackend();
  try {
    await backend.service.close();
    await replacement.start();
    await replacement.writeHandshake(backend.infoPath);
    await expect(manager.getByText('本机服务连接失败，请重试。', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '重试连接' }).click();
    await expect(manager.getByRole('status')).toContainText('已连接');
    expect(await replacement.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
    // 明确重连完成后，随后替换握手仍不能改变本次退出的已验证目标。
    await unrelated.start();
    await unrelated.writeHandshake(backend.infoPath);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(await replacement.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
    expect(await unrelated.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
  } finally {
    await replacement.close();
    await unrelated.close();
  }
});

test('新握手认证进行中明确退出，仍关闭原已验证连接', async ({ runningApp: { app, appProcess }, backend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status')).toContainText('已连接');
  backend.service.statusMode = 'failure';
  await expect(manager.getByRole('button', { name: '重试连接' })).toBeEnabled();
  const replacement = new SyntheticBackend();
  try {
    replacement.statusDelay = 1000;
    await replacement.start();
    await replacement.writeHandshake(backend.infoPath);
    await manager.getByRole('button', { name: '重试连接' }).click();
    await expect(manager.getByRole('status')).toContainText('连接中');
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(await backend.service.observations()).toEqual({ state: 'stopped', shutdownCount: 1, unauthorizedCount: 0 });
    expect(await replacement.observations()).toEqual({ state: 'running', shutdownCount: 0, unauthorizedCount: 0 });
  } finally { await replacement.close(); }
});
