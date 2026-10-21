import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { fillWorkspaceThought, fillWorkspaceInstruction, setWorkspaceContext, generateWorkspace } from '../workspace-actions';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

const hardwareDirection = '转向硬件话题，询问最近在用什么设备，不增加承诺。';

export async function directionGenerationFeedback(browser: Browser, origin: string) {
  for (const change of ['本人想法', '本次要求', '补充背景', '排除消息', '关闭背景']) {
    process.stdout.write(`page_test_scenario: ${change}保留并标记旧候选，明确点击后生成新候选\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      await fillWorkspaceThought(helper, '轻松接梗，不讨论新的话题。');
      await setWorkspaceContext(helper, true);
      await rewriteBackend.plan({ count: 1, prefix: '前一组接梗候选' });
      await generateWorkspace(helper);
      const candidate = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
      await expect(candidate).toHaveValue('前一组接梗候选（说法1）。');
      const oldResult = replyTransport.results.at(-1)!;
      if (change !== '本次要求') await fillWorkspaceThought(helper, hardwareDirection);
      if (change === '本次要求') await fillWorkspaceInstruction(helper, '简短一点，不增加承诺。');
      if (change === '补充背景') await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方：我最近换了一个键盘，只想聊现有设备。');
      else if (change === '排除消息') await helper.getByRole('checkbox', { name: /使用消息：甲的私密合成历史/ }).uncheck();
      else if (change === '关闭背景') await setWorkspaceContext(helper, false);
      const previous = helper.getByRole('region', { name: '候选回复', exact: true })
        .getByText('上一组候选，尚未按当前输入重新生成。', { exact: true });
      await expect(previous).toBeVisible();
      await expect(candidate).toHaveValue('前一组接梗候选（说法1）。');
      const snapshot = (await helper.evaluate(() => window.notalone.replies.getState())).result!;
      expect(snapshot.input).toMatchObject({ draftText: '轻松接梗，不讨论新的话题。' });
      expect(replyTransport.requests).toHaveLength(1);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
      await rewriteBackend.plan({ count: 1, prefix: '新的硬件话题候选' });
      await generateWorkspace(helper);
      await expect(candidate).toHaveValue('新的硬件话题候选（说法1）。');
      await expect(previous).toHaveCount(0);
      expect(replyTransport.results.at(-1)!.data.reply_request_id).not.toBe(oldResult.data.reply_request_id);
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(2);
      expect(payloads.at(-1)).toMatchObject({ input_mode: 'workspace', workspace_action: 'express',
        fidelity_contract: { current_intent: { text: change === '本次要求' ? '轻松接梗，不讨论新的话题。' : hardwareDirection } } });
      if (change === '本次要求') expect(replyTransport.requests.at(-1)).toMatchObject({ content: { user_instruction: '简短一点，不增加承诺。' } });
      expect(replyTransport.explorationRequests).toHaveLength(0);
    });
    process.stdout.write(`page_test_scenario_passed: ${change}的旧候选标记与显式生成\n`);
  }
  process.stdout.write('page_test_scenario: 重开恢复的候选保留上次生成标记，输入新方向后明确生成\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }, host, userData) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
    await confirmHelperContact(helper, contactId);
    await fillWorkspaceThought(helper, '上一轮先轻松接梗。');
    await rewriteBackend.plan({ count: 1, prefix: '重开前保存的接梗候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
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
      await nextManager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
      const nextHelper = await reopened.open('helper');
      await confirmHelperContact(nextHelper, contactId);
      const candidates = nextHelper.getByRole('region', { name: '候选回复', exact: true });
      await expect(candidates.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true }))
        .toHaveValue('重开前保存的接梗候选（说法1）。', { timeout: 15000 });
      await fillWorkspaceThought(nextHelper, hardwareDirection);
      const recovered = await nextHelper.evaluate(() => window.notalone.replies.getState());
      expect(recovered.result).toBeNull();
      expect(recovered.savedSession?.sessionId).toBe(oldResult.assistantSessionId);
      expect(recovered.exploration.result).toBeNull();
      const previous = candidates.getByText('上一组候选，尚未按当前输入重新生成。', { exact: true });
      await expect(previous).toBeVisible();
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
      await rewriteBackend.plan({ count: 1, prefix: '重开后按硬件方向生成' });
      await nextHelper.getByRole('button', { name: '帮我表达', exact: true }).click();
      await expect(candidates.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
        .toHaveValue('重开后按硬件方向生成（说法1）。', { timeout: 15000 });
      await expect(previous).toHaveCount(0);
      const current = (await nextHelper.evaluate(() => window.notalone.replies.getState())).result!;
      expect(current.replyRequestId).not.toBe(oldResult.replyRequestId);
      expect(current.assistantSessionId).toBe(oldResult.assistantSessionId);
      expect(current.input).toMatchObject({ mode: 'rewrite_draft', inputKind: 'workspace', workspaceAction: 'express', draftText: hardwareDirection });
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(2);
      expect(payloads.at(-1)).toMatchObject({ fidelity_contract: { current_intent: { text: hardwareDirection } } });
    } finally { await reopened.close(); }
  });
  process.stdout.write('page_test_scenario_passed: 纯已保存候选恢复后的旧标记与显式新生成\n');
}
