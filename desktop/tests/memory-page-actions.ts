import { expect, type Locator, type Page } from '@playwright/test';

export type MemoryCategory = '联系人记忆' | '本人记忆' | '待确认候选' | '联系人概览' | '本人概览';

// 经公开入口和详情操作，保留各业务测试对同一资料范围的访问。
export async function selectMemoryCategory(page: Page, category: MemoryCategory) {
  if (!await page.getByRole('navigation', { name: '记忆分类', exact: true }).isVisible())
    await page.getByRole('button', { name: '记忆', exact: true }).click();
  const owner = ['本人记忆', '本人概览'].includes(category);
  const entry = owner ? '我' : category === '待确认候选' ? '待确认' : '对方';
  const button = page.getByRole('navigation', { name: '记忆分类', exact: true }).getByRole('button', { name: entry, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const detail = ['联系人概览', '本人概览'].includes(category) ? '版本历史' : null;
  if (detail) await expandMemorySection(page, detail);
}

export async function expandMemorySection(page: Page, name: string) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

export async function expandMemoryDetails(card: Locator) {
  await expect(card).toBeVisible();
  const button = card.getByRole('button', { name: /^查看来源与版本：/ });
  if (await button.count()) {
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  } else {
    const summary = card.locator('summary').filter({ hasText: /^查看详情$/ });
    if (await summary.locator('..').getAttribute('open') === null) await summary.click();
  }
}

export async function openImportManagement(page: Page) {
  if (await page.getByRole('region', { name: '已导入资料', exact: true }).isVisible()) return;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expandMemorySection(page, '高级');
  await page.getByRole('button', { name: '从文件导入', exact: true }).click();
  await expect(page.getByRole('region', { name: '已导入资料', exact: true })).toBeVisible();
}

export async function openDeveloperTraces(page: Page) {
  if (await page.getByRole('region', { name: '提取与来源处理过程', exact: true }).isVisible()) return;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expandMemorySection(page, '高级');
  await expandMemorySection(page, '开发者调试');
}

export async function openMemoryTrace(page: Page, text: string, category: MemoryCategory = '联系人记忆') {
  await selectMemoryCategory(page, category);
  const card = page.getByRole('article').filter({ has: page.getByText(text, { exact: true }) });
  await expandMemoryDetails(card);
  const candidate = category === '待确认候选';
  const identifier = await card.getByText(new RegExp(`^${candidate ? '候选' : '记忆'}标识：`)).textContent();
  const recordId = identifier!.split('：')[1].trim();
  await openDeveloperTraces(page);
  const panel = page.getByRole('region', { name: '提取与来源处理过程', exact: true });
  await panel.getByRole('combobox', { name: '过程类型' }).selectOption('memory-traces');
  await panel.getByRole('combobox', { name: '记录类型' }).selectOption(candidate ? 'candidate' : category === '本人记忆' ? 'owner_memory' : 'contact_memory');
  await panel.getByRole('textbox', { name: '记录标识' }).fill(recordId);
  await panel.getByRole('button', { name: '查找记录过程', exact: true }).click();
}

export async function expandOverviewDetails(card: Locator) {
  const summary = card.getByText('查看逐项来源与修订', { exact: true });
  const details = summary.locator('..');
  if (await details.getAttribute('open') === null) await summary.click();
}
