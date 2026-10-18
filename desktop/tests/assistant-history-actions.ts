import { expect, type Page } from '@playwright/test';

/** 历史操作由场景明确展开；不改变通用夹具或页面的默认折叠状态。 */
export async function openAssistantHistory(page: Page) {
  const history = page.getByRole('region', { name: '助手会话', exact: true }).locator('details.session-browser');
  await expect(history).toBeAttached();
  if (!await history.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await history.locator(':scope > summary').click();
  }
}

/** 仅在场景需要核对历史正文时，逐条点击展开已读取的记录。 */
export async function expandSavedDiscussion(page: Page) {
  await openAssistantHistory(page);
  await expect.poll(() => page.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase))
    .not.toBe('loading');
  const records = page.locator('.session-history .session-entry-details');
  for (let index = 0; index < await records.count(); index += 1) {
    const record = records.nth(index);
    if (!await record.evaluate((element) => (element as HTMLDetailsElement).open)) {
      await record.locator(':scope > summary').click();
    }
  }
}
