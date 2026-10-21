import { expect } from '@playwright/test';

// 所有联系人测试使用公开下拉交互；按 ID 选择可保持同名联系人隔离。
export async function selectContact(picker, target) {
  const page = picker.page();
  if (await picker.getAttribute('aria-expanded') !== 'true') await picker.click();
  const search = page.getByRole('searchbox', { name: '搜索联系人', exact: true });
  await search.fill(typeof target === 'string' ? '' : target.label);
  const results = page.getByRole('listbox', { name: '联系人搜索结果', exact: true });
  const option = typeof target === 'string'
    ? results.locator(`[role="option"][data-contact-id="${target}"]`)
    : results.getByRole('option', { name: target.label, exact: true });
  await option.click();
  await expect(search).toHaveCount(0);
}

export async function expectContactOption(picker, name, options = {}) {
  if (await picker.getAttribute('aria-expanded') !== 'true') await picker.click();
  const page = picker.page();
  const search = page.getByRole('searchbox', { name: '搜索联系人', exact: true });
  await search.fill('');
  await expect(page.getByRole('listbox', { name: '联系人搜索结果', exact: true })
    .getByRole('option', { name, exact: true })).toHaveCount(1, options);
  await search.press('Escape');
}
