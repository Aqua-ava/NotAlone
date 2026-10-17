import { expect, type Locator, type Page } from '@playwright/test';

export type MemoryCategory = '联系人记忆' | '本人记忆' | '待确认候选' | '主题资料' | '联系人概览' | '本人概览' | '来源与过程';

// 经公开分类控件操作，避免测试依赖多个面板同时挂载。
export async function selectMemoryCategory(page: Page, category: MemoryCategory) {
  const button = page.getByRole('navigation', { name: '记忆分类', exact: true }).getByRole('button', { name: category, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

export async function expandMemoryDetails(card: Locator) {
  const button = card.getByRole('button', { name: /^查看来源与版本：/ });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}

export async function openMemoryTrace(page: Page, text: string, category: MemoryCategory = '联系人记忆') {
  await selectMemoryCategory(page, category);
  const card = page.getByRole('article').filter({ has: page.getByText(text, { exact: true }) });
  await expandMemoryDetails(card);
  await card.getByRole('button', { name: `查看提取过程：${text}`, exact: true }).click();
}

export async function expandOverviewDetails(card: Locator) {
  const details = card.locator('details').filter({ has: card.getByText('查看逐项来源与修订', { exact: true }) });
  if (await details.getAttribute('open') === null) await details.getByText('查看逐项来源与修订', { exact: true }).click();
}
