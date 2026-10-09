import { expect } from '@playwright/test';
import { test } from './contact-fixture';

test.use({ backendMode: 'reused' });

test('明确重连到另一受控运行身份后，旧目录和草稿全部清空且目录按新 owner 隔离', async ({ runningApp: { app }, contactBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  await helper.getByRole('textbox', { name: '草稿' }).fill('原连接下甲的临时草稿。');
  await contactBackend.stopBackend();
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '草稿' })).toHaveValue('');
  await contactBackend.startBackend(contactBackend.data.other_owner_id);
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  const directory = manager.getByRole('region', { name: '联系人目录' });
  await expect(directory.getByText('另一用户的联系人', { exact: true })).toBeVisible();
  await expect(directory.getByText('合成联系人甲', { exact: true })).toHaveCount(0);
  await expect(directory.getByText('合成联系人乙', { exact: true })).toHaveCount(0);
  expect((await contactBackend.request('/api/contacts')).data).toEqual({ contacts: [
    { contact_id: contactBackend.data.other_contact_id, display_name: '另一用户的联系人', data_status: { message_count: 1, source_count: 1 } },
  ] });
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '草稿' })).toBeDisabled();
  await manager.getByRole('button', { name: '选择另一用户的联系人', exact: true }).click();
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toHaveValue(contactBackend.data.other_contact_id);
  await expect(helper.getByRole('textbox', { name: '草稿' })).toHaveValue('');
});
