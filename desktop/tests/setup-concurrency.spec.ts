import { expect } from '@playwright/test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SetupFixture, test as setupTest } from './setup-fixture';
import { SetupHttpProxy } from './setup-http-proxy';

const test = setupTest.extend<{ peer: SetupFixture; transportProxy: SetupHttpProxy }>({
  peer: async ({ setup }, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-setup-peer-'));
    const peer = new SetupFixture(directory, setup.databaseName);
    try {
      await peer.prepareInterpreter();
      await peer.startBackend();
      await use(peer);
    } finally { await peer.cleanup(); await rm(directory, { recursive: true, force: true }); }
  },
  transportProxy: [async ({ setup }, use) => {
    setup.reusedBackend = await setup.startBackend();
    const proxy = await SetupHttpProxy.attach(setup.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

test('App空库检查后的竞争创建，在写本轮配置之前拒绝既有身份', async ({ runningApp: { app }, setup, peer, transportProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '设置', exact: true }).click();
  const panel = manager.getByRole('region', { name: 'AI 服务' });
  await expect(panel.getByText('本人身份尚未初始化', { exact: true })).toBeVisible({ timeout: 15_000 });
  transportProxy.holdSetupStatusResponses = true;
  await panel.getByRole('textbox', { name: '本人展示名称' }).fill('App明确初始化的合成本人');
  await panel.getByRole('button', { name: '初始化本人' }).click();
  await expect.poll(() => transportProxy.heldCount).toBe(1);
  try {
    expect((await peer.request('/api/setup/initialize', { display_name: '另一客户端的合成人员', create_only: true })).status).toBe(200);
    expect(await stat(setup.envPath).then(() => true, () => false)).toBe(false);
    transportProxy.holdSetupStatusResponses = false;
    transportProxy.release();
    await expect.poll(() => transportProxy.initializeCompletedCount).toBe(1);
    expect(await stat(setup.envPath).then(() => true, () => false)).toBe(false);
    await expect(panel.getByText('本人初始化未完成，请重试。', { exact: true })).toBeVisible();
    await expect(panel.getByText('本次运行的本人身份已就绪', { exact: true })).toHaveCount(0);
    expect((await setup.request('/api/setup/status')).data.runtime_owner_configured).toBe(false);
  } finally { transportProxy.holdSetupStatusResponses = false; transportProxy.release(); }
});

test('两个真实客户端在PG写入屏障下并发create_only，仅一个创建且失败方不写配置，明确恢复仍可用', async ({ setup, peer }) => {
  const barrier = await setup.holdOwnerWrites();
  const calls = [setup.request('/api/setup/initialize', { display_name: '并发合成人员甲', create_only: true }),
    peer.request('/api/setup/initialize', { display_name: '并发合成人员乙', create_only: true })];
  try {
    await expect.poll(() => barrier.waiting(), { timeout: 10_000 }).toBe(2);
    await barrier.release();
    const responses = await Promise.all(calls);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses[0].status === 409 ? setup : peer;
    expect(await stat(loser.envPath).then(() => true, () => false)).toBe(false);
    expect(responses.find((response) => response.status === 409)?.data).toEqual({ error: 'owner_already_configured' });
    const restored = await loser.request('/api/setup/initialize', { display_name: '明确恢复合成调用' });
    expect(restored.status).toBe(200);
    expect(restored.data.created).toBe(false);
    expect(restored.data.owner_id === responses.find((response) => response.status === 200)?.data.owner_id).toBe(true);
    expect((await loser.request('/api/setup/initialize', { display_name: '非法模式合成调用', create_only: 'true' })).status).toBe(400);
  } finally { await barrier.release(); await Promise.allSettled(calls); }
});
