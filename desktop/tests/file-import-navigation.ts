import { expect, type Page } from '@playwright/test';

export async function openFileImport(manager: Page): Promise<void> {
  const navigation = manager.getByRole('navigation', { name: '管理导航' });
  await expect(navigation.getByRole('button', { name: /历史导入|从文件导入/ })).toHaveCount(0);
  await navigation.getByRole('button', { name: '设置', exact: true }).click();
  const advanced = manager.locator('details').filter({ has: manager.locator('summary', { hasText: '高级' }) });
  if (await advanced.getAttribute('open') === null) await advanced.locator('summary').click();
  await advanced.getByRole('button', { name: '从文件导入', exact: true }).click();
  await expect(manager.getByRole('heading', { name: '从文件导入', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page');
}
