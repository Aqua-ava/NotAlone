import { expect } from '@playwright/test';
import { test as bindingTest } from './binding-fixture';
import { ContactHttpProxy } from './contact-http-proxy';

const test = bindingTest.extend<{ bindingProxy: ContactHttpProxy }>({
  bindingProxy: [async ({ bindingBackend }, use) => {
    await bindingBackend.startBackend();
    const proxy = await ContactHttpProxy.attach(bindingBackend.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`连接失效后旧授权响应的迟到${failure ? '失败' : '成功'}不覆盖新范围或手选`, async ({ runningApp: { app }, bindingBackend, bindingProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待授权会话' });
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' }).check();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_a 对应联系人' }).selectOption(bindingBackend.data.contact_ids[0]);
  bindingProxy.holdBindingPaths.add('/api/sync/cli-bindings/confirm');
  // 公开具名操作的 Promise 用于等待受控传输收尾；结果仍从可见页面和真实 HTTP 核验。
  const confirmation = manager.evaluate(async (contactId) => {
    const state = await window.notalone.bindings.getState();
    return window.notalone.bindings.confirmSelections({ scopeRevision: state.scopeRevision, selections: [
      { locator: 'wxid_synthetic_a', displayName: '同名会话', contactId },
    ] });
  }, bindingBackend.data.contact_ids[0]);
  await expect.poll(() => bindingProxy.heldCount).toBe(1);
  bindingProxy.failRuntimeStatus = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await expect(manager.getByRole('region', { name: '待授权会话' })).toHaveCount(0);
  bindingProxy.holdBindingPaths.clear();
  bindingProxy.failRuntimeStatus = false;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  const authorized = manager.getByRole('region', { name: '已授权会话' });
  await expect(authorized.getByText('wxid_synthetic_a', { exact: true })).toBeVisible();
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_b' }).check();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_b 对应联系人' }).selectOption(bindingBackend.data.contact_ids[1]);
  bindingProxy.release(failure);
  await confirmation;
  await expect(pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_b' })).toBeChecked();
  await expect(pending.getByRole('combobox', { name: '会话 wxid_synthetic_b 对应联系人' })).toHaveValue(bindingBackend.data.contact_ids[1]);
  await expect(manager.getByText('授权确认未完成。请核对当前已授权范围后重试。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('已确认所选会话的后台读取授权。', { exact: true })).toHaveCount(0);
  expect(((await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as unknown[]).length).toBe(1);
  expect(await bindingBackend.tails()).toEqual([]);
});
