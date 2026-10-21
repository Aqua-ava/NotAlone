import { expect, type Page } from '@playwright/test';

export async function openFileImport(manager: Page): Promise<void> {
  const navigation = manager.getByRole('navigation', { name: '管理导航' });
  await expect(navigation.getByRole('button', { name: /历史导入|从文件导入/ })).toHaveCount(0);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  const advanced = manager.locator('details').filter({ has: manager.locator('summary', { hasText: '高级' }) });
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click();
  await advanced.getByRole('button', { name: '从文件导入', exact: true }).click();
  await expect(manager.getByRole('heading', { name: '从文件导入', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page');
}

// 新建联系人与导入资料分开确认；归属始终经主窗口顶部选择。
export async function createImportContact(manager: Page, displayName: string): Promise<void> {
  await manager.getByRole('button', { name: '联系人', exact: true }).click();
  const picker = manager.getByRole('combobox', { name: '本次联系人', exact: true });
  if (!await picker.getByRole('option', { name: displayName, exact: true }).count()) {
    await manager.getByRole('textbox', { name: '联系人展示名称', exact: true }).fill(displayName);
    await manager.getByRole('button', { name: '创建联系人', exact: true }).click();
  }
  await expect(picker.getByRole('option', { name: displayName, exact: true })).toHaveCount(1);
  await picker.selectOption({ label: displayName });
}
