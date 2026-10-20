import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 原“先澄清再确认”入口已退役；本次补充直接随动作生成，失败沿同一输入重试。
export async function replyStrategyConfirmedClarification(browser: Browser, origin: string) {
  for (const action of ['帮我想想', '帮我表达']) {
    process.stdout.write(`page_test_scenario: ${action}补充背景、失败重试与本次意图保真\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
      await expect(idea).toBeEnabled();
      if (action === '帮我表达') await idea.fill('表示愿意等待，但不增加承诺。');
      await helper.getByText('最近聊天 · 查看／补充', { exact: true }).click();
      await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方：今晚会晚一点回复。');
      await helper.getByText('语气和本次要求', { exact: true }).click();
      await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('不增加其他承诺。');
      await rewriteBackend.plan({ fault: 'failure' });
      await helper.getByRole('button', { name: action, exact: true }).click();
      await expect(helper.getByRole('button', { name: '重试同一次生成', exact: true })).toBeEnabled();
      const failed = replyTransport.requests.at(-1);
      await rewriteBackend.plan({ count: 1, prefix: '结合补充直接生成' });
      await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('结合补充直接生成（说法1）。');
      expect(replyTransport.requests.at(-1)).toEqual(failed);
      expect(replyTransport.explorationRequests).toHaveLength(0);
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(2);
      expect(payloads.at(-1)).toMatchObject({ input_mode: 'workspace', context_text: '对方：今晚会晚一点回复。',
        user_instruction: '不增加其他承诺。', fidelity_contract: { current_intent: action === '帮我表达'
          ? { source: 'draft_text', text: '表示愿意等待，但不增加承诺。' } : null } });
      await expect(helper.getByRole('textbox', { name: '关键问题回答', exact: true })).toHaveCount(0);
      await expect(helper.getByRole('region', { name: '连续修改', exact: true })).toBeVisible();
    });
  }
}
