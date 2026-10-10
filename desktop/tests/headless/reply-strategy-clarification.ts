import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function replyStrategyConfirmedClarification(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) {
    process.stdout.write(`page_test_scenario: ${scene}先确认意愿、关键应答失败重试、继续生成\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想关心近况，还没有决定承诺范围。');
      await rewriteBackend.plan({ explore: { question: { text: '本次是否不增加其他承诺？', impact: 'commitment' } } });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      await expect(helper.getByRole('group', { name: '关键澄清', exact: true })).toBeVisible();
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      await expect(strategy).toContainText('已确认本次意愿');
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
      await helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('不增加其他承诺，只保留刚才确认的意愿。');
      await rewriteBackend.plan({ fault: 'failure' });
      await helper.getByRole('button', { name: '提交回答', exact: true }).click();
      await expect(helper.getByRole('alert')).toContainText('方向建议暂不可用');
      const failedAnswer = replyTransport.explorationRequests.at(-1);
      await rewriteBackend.plan({ explore: { understanding: '关键回答只补信息，保留先前确认的意愿。' } });
      await rewriteBackend.plan({ count: 1, prefix: '已确认意愿且澄清完成' });
      await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('已确认意愿且澄清完成（说法1）。');
      expect(replyTransport.explorationRequests.at(-1)).toEqual(failedAnswer);
      const generated = replyTransport.explorationResults.at(-1)!;
      expect(generated.status).toBe(200);
      expect(generated.data.kind).toBe('generated');
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(4);
      expect(payloads.at(-1)).toMatchObject({ clarification_answer: '不增加其他承诺，只保留刚才确认的意愿。',
        fidelity_contract: { current_intent: { text: '表示愿意等待，但不增加承诺。' } } });
      const count = replyTransport.explorationResults.length;
      await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
      await expect.poll(() => replyTransport.explorationResults.length).toBe(count + 1);
      expect(replyTransport.explorationResults.at(-1)).toEqual(generated);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(4);
    });
  }
}
