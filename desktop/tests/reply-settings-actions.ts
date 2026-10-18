import { expect, type Page } from '@playwright/test';

// 经真实折叠控件展开设置，重复调用不会把已展开区域关闭。
export async function ensureReplySettingsOpen(helper: Page, field: '策略选择' | '本次精确场景'): Promise<void> {
  const control = helper.getByRole(field === '策略选择' ? 'combobox' : 'textbox', {
    name: field, exact: true, includeHidden: true,
  });
  const settings = helper.locator('details').filter({ has: control });
  await expect(settings).toHaveCount(1);
  if (await settings.getAttribute('open') === null) await settings.locator('summary').click();
  await expect(control).toBeVisible();
}
