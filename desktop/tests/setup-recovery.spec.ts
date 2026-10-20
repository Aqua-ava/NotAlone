import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { test as setupTest } from './setup-fixture';
import { SetupHttpProxy } from './setup-http-proxy';

const test = setupTest.extend<{ transportProxy: SetupHttpProxy }>({
  transportProxy: [async ({ setup }, use) => {
    setup.reusedBackend = await setup.startBackend();
    const proxy = await SetupHttpProxy.attach(setup.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

test('本人初始化失败后的恢复查询失联，不发布旧initialize-failed', async ({ runningApp: { app }, setup, transportProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  await expect(manager.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  await mkdir(setup.envPath);
  transportProxy.holdStatusAfterInitialize = true;
  const initialization = manager.evaluate(() => window.notalone.setup.initializeOwner('初始化失败合成人员'));
  try {
    await expect.poll(() => transportProxy.heldCount).toBe(1);
    transportProxy.failRuntimeStatus = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    transportProxy.release();
    await initialization;
    expect((await manager.evaluate(() => window.notalone.setup.getState())).errorCode).toBeUndefined();
    await expect(manager.getByText('本人初始化未完成，请重试。', { exact: true })).toHaveCount(0);
  } finally { transportProxy.failRuntimeStatus = false; transportProxy.release(); await initialization.catch(() => {}); }
});

test('初始化已真实写入而响应丢失时，用户可明确重新加载受控配置而不重新初始化', async ({ runningApp: { app }, setup, transportProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  transportProxy.dropInitializeResponse = true;
  await panel.getByRole('textbox', { name: '本人展示名称' }).fill('响应丢失合成本人');
  await panel.getByRole('button', { name: '初始化本人' }).click();
  await expect(panel.getByText('本人初始化未完成，请重试。', { exact: true })).toBeVisible();
  expect((await setup.request('/api/setup/status')).data).toMatchObject({ owner_configured: true, runtime_owner_configured: false });
  await expect(panel.getByRole('button', { name: '初始化本人' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '重新加载受控配置', exact: true })).toBeVisible();
  transportProxy.dropInitializeResponse = false;
  transportProxy.closeAfterShutdown = true;
  transportProxy.afterShutdown = () => setup.waitForExit(setup.reusedBackend!);
  await panel.getByRole('button', { name: '重新加载受控配置', exact: true }).click();
  await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(transportProxy.initializeCompletedCount).toBe(1);
  await expect.poll(() => setup.reusedBackend?.exitCode).toBe(0);
  expect((await setup.request('/api/setup/status')).data.runtime_owner_configured).toBe(true);
});
