import { ensureReplySettingsOpen } from '../reply-settings-actions';
import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 每场经生产页面/controller、认证HTTP和正式隔离PG；模型只返回合成结构。
export async function replyStrategyDialogue(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) {
    process.stdout.write(`page_test_scenario: ${scene}纠正不确认、回答不确认、明确选择后生成\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const contactId = rewriteBackend.data.contact_ids[0];
      const material = await rewriteBackend.command('strategy_many_sources');
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') {
        const target = helper.getByRole('radio', { name: /甲的私密合成历史/ });
        await target.click(); await expect(target).toBeChecked();
      } else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想聊聊，还不确定要推进什么。');
      await ensureReplySettingsOpen(helper, '策略选择');
      await helper.getByRole('combobox', { name: '策略选择', exact: true }).selectOption('disabled');
      await rewriteBackend.plan({ explore: { understanding: '合成目的仍需由用户确认。', cite_all: true,
        question: { text: '这次是否愿意作出新的安排承诺？', impact: 'commitment' } } });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
      await expect.poll(() => replyTransport.explorationResults.length).toBe(1);
      expect(replyTransport.explorationResults[0].status).toBe(200);
      const materialEvidence = (replyTransport.explorationResults[0].data.evidence as Array<{ evidence_id: string; source_ids: string[] }>)
        .find((item) => item.evidence_id === material.memory_id)!;
      expect(materialEvidence.source_ids).toHaveLength(21);
      expect([...materialEvidence.source_ids].sort()).toEqual([...(material.source_ids as string[])].sort());
      await expect(strategy).toContainText('合成目的仍需由用户确认。');
      await expect(strategy).toContainText('合成已确认资料带完整的二十一个来源。');
      await expect(strategy).toContainText('本次只说明意愿，不推进其他安排。');
      await expect(strategy).toContainText('简短表达可能只推进当前一步。');
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      const first = replyTransport.explorationResults[0].data;
      expect(first.kind).toBe('clarification');
      expect(first.input_version_id).toMatch(/^[a-f0-9-]{36}$/);
      await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('这次只是了解近况，没有安排承诺。');
      await rewriteBackend.plan({ explore: { understanding: '纠正只更新理解。',
        question: { text: '本次是否只了解近况？', impact: 'ambiguity' } } });
      await helper.getByRole('button', { name: '更新理解', exact: true }).click();
      await expect(strategy).toContainText('纠正只更新理解。');
      await helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('只了解近况。');
      await rewriteBackend.plan({ explore: { understanding: '回答后的目的仍未确认。' } });
      await helper.getByRole('button', { name: '提交回答', exact: true }).click();
      await expect(strategy).toContainText('回答后的目的仍未确认。');
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
      await rewriteBackend.plan({ count: 1, prefix: '本次已确认合成意愿' });
      await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
      await expect.poll(() => replyTransport.explorationResults.length).toBe(4);
      expect(replyTransport.explorationResults.at(-1)?.status, JSON.stringify(replyTransport.explorationResults.at(-1))).toBe(200);
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('本次已确认合成意愿（说法1）。');
      const generated = replyTransport.explorationResults.at(-1)!.data;
      expect(generated.kind).toBe('generated');
      const turn = generated.turn as { session_id: string; input_version_id: string; reply_request_id: string };
      const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${turn.session_id}`);
      expect(saved.status).toBe(200);
      expect(JSON.stringify(saved.data)).toContain(turn.reply_request_id);
      const observations = await rewriteBackend.command('observations');
      const payloads = observations.payloads as Array<Record<string, unknown>>;
      const reply = payloads.at(-1)!;
      expect(reply.input_mode).toBe(scene === '回应消息' ? 'reply_to_message' : 'initiate_conversation');
      expect(reply.understanding_correction).toBe('这次只是了解近况，没有安排承诺。');
      expect(reply.clarification_answer).toBe('只了解近况。');
      expect(JSON.stringify(reply)).not.toContain('乙的私密合成历史');
      expect(JSON.stringify(reply)).not.toContain('另一用户的私密合成历史');
      const before = payloads.length;
      expect(before).toBe(4);
      const responseCount = replyTransport.explorationResults.length;
      const originalConfirm = replyTransport.explorationRequests.at(-1);
      await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
      await expect.poll(() => replyTransport.explorationResults.length).toBe(responseCount + 1);
      expect(replyTransport.explorationRequests.at(-1)).toEqual(originalConfirm);
      expect(replyTransport.explorationResults.at(-1)).toEqual({ status: 200, data: generated });
      expect(((await rewriteBackend.command('observations')).payloads as unknown[]).length).toBe(before);
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('本次已确认合成意愿（说法1）。');
      await rewriteBackend.plan({ count: 1, prefix: '关闭策略后继续生成' });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('关闭策略后继续生成（说法1）。');
      expect(replyTransport.requests.at(-1)).toMatchObject({ skill_disabled: true });
      if (scene === '主动聊聊') {
        const sources = await rewriteBackend.request(`/api/contacts/${contactId}/sources`);
        const sourceId = (sources.data.sources as Array<{ source_id: string }>)[0].source_id;
        await manager.getByRole('button', { name: '记忆', exact: true }).click();
        await selectMemoryCategory(manager, '来源与过程');
        const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
          .filter({ hasText: `来源标识：${sourceId}` });
        await source.getByRole('button', { name: '删除来源', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(helper.getByRole('textbox', { name: '主动目的', exact: true })).toHaveValue('');
        await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).clarificationAnswer)).toBe('');
        expect((await rewriteBackend.command('observations')).payloads).toHaveLength(5);
      }
    });
  }
}

export async function replyStrategyInvalidation(browser: Browser, origin: string) {
  for (const change of ['目的', '场景', '目标']) {
    process.stdout.write(`page_test_scenario: 修改${change}使旧问题回答失效\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      if (change === '目标') {
        await rewriteBackend.command('older_messages');
        await helper.getByRole('button', { name: '回应消息', exact: true }).click();
        await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      } else {
        await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
        await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('先探索合成目的。');
      }
      await rewriteBackend.plan({ explore: { question: { text: '是否承担安排承诺？', impact: 'commitment' } } });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      await helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('旧问题的合成回答。');
      await rewriteBackend.plan({ explore: { understanding: '仍需确认新的意愿。' } });
      await helper.getByRole('button', { name: '提交回答', exact: true }).click();
      await expect.poll(() => replyTransport.explorationResults.length, { timeout: 15_000 }).toBe(2);
      expect(replyTransport.explorationResults.at(-1)?.status, JSON.stringify(replyTransport.explorationResults.at(-1))).toBe(200);
      await expect(helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText('仍需确认新的意愿。');
      if (change === '目的') await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('新的明确目的：说明近况。');
      else if (change === '场景') {
        await helper.getByRole('button', { name: '回应消息', exact: true }).click();
        await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      } else await helper.getByRole('radio', { name: /甲的较早合成消息 01/ }).click();
      await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).clarificationAnswer)).toBe('');
      if (change !== '目的') await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('只说明当前近况。');
      await rewriteBackend.plan({ count: 1, prefix: '输入更新后的合成候选' });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('输入更新后的合成候选（说法1）。');
      expect((replyTransport.requests.at(-1) as { content: Record<string, unknown> }).content.clarification_answer).toBeNull();
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
    });
  }
}
