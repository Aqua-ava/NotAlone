import { expect, type Locator, type Page } from '@playwright/test';

export type MemoryCategory = '联系人记忆' | '本人记忆' | '待确认候选' | '主题资料' | '本人主题资料' | '联系人概览' | '本人概览' | '来源与过程';

// 经公开入口和详情操作，保留各业务测试对同一资料范围的访问。
export async function selectMemoryCategory(page: Page, category: MemoryCategory) {
  const owner = ['本人记忆', '本人主题资料', '本人概览'].includes(category);
  const entry = owner ? '我' : category === '待确认候选' ? '待确认' : '对方';
  const button = page.getByRole('navigation', { name: '记忆分类', exact: true }).getByRole('button', { name: entry, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const detail = ['联系人概览', '本人概览', '来源与过程'].includes(category) ? '历史与来源'
      : ['主题资料', '本人主题资料'].includes(category) ? '整理设置与状态' : null;
  if (['主题资料', '本人主题资料'].includes(category)) await expandMemorySection(page, '查看摘要');
  if (detail) await expandMemorySection(page, detail);
}

export async function expandMemorySection(page: Page, name: string) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

export async function expandMemoryDetails(card: Locator) {
  const button = card.getByRole('button', { name: /^查看来源与版本：/ });
  if (await button.count()) {
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  } else {
    const summary = card.locator('summary').filter({ hasText: /^查看详情$/ });
    if (await summary.locator('..').getAttribute('open') === null) await summary.click();
  }
}

export async function openMemoryTrace(page: Page, text: string, category: MemoryCategory = '联系人记忆') {
  await selectMemoryCategory(page, category);
  const card = page.getByRole('article').filter({ has: page.getByText(text, { exact: true }) });
  await expandMemoryDetails(card);
  await card.getByRole('button', { name: category === '本人记忆' ? '查看来源过程' : `查看提取过程：${text}`, exact: true }).click();
}

export async function expandOverviewDetails(card: Locator) {
  const summary = card.getByText('查看逐项来源与修订', { exact: true });
  const details = summary.locator('..');
  if (await details.getAttribute('open') === null) await summary.click();
}
