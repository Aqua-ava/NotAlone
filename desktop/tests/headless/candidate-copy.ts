import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';

// 操作系统复制边界由本轮宿主提供合成接收端，业务生成和快照仍经过真实 HTTP/PG。
async function copyCurrentCandidate({ manager, helper, rewriteBackend }: RewritePages, copiedTexts: string[]) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('只说明今天到不了，不增加其他承诺。');
  await rewriteBackend.plan({ count: 1, prefix: '复制原候选' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('复制原候选（说法1）。');
  const edited = '今天确实到不了，下次时间再联系。';
  await editor.fill(edited);
  await helper.getByRole('button', { name: '复制', exact: true }).click();
  await expect(helper.getByRole('status').filter({ hasText: '已复制当前编辑文本' })).toBeVisible();
  expect(copiedTexts).toEqual([edited]);
  await expect(editor).toHaveValue(edited);
  await helper.getByText('查看原候选', { exact: true }).click();
  await expect(helper.getByText('复制原候选（说法1）。', { exact: true })).toBeVisible();
}

// 首个反馈只沿用现有宿主；缺少复制入口的失败后再接通必要的系统输入适配。
export async function candidateCopy(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async (pages) => {
    await copyCurrentCandidate(pages, []);
  });
}
