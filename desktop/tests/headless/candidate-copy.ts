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

// 首个公开失败后，仅替换本轮操作系统复制接收端；生成与编辑状态保持生产路径。
export async function candidateCopy(browser: Browser, origin: string) {
  const copiedTexts: string[] = [];
  process.stdout.write('page_test_scenario: 当前编辑文本复制与原快照分离\n');
  await withRewritePages(browser, origin, async (pages) => {
    await copyCurrentCandidate(pages, copiedTexts);
  }, { async writeText(text) { copiedTexts.push(text); }, hideWindow() { throw new Error('单独复制不应收起。'); } });
  process.stdout.write('page_test_scenario_passed: 当前编辑文本复制与原快照分离\n');

  // 只在操作系统边界安排一次失败，观察实际页面保留编辑及成功之后才收起的顺序。
  const attempts: string[] = [];
  const completed: string[] = [];
  const actions: string[] = [];
  process.stdout.write('page_test_scenario: 复制失败保留编辑与重试成功后收起\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今天先这样，稍后再联系。');
    await rewriteBackend.plan({ count: 1, prefix: '失败后保留原候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('失败后保留原候选（说法1）。');
    const edited = '我先处理眼前的事情，稍后再联系你。';
    await editor.fill(edited);
    await helper.getByRole('button', { name: '复制并收起', exact: true }).click();
    await expect(helper.getByRole('alert')).toContainText('复制未确认，编辑文本仍保留，请重试。');
    await expect(editor).toHaveValue(edited);
    await expect(editor).toBeVisible();
    await expect(helper.getByText('合成系统原始错误不应回显。', { exact: true })).toHaveCount(0);
    await expect(helper.getByRole('status').filter({ hasText: '已复制当前编辑文本' })).toHaveCount(0);
    expect(attempts).toEqual([edited]);
    expect(completed).toEqual([]);
    expect(actions).toEqual([]);
    await helper.getByRole('button', { name: '复制并收起', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '已复制当前编辑文本' })).toBeVisible();
    expect(attempts).toEqual([edited, edited]);
    expect(completed).toEqual([edited]);
    expect(actions).toEqual(['write-completed', 'hide']);
    await expect(editor).toHaveValue(edited);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  }, {
    async writeText(text) {
      attempts.push(text);
      if (attempts.length === 1) throw new Error('合成系统原始错误不应回显。');
      await Promise.resolve();
      completed.push(text); actions.push('write-completed');
    },
    hideWindow() { actions.push('hide'); },
  });
  process.stdout.write('page_test_scenario_passed: 复制失败保留编辑与重试成功后收起\n');
}
