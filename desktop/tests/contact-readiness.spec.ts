import { expect } from '@playwright/test';
import { test } from './contact-fixture';

test.describe('当前本人已就绪的空目录', () => {
  test.use({ databaseMode: 'empty' });
  test('不受模型密钥缺失影响，真实空列表说明通过导入或同步确认建立联系人', async ({ runningApp: { app }, contactBackend }) => {
    const manager = await app.firstWindow();
    await expect(manager.getByText('还没有联系人', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect((await contactBackend.request('/api/setup/status')).data).toMatchObject({ runtime_owner_configured: true, credentials_configured: false });
    expect((await contactBackend.request('/api/contacts')).data).toEqual({ contacts: [] });
    await expect(manager.getByRole('button', { name: '添加联系人', exact: true })).toHaveCount(0);
    await manager.getByRole('button', { name: '前往从文件导入' }).click();
    await expect(manager.getByRole('heading', { name: '从文件导入', exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
    await manager.getByRole('button', { name: '前往同步设置' }).click();
    await expect(manager.getByRole('heading', { name: '同步设置', exact: true })).toBeVisible();
  });
});

test.describe('同库已有另一 owner 而运行 UUID 不存在', () => {
  test.use({ databaseMode: 'invalid-owner' });
  test('全库已配置和空联系人列表都不能代替当前本人就绪', async ({ runningApp: { app }, contactBackend }) => {
    const manager = await app.firstWindow();
    await expect(manager.getByText('本次运行的本人身份未就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect((await contactBackend.request('/api/setup/status')).data).toMatchObject({ owner_configured: true, runtime_owner_configured: false });
    expect((await contactBackend.request('/api/contacts')).data).toEqual({ contacts: [] });
    await expect(manager.getByText('还没有联系人', { exact: true })).toHaveCount(0);
    await expect(manager.getByText('另一用户的联系人', { exact: true })).toHaveCount(0);
    const opened = app.waitForEvent('window');
    await manager.getByRole('button', { name: '打开输入小窗' }).click();
    const helper = await opened;
    await expect(helper.getByRole('combobox', { name: '本次联系人' })).toBeDisabled();
    await expect(helper.getByRole('textbox', { name: '草稿' })).toBeDisabled();
    await manager.getByRole('button', { name: '前往设置' }).click();
    await expect(manager.getByText('检测到既有本人资料，但本次运行尚未绑定本人身份。请检查受控配置后重新连接。', { exact: true })).toBeVisible();
  });
});
