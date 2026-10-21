import { selectContact } from '../contact-picker-actions.mjs';
import { openImportManagement } from '../memory-page-actions';
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
      await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
      await confirmHelperContact(helper, contactId);
      const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
      await expect(idea).toBeEnabled();
      if (action === '帮我表达') await idea.fill('这次只是了解近况，没有安排承诺。');
      await helper.getByText('最近聊天 · 查看／补充', { exact: true }).click();
      await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方：这份合成已确认资料的二十一个来源，你怎么看？');
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
      expect(payloads[0]).toMatchObject({ input_mode: 'workspace', context_text: '对方：这份合成已确认资料的二十一个来源，你怎么看？',
        fidelity_contract: { current_intent: action === '帮我表达'
          ? { source: 'draft_text', text: '这次只是了解近况，没有安排承诺。' } : null } });
      const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}`);
      expect(saved.status).toBe(200);
      expect(JSON.stringify(saved.data)).toContain(generated.reply_request_id);
      // 删除实际被这组建议使用的背景来源；独立想法仍由用户持有。
      const sourceId = (material.source_ids as string[])[0];
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await openImportManagement(manager);
      const sources = manager.getByRole('region', { name: '已导入资料', exact: true });
      await expect.poll(() => manager.evaluate(async expected => {
        const state = await window.notalone.sources.getState();
        return state.contactId === expected.contactId && state.phase === 'ready'
          && expected.sourceIds.every(id => state.sources.some(source => source.sourceId === id));
      }, { contactId, sourceIds: material.source_ids as string[] })).toBe(true);
      const pagination = sources.getByRole('navigation', { name: '已导入资料分页', exact: true });
      const pageStatus = pagination.getByRole('status');
      await expect(pageStatus).toHaveText(/^共 \d+ 条 · 第 1 \/ \d+ 页$/);
      const source = sources.locator(`[data-source-id="${sourceId}"]`);
      // 合成来源的生成顺序不等于目录顺序；通过公开分页找到原定来源，不能只查第一页。
      async function revealOriginalSource(deadline?: number) {
        const wait = () => deadline === undefined ? {} : { timeout: Math.max(1, deadline - Date.now()) };
        await expect(pageStatus).toHaveText(/^共 \d+ 条 · 第 \d+ \/ \d+ 页$/, wait());
        const [, current, total] = (await pageStatus.innerText()).match(/第 (\d+) \/ (\d+) 页$/)!;
        for (let page = Number(current); page > 1; page -= 1) {
          await pagination.getByRole('button', { name: '上一页', exact: true }).click(wait());
          await expect(pageStatus).toHaveText(new RegExp(`第 ${page - 1} / ${total} 页$`), wait());
        }
        for (let page = 1; page < Number(total) && await source.count() === 0; page += 1) {
          await pagination.getByRole('button', { name: '下一页', exact: true }).click(wait());
          await expect(pageStatus).toHaveText(new RegExp(`第 ${page + 1} / ${total} 页$`), wait());
        }
        await expect(source).toBeVisible(wait());
      }
      await revealOriginalSource();
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      const deletionDeadline = Date.now() + 15_000;
      // 删除轮询会卸载并重建目录分页；完成后重新沿公开目录定位同一来源，仍共用原15秒预算。
      await expect.poll(() => manager.evaluate(async ({ contactId, sourceId }) => {
        const state = await window.notalone.sources.getState();
        return state.contactId === contactId && state.phase === 'ready'
          ? state.sources.find(item => item.sourceId === sourceId)?.task?.status : undefined;
      }, { contactId, sourceId }), { timeout: Math.max(1, deletionDeadline - Date.now()) }).toBe('succeeded');
      await revealOriginalSource(deletionDeadline);
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true }))
        .toBeVisible({ timeout: Math.max(1, deletionDeadline - Date.now()) });
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
      await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
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
