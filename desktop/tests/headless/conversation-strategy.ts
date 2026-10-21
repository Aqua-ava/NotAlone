import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function conversationStrategyEntry(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
    const firstCandidate = helper.getByRole('group', { name: '说法1消息组', exact: true }).getByRole('textbox');
    await expect(idea).toBeVisible();
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeEnabled();
    for (const retired of ['改写', '回应消息', '主动聊聊', '帮我理清方向']) {
      await expect(helper.getByRole('button', { name: retired, exact: true })).toHaveCount(0);
    }
    expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
    await rewriteBackend.plan({ count: 1, prefix: '没有思路也能直接得到建议', basis: '结合最近聊天给出一个低假设的开场。' });
    await helper.getByRole('button', { name: '帮我想想', exact: true }).click();
    await expect(firstCandidate)
      .toHaveValue('没有思路也能直接得到建议（说法1）。');
    await helper.getByText('生成说明与更多操作', { exact: true }).click();
    await expect(helper.getByText('结合最近聊天给出一个低假设的开场。', { exact: true })).toBeVisible();
    expect(replyTransport.requests.at(-1)).toMatchObject({ content: {
      type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'suggest', draft_text: '',
      include_relationship_context: true,
    } });
    expect(replyTransport.explorationRequests).toEqual([]);
    await helper.getByText('最近聊天 · 查看／补充', { exact: true }).click();
    await expect(helper.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true })).toBeChecked();
    await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方说：最近有一点忙。');
    await rewriteBackend.command('strategy_pending');
    await idea.fill('想问问合成近况，不安排见面。');
    await rewriteBackend.plan({ count: 2, prefix: '最近怎么样，有空聊聊吗', cite_pending: true });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect.poll(() => replyTransport.results.length, { timeout: 15_000 }).toBe(2);
    expect(replyTransport.results[1].status, JSON.stringify(replyTransport.results[1].data)).toBe(200);
    await expect(firstCandidate).toHaveValue('最近怎么样，有空聊聊吗（说法1）。');
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ input_mode: 'workspace', workspace_action: 'suggest', draft_text: '' });
    expect(payloads[1]).toMatchObject({ input_mode: 'workspace', workspace_action: 'express',
      draft_text: '想问问合成近况，不安排见面。', context_text: '对方说：最近有一点忙。' });
    expect(payloads[1]).not.toHaveProperty('current_text');
    expect(payloads[1]).not.toHaveProperty('target_message_id');
    expect(JSON.stringify(payloads)).not.toContain('乙的私密合成历史');
    expect(replyTransport.requests).toHaveLength(2);
    expect(replyTransport.explorationRequests).toEqual([]);
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expandSavedDiscussion(helper);
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
      .getByText('想问问合成近况，不安排见面。', { exact: true })).toBeVisible();
    await helper.getByText('这组候选的生成输入 · 合成联系人甲', { exact: true }).click();
    await expect(helper.locator('.reply-input-snapshot').getByText('补充聊天：对方说：最近有一点忙。', { exact: true })).toBeVisible();
    await helper.getByRole('button', { name: '本次参考', exact: true }).click();
    const evidence = helper.getByRole('region', { name: '本次参考内容', exact: true });
    await expect(evidence.getByText('未确认参考，不作为确定事实', { exact: true })).toBeVisible();
    await evidence.getByRole('article').filter({ has: helper.getByText('未确认参考，不作为确定事实', { exact: true }) })
      .locator('.record-metadata > summary').click();
    await expect(evidence.getByText(/入选原因：未确认候选、仅供参考、不得当作事实/)).toBeVisible();
  });
}
