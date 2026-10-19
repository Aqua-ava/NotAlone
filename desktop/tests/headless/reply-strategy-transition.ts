import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { fillWorkspaceThought, generateWorkspace } from '../workspace-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function replyStrategyTransition(browser: Browser, origin: string) {
  for (const firstAction of ['express', 'suggest'] as const) {
    const nextAction = firstAction === 'express' ? 'suggest' : 'express';
    const name = `${firstAction}切换${nextAction}直接生成并幂等重试`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      const firstThought = firstAction === 'express' ? '只说明本次收到消息，不继续等待。' : '';
      await fillWorkspaceThought(helper, firstThought);
      await rewriteBackend.plan({ count: 1, prefix: '第一次直接候选' });
      await generateWorkspace(helper, firstAction);
      const editor = helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ });
      await expect(editor).toHaveValue('第一次直接候选（说法1）。');
      const firstRequest = replyTransport.requests.at(-1)!;
      const firstResult = replyTransport.results.at(-1)!;
      expect(firstRequest).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace',
        workspace_action: firstAction, draft_text: firstThought, include_relationship_context: true } });

      const nextThought = '表示愿意等待，但不增加承诺。';
      await fillWorkspaceThought(helper, nextThought);
      await rewriteBackend.plan({ count: 1, prefix: '切换动作后的候选' });
      replyTransport.nextReply = 'drop';
      await generateWorkspace(helper, nextAction);
      await expect(helper.getByRole('alert').filter({ hasText: '未收到生成结果' })).toBeVisible();
      const nextRequest = replyTransport.requests.at(-1)!;
      const nextResult = replyTransport.results.at(-1)!;
      expect(nextRequest.idempotency_key).not.toBe(firstRequest.idempotency_key);
      expect(nextRequest).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace',
        workspace_action: nextAction, draft_text: nextThought } });
      expect(nextResult.data.reply_request_id).not.toBe(firstResult.data.reply_request_id);
      const beforeRetry = await rewriteBackend.command('observations');
      expect(beforeRetry.payloads).toHaveLength(2);
      expect((beforeRetry.payloads as object[]).at(-1)).toMatchObject({ input_mode: 'workspace',
        fidelity_contract: { current_intent: nextAction === 'express' ? { text: nextThought } : null } });
      await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
      await expect(editor).toHaveValue('切换动作后的候选（说法1）。');
      expect(replyTransport.requests.at(-1)).toEqual(nextRequest);
      expect(replyTransport.results.at(-1)).toEqual(nextResult);
      expect((await rewriteBackend.command('observations')).payloads).toEqual(beforeRetry.payloads);
      expect(replyTransport.explorationRequests).toEqual([]);
      await expect(helper.getByRole('region', { name: '理解与方向', exact: true })).toHaveCount(0);

      // 即使没有修改输入，明确再次点击动作也必须创建新请求；只有重试复用旧请求。
      await rewriteBackend.plan({ count: 1, prefix: '再次明确请求候选' });
      await generateWorkspace(helper, nextAction);
      await expect(editor).toHaveValue('再次明确请求候选（说法1）。');
      expect(replyTransport.requests.at(-1)!.idempotency_key).not.toBe(nextRequest.idempotency_key);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
    });
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
