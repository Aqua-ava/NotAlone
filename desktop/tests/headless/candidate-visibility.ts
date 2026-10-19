import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function candidateVisibility(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 默认小窗生成后直接看见当前候选，历史不会挡住结果\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await helper.setViewportSize({ width: 680, height: 520 });
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    const candidate = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    for (let turn = 1; turn <= 3; turn++) {
      const draft = `合成第${turn}轮：今晚稍晚回复。`;
      await helper.getByRole('textbox', { name: '草稿', exact: true }).fill(draft);
      await expect.poll(async () => (await helper.evaluate(() => window.notalone.contacts.getState())).draft).toBe(draft);
      await rewriteBackend.plan({ count: 2, prefix: `合成当前第${turn}轮` });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(candidate).toHaveValue(`合成当前第${turn}轮（说法1）。`, { timeout: 15000 });
      // 不点击结果、不手工滚动；必须由生成完成后的产品行为使编辑框进入视口。
      await expect(candidate).toBeInViewport({ ratio: 0.8 });
      await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).phase).toBe('ready');
    }
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('轻松回应，不增加承诺。');
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).direction).toBe('轻松回应，不增加承诺。');
    await rewriteBackend.plan({ count: 2, prefix: '合成回应候选直接可见' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(candidate).toHaveValue('合成回应候选直接可见（说法1）。', { timeout: 10000 }).catch(async (error) => {
      const current = await helper.evaluate(() => window.notalone.replies.getState());
      process.stderr.write(`page_test_generation_state: ${JSON.stringify({ phase: current.phase, error: current.errorCode,
        responses: replyTransport.results.map(item => ({ status: item.status, error: item.data.error })) })}\n`);
      throw error;
    });
    await expect(candidate).toBeInViewport({ ratio: 0.8 }).catch(async (error) => {
      await helper.screenshot({ path: 'artifacts/headless-pages/candidate-visibility-failed.png' });
      process.stderr.write(`page_test_layout: ${JSON.stringify(await helper.evaluate(() => {
        const workspace = document.querySelector('.ime-workspace')!;
        const candidate = document.querySelector('[aria-label="候选1编辑文本"]')!;
        return { scrollTop: workspace.scrollTop, workspace: workspace.getBoundingClientRect().toJSON(),
          candidate: candidate.getBoundingClientRect().toJSON() };
      }))}\n`);
      throw error;
    });
    await expect(helper.locator('.ime-header')).toBeInViewport({ ratio: 1 });
    const footer = helper.locator('.ime-footer');
    await expect(footer).toBeInViewport({ ratio: 1 });
    await helper.screenshot({ path: 'artifacts/headless-pages/candidate-visibility.png' });
    await rewriteBackend.plan({ count: 1, fault: 'failure' });
    await helper.getByRole('button', { name: '重新生成', exact: true }).click();
    const failure = helper.getByRole('alert').filter({ hasText: '本次生成失败' });
    await expect(failure).toBeVisible();
    await expect(failure).toBeInViewport({ ratio: 1 });
    await helper.screenshot({ path: 'artifacts/headless-pages/candidate-failure-visible.png' });
  });
  process.stdout.write('page_test_scenario_passed: 默认小窗的草稿、回应和多轮历史候选直接可见\n');
}
