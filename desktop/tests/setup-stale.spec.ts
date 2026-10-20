import { expect } from '@playwright/test';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { test as setupTest } from './setup-fixture';
import { SetupHttpProxy } from './setup-http-proxy';

const test = setupTest.extend<{ transportProxy: SetupHttpProxy }>({
  setupSeed: 'reused',
  transportProxy: [async ({ setup }, use) => {
    const proxy = await SetupHttpProxy.attach(setup.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const invalidation of ['connection', 'refresh'] as const) {
  test(`保存失败后的真实状态查询被 ${invalidation} 淘汰时，不发布旧错误`, async ({ runningApp: { app }, setup, transportProxy }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '设置', exact: true }).click();
    const panel = manager.getByRole('region', { name: '本人身份与模型' });
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
    await rename(setup.envPath, path.join(setup.directory, 'saved-synthetic.env'));
    await mkdir(setup.envPath);
    transportProxy.holdSetupStatusResponses = true;
    const save = manager.evaluate(() => window.notalone.setup.saveDeepSeekKey('sk-synthetic-failed-late'));
    try {
      await expect.poll(() => transportProxy.heldCount).toBe(1);
      if (invalidation === 'connection') {
        transportProxy.failRuntimeStatus = true;
        await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      } else {
        const refresh = manager.evaluate(() => window.notalone.setup.refresh());
        await expect.poll(() => transportProxy.heldCount).toBe(2);
        transportProxy.releaseLatest();
        await refresh;
        await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible();
      }
      transportProxy.release();
      await save;
      expect((await manager.evaluate(() => window.notalone.setup.getState())).errorCode).toBeUndefined();
      await expect(panel.getByText('DeepSeek 密钥未能保存，请重新输入后重试。', { exact: true })).toHaveCount(0);
    } finally {
      transportProxy.holdSetupStatusResponses = false;
      transportProxy.failRuntimeStatus = false;
      transportProxy.release();
      await save.catch(() => {});
    }
  });
}

test('真实凭据请求迟到且连接失效后，不保留保存中或采纳旧成功响应', async ({ runningApp: { app }, transportProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const panel = manager.getByRole('region', { name: '本人身份与模型' });
  await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toBeVisible({ timeout: 15_000 });
  transportProxy.holdCredentialResponses = true;
  await panel.getByRole('button', { name: '更新 DeepSeek 密钥' }).click();
  await panel.getByLabel('DeepSeek API Key').fill('sk-synthetic-delayed-key');
  await panel.getByRole('button', { name: '保存 DeepSeek 密钥' }).click();
  await expect.poll(() => transportProxy.heldCount).toBe(1);
  try {
    transportProxy.failRuntimeStatus = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    await expect(panel.getByText('连接本机服务后，可查询并完成首次配置。', { exact: true })).toBeVisible();
    transportProxy.release();
    await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('DeepSeek 已配置', { exact: true })).toHaveCount(0);
  } finally { transportProxy.failRuntimeStatus = false; transportProxy.release(); }
});
