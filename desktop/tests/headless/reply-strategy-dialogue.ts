import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 每场经生产页面/controller、认证HTTP和正式隔离PG；模型只返回合成结构。
export async function replyStrategyDialogue(browser: Browser, origin: string) {
  for (const action of ['帮我想想', '帮我表达']) {
    process.stdout.write(`page_test_scenario: ${action}背景来源完整、补充不冒充立场、删除后失效\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const contactId = rewriteBackend.data.contact_ids[0];
      const material = await rewriteBackend.command('strategy_many_sources');
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
      await expect(idea).toBeEnabled();
      if (action === '帮我表达') await idea.fill('这次只是了解近况，没有安排承诺。');
      await helper.getByText('最近聊天 · 查看／补充', { exact: true }).click();
      await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方：最近有点忙，想了解近况。');
      await rewriteBackend.plan({ count: 1, prefix: '根据本次背景的合成建议', basis: '根据最近对话提供一种可选说法。' });
      await helper.getByRole('button', { name: action, exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('根据本次背景的合成建议（说法1）。');
      await expect(helper.getByText('根据最近对话提供一种可选说法。', { exact: true })).toBeVisible();
      expect(replyTransport.explorationRequests).toHaveLength(0);
      const generated = replyTransport.results.at(-1)!.data;
      const evidence = await rewriteBackend.request(`/api/contacts/${contactId}/replies/${generated.reply_request_id}/evidence`);
      expect(evidence.status).toBe(200);
      expect(evidence.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ evidence_id: material.memory_id })]));
      const memories = await rewriteBackend.request(`/api/contacts/${contactId}/memories`);
      expect(memories.status).toBe(200);
      const memory = (memories.data.memories as Array<{ memory_id: string; source_ids: string[] }>)
        .find(item => item.memory_id === material.memory_id)!;
      expect(memory).toBeDefined();
      expect([...memory.source_ids].sort()).toEqual([...(material.source_ids as string[])].sort());
      expect(memory.source_ids).toHaveLength(21);
      expect(JSON.stringify(evidence.data)).not.toContain('乙的私密合成历史');
      expect(JSON.stringify(evidence.data)).not.toContain('另一用户的私密合成历史');
      const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ input_mode: 'workspace', context_text: '对方：最近有点忙，想了解近况。',
        fidelity_contract: { current_intent: action === '帮我表达'
          ? { source: 'draft_text', text: '这次只是了解近况，没有安排承诺。' } : null } });
      const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}`);
      expect(saved.status).toBe(200);
      expect(JSON.stringify(saved.data)).toContain(generated.reply_request_id);
      // 删除实际被这组建议使用的背景来源；独立想法仍由用户持有。
      const sourceId = (material.source_ids as string[])[0];
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '来源与过程');
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${sourceId}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      await expect(idea).toHaveValue(action === '帮我表达' ? '这次只是了解近况，没有安排承诺。' : '');
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    });
  }
}

export async function replyStrategyInvalidation(browser: Browser, origin: string) {
  for (const change of ['想法', '聊天背景', '本次要求']) {
    process.stdout.write(`page_test_scenario: 修改${change}保留旧候选，点击后才创建新输入\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
      await expect(idea).toBeEnabled();
      await helper.getByText('最近聊天 · 查看／补充', { exact: true }).click();
      await helper.getByText('语气和本次要求', { exact: true }).click();
      await rewriteBackend.plan({ count: 1, prefix: '原背景建议' });
      await helper.getByRole('button', { name: '帮我想想', exact: true }).click();
      const candidate = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
      await expect(candidate).toHaveValue('原背景建议（说法1）。');
      const first = replyTransport.requests.at(-1)!;
      if (change === '想法') await idea.fill('新的明确想法：只说明近况。');
      else if (change === '聊天背景') await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方：今天终于忙完了。');
      else await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('自然简短，不增加承诺。');
      await expect(candidate).toHaveValue('原背景建议（说法1）。');
      expect(replyTransport.requests).toHaveLength(1);
      await rewriteBackend.plan({ count: 1, prefix: '输入更新后的合成候选' });
      await helper.getByRole('button', { name: change === '想法' ? '帮我表达' : '帮我想想', exact: true }).click();
      await expect(candidate).toHaveValue('输入更新后的合成候选（说法1）。');
      const latest = replyTransport.requests.at(-1)!;
      expect(latest.idempotency_key).not.toBe(first.idempotency_key);
      expect(latest.content).toMatchObject(change === '想法' ? { workspace_action: 'express', draft_text: '新的明确想法：只说明近况。' }
        : change === '聊天背景' ? { context_text: '对方：今天终于忙完了。' } : { user_instruction: '自然简短，不增加承诺。' });
      expect(replyTransport.explorationRequests).toHaveLength(0);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
    });
  }
}
