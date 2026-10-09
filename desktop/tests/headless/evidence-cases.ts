import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';

// 点击生产页面，经具名控制器读取真实 HTTP/PG 的生成快照；不读取 React 私有状态。
async function draftEvidence({ manager, helper, rewriteBackend }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('这是本次明确输入的合成草稿。');
  await rewriteBackend.plan({ count: 1, prefix: '依据验收候选' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('依据验收候选（说法1）。');
  const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(evidence).toHaveCount(0);
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(evidence.getByText('这是本次明确输入的合成草稿。', { exact: true })).toBeVisible();
  await expect(evidence.getByText('用户草稿', { exact: true })).toBeVisible();
  await expect(evidence.getByText('本候选已引用', { exact: true })).toBeVisible();
  await expect(evidence.getByText('来源时间未知', { exact: true })).toBeVisible();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我修改的措辞不改生成依据。');
  await expect(evidence.getByText('这是本次明确输入的合成草稿。', { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '收起候选1依据', exact: true }).click();
  await expect(evidence).toHaveCount(0);
}

export async function replyEvidence(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 默认折叠与真实草稿依据快照\n');
  await withRewritePages(browser, origin, draftEvidence);
  process.stdout.write('page_test_scenario_passed: 默认折叠与真实草稿依据快照\n');
}
