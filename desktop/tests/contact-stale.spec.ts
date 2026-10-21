import { expect } from '@playwright/test';
import { test as contactTest } from './contact-fixture';
import { ContactHttpProxy } from './contact-http-proxy';

const test = contactTest.extend<{ contactProxy: ContactHttpProxy }>({
  backendMode: 'reused',
  contactProxy: [async ({ contactBackend }, use) => {
    const proxy = await ContactHttpProxy.attach(contactBackend.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`切换联系人后，旧目录请求的迟到${failure ? '失败' : '成功'}不覆盖新联系人草稿`, async ({ runningApp: { app }, contactBackend, contactProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  await helper.getByRole('textbox', { name: '草稿' }).fill('甲的旧草稿。');
  contactProxy.holdContacts = true;
  // 公开具名刷新 Promise 只用于确认在途操作收尾；断言仍来自真实两窗的可见结果。
  const refresh = manager.evaluate(() => window.notalone.contacts.refreshContacts());
  await expect.poll(() => contactProxy.heldCount).toBe(1);
  await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[1]);
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true }).locator('option:checked')).toHaveText('合成联系人乙');
  await helper.getByRole('textbox', { name: '草稿' }).fill('乙的新草稿，不接受旧请求覆盖。');
  contactProxy.holdContacts = false;
  contactProxy.release(failure);
  await refresh;
  await expect(manager.getByText('联系人目录读取失败，请刷新重试。', { exact: true })).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '草稿' })).toHaveValue('乙的新草稿，不接受旧请求覆盖。');
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.contact_ids[1]);
});

for (const failure of [false, true]) test(`断线重连清空临时会话，旧目录的迟到${failure ? '失败' : '成功'}不覆盖新选择`, async ({ runningApp: { app }, contactBackend, contactProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  const draft = helper.getByRole('textbox', { name: '草稿' });
  await draft.fill('断线前甲的草稿。');
  contactProxy.holdContacts = true;
  const refresh = manager.evaluate(() => window.notalone.contacts.refreshContacts());
  await expect.poll(() => contactProxy.heldCount).toBe(1);
  contactProxy.failRuntimeStatus = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue('');
  await expect(draft).toHaveValue('');
  await expect(draft).toBeDisabled();
  contactProxy.holdContacts = false;
  contactProxy.failRuntimeStatus = false;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true }).getByRole('option', { name: '合成联系人乙', exact: true })).toHaveCount(1);
  await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[1]);
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true }).locator('option:checked')).toHaveText('合成联系人乙');
  await draft.fill('重连后乙的新草稿。');
  contactProxy.release(failure);
  await refresh;
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.contact_ids[1]);
  await expect(draft).toHaveValue('重连后乙的新草稿。');
  await expect(manager.getByText('联系人目录读取失败，请刷新重试。', { exact: true })).toHaveCount(0);
});
