import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

const hardwareDirection = '转向硬件话题，询问最近在用什么设备，不增加承诺。';
const options = [
  { label: '聊聊硬件', intent: hardwareDirection, reason: '本次想换一个轻松的话题。' },
  { label: '先结束话题', intent: '简短结束当前话题，不安排后续。', reason: '本次不想继续展开时适用。' },
];

export async function directionGenerationFeedback(browser: Browser, origin: string) {
  for (const [scene, hasQuestion] of [['回应消息', true], ['主动聊聊', true], ['回应消息', false]] as const) {
    process.stdout.write(`page_test_scenario: ${scene}${hasQuestion ? '关键问题' : '仅有歧义'}未清时标明旧候选，澄清后显式生成\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      const inputName = scene === '回应消息' ? '表达方向' : '主动目的';
      const oldDirection = '轻松接梗，不讨论新的话题。';
      await helper.getByRole('textbox', { name: inputName, exact: true }).fill(oldDirection);
      await expect.poll(async () => {
        const state = await helper.evaluate(() => window.notalone.replies.getState());
        return scene === '回应消息' ? state.direction : state.purpose;
      }).toBe(oldDirection);
      await rewriteBackend.plan({ count: 1, prefix: '前一组接梗候选' });
      const generate = helper.getByRole('button', { name: '生成候选', exact: true });
      await generate.click();
      const candidate = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
      await expect(candidate).toHaveValue('前一组接梗候选（说法1）。', { timeout: 15000 });
      const oldResult = replyTransport.results.at(-1)!;
      await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).phase).toBe('ready');
      await rewriteBackend.plan({ explore: { understanding: '可以转向硬件话题，但还需要明确聊天范围。', options,
        question: hasQuestion ? { text: '本次只聊现有设备，不讨论购买安排，可以吗？', impact: 'commitment' } : null,
        ambiguities: ['是否涉及购买安排尚未明确。'] } });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      await expect(strategy).toContainText('可以转向硬件话题，但还需要明确聊天范围。');
      await helper.getByRole('button', { name: '确认方向：聊聊硬件', exact: true }).click();
      await expect(strategy).toContainText(`已确认本次意愿：${hardwareDirection}`);
      await expect(generate).toBeDisabled();
      await expect(helper.getByText(hasQuestion ? '还有关键问题，尚未生成新候选' : '仍有待澄清的信息，尚未生成新候选', { exact: true })).toBeVisible();
      if (hasQuestion) {
        await helper.getByRole('button', { name: '去回答关键问题', exact: true }).click();
        const answer = helper.getByRole('textbox', { name: '关键问题回答', exact: true });
        await expect(answer).toBeFocused();
        await expect(answer).toBeInViewport({ ratio: 1 });
      }
      const candidates = helper.getByRole('region', { name: '候选回复', exact: true });
      const previous = candidates.getByText('上一组候选，尚未按当前输入重新生成。', { exact: true });
      await expect(previous).toBeVisible();
      await expect(candidate).toHaveValue('前一组接梗候选（说法1）。');
      expect(replyTransport.requests).toHaveLength(1);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);

      await rewriteBackend.plan({ explore: { understanding: '只聊现有设备，目的和承诺范围已经明确。', options,
        question: null, ambiguities: [] } });
      if (hasQuestion) {
        await helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('只聊现有设备，不讨论购买安排。');
        await helper.getByRole('button', { name: '提交回答', exact: true }).click();
      } else await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(strategy).toContainText('只聊现有设备，目的和承诺范围已经明确。');
      await expect(generate).toBeEnabled();
      // 回答、确认和更新理解只推进方向；旧结果直到明确生成完成才被替换。
      await expect(candidate).toHaveValue('前一组接梗候选（说法1）。');
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
      await rewriteBackend.plan({ count: 1, prefix: '新的硬件话题候选' });
      await generate.click();
      await expect(candidate).toHaveValue('新的硬件话题候选（说法1）。', { timeout: 15000 });
      await expect(previous).toHaveCount(0);
      const generated = replyTransport.explorationResults.at(-1)!;
      expect(generated.status).toBe(200);
      expect(generated.data.kind).toBe('generated');
      const turn = generated.data.turn as { reply_request_id: string };
      expect(turn.reply_request_id).not.toBe(oldResult.data.reply_request_id);
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(4);
      expect(payloads.at(-1)).toMatchObject({ input_mode: scene === '回应消息' ? 'reply_to_message' : 'initiate_conversation',
        fidelity_contract: { current_intent: { text: hardwareDirection } } });
      expect(replyTransport.explorationRequests.at(-1)).toMatchObject({ generate: true });
    });
    process.stdout.write(`page_test_scenario_passed: ${scene}${hasQuestion ? '关键问题' : '仅有歧义'}的旧候选标记与显式生成\n`);
  }
  process.stdout.write('page_test_scenario: 重开恢复的候选保留上次生成标记，输入新方向后明确生成\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }, host, userData) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('上一轮先轻松接梗。');
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).direction).toBe('上一轮先轻松接梗。');
    await rewriteBackend.plan({ count: 1, prefix: '重开前保存的接梗候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('重开前保存的接梗候选（说法1）。', { timeout: 15000 });
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
    const oldResult = (await helper.evaluate(() => window.notalone.replies.getState())).result!;
    await host.close();
    await rewriteBackend.command('restart');
    const reopened = new PageHost(await browser.newContext(), origin, userData);
    try {
      await reopened.backend.connect();
      const nextManager = await reopened.open('manager');
      await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      const nextHelper = await reopened.open('helper');
      await confirmHelperContact(nextHelper, contactId);
      const candidates = nextHelper.getByRole('region', { name: '候选回复', exact: true });
      await expect(candidates.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true }))
        .toHaveValue('重开前保存的接梗候选（说法1）。', { timeout: 15000 });
      await nextHelper.getByRole('button', { name: '回应消息', exact: true }).click();
      await nextHelper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      await nextHelper.getByRole('textbox', { name: '表达方向', exact: true }).fill(hardwareDirection);
      await expect.poll(async () => (await nextHelper.evaluate(() => window.notalone.replies.getState())).direction).toBe(hardwareDirection);
      const recovered = await nextHelper.evaluate(() => window.notalone.replies.getState());
      expect(recovered.result).toBeNull();
      expect(recovered.savedSession?.sessionId).toBe(oldResult.assistantSessionId);
      expect(recovered.exploration.result).toBeNull();
      const previous = candidates.getByText('上一组候选，尚未按当前输入重新生成。', { exact: true });
      await expect(previous).toBeVisible();
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
      await rewriteBackend.plan({ count: 1, prefix: '重开后按硬件方向生成' });
      await nextHelper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(candidates.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
        .toHaveValue('重开后按硬件方向生成（说法1）。', { timeout: 15000 });
      await expect(previous).toHaveCount(0);
      const current = (await nextHelper.evaluate(() => window.notalone.replies.getState())).result!;
      expect(current.replyRequestId).not.toBe(oldResult.replyRequestId);
      expect(current.assistantSessionId).toBe(oldResult.assistantSessionId);
      expect(current.input).toMatchObject({ mode: 'reply_to_message', direction: hardwareDirection });
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(2);
      expect(payloads.at(-1)).toMatchObject({ fidelity_contract: { current_intent: { text: hardwareDirection } } });
    } finally { await reopened.close(); }
  });
  process.stdout.write('page_test_scenario_passed: 纯已保存候选恢复后的旧标记与显式新生成\n');
}
