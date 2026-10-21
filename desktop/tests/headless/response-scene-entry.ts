import { selectContact } from '../contact-picker-actions.mjs';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { fillWorkspaceThought, setWorkspaceContext, generateWorkspace } from '../workspace-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function responseSceneEntry(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await confirmHelperContact(helper, contactId);
    const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
    await expect(idea).toBeEditable();
    await expect(helper.getByRole('group', { name: '沟通场景与改写', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('group', { name: '回复消息来源', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('radio')).toHaveCount(0);
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeEnabled();
    await setWorkspaceContext(helper, true);
    await expect(helper.getByRole('checkbox', { name: /使用消息：甲的私密合成历史/ })).toBeChecked();
    await fillWorkspaceThought(helper, '说明今晚会晚一点，不增加承诺。');
    expect(replyTransport.requests).toEqual([]);
    await rewriteBackend.plan({ count: 1, prefix: '我今晚晚一点再回复' });
    await generateWorkspace(helper);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我今晚晚一点再回复（说法1）。');
    expect(replyTransport.requests[0]).toMatchObject({ content: { input_kind: 'workspace', workspace_action: 'express',
      draft_text: '说明今晚会晚一点，不增加承诺。', include_relationship_context: true } });
    const original = replyTransport.results[0];
    const persisted = await rewriteBackend.request(`/api/contacts/${contactId}/replies/${original.data.reply_request_id}/evidence`);
    expect(persisted.status).toBe(200);
    expect(JSON.stringify(persisted.data)).toContain('甲的私密合成历史：今晚我会晚一点回复你。');
    expect(JSON.stringify(persisted.data)).not.toContain('乙的私密合成历史');
    expect(JSON.stringify(persisted.data)).not.toContain('另一用户的私密合成历史');
    const path = `/api/contacts/${contactId}/assistant-sessions/${original.data.session_id}/replies`;
    expect(await rewriteBackend.request(path, replyTransport.requests[0])).toEqual(original);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await setWorkspaceContext(helper, false);
    await expect(idea).toHaveValue('说明今晚会晚一点，不增加承诺。');
    await rewriteBackend.plan({ count: 1, prefix: '保留想法的表达' });
    await generateWorkspace(helper);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('保留想法的表达（说法1）。');
    expect(replyTransport.requests.at(-1)).toMatchObject({ content: { input_kind: 'workspace', workspace_action: 'express', include_relationship_context: false } });
    const supplement = helper.getByRole('textbox', { name: '补充聊天上下文', exact: true });
    await supplement.fill('合成粘贴原话：周末有空吗？');
    await fillWorkspaceThought(helper, '这次不去，简短婉拒。');
    await rewriteBackend.plan({ count: 1, prefix: '这次先不去了' });
    await generateWorkspace(helper);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('这次先不去了（说法1）。');
    expect(replyTransport.requests.at(-1)).toMatchObject({ content: { input_kind: 'workspace',
      context_text: '合成粘贴原话：周末有空吗？', draft_text: '这次不去，简短婉拒。' } });
    expect((replyTransport.requests.at(-1)!.content as Record<string, unknown>).pasted_direction).toBeUndefined();
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(3);
    // 关闭自动背景不清空同一助手会话的已保存讨论；本次新选入的依据不得重新带入该消息。
    expect(JSON.stringify(payloads.at(-1)!.evidence)).not.toContain('甲的私密合成历史');
    const generatedCount = replyTransport.requests.length;
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '无消息的合成联系人' });
    // 此联系人没有已确认的桌面会话绑定，明确进入手动输入路径。
    await helper.getByRole('button', { name: '切换为手动输入', exact: true }).click();
    await expect(helper.getByRole('region', { name: '手动输入联系人确认' }).getByRole('status'))
      .toHaveText('手动输入模式 · 本次联系人已由你确认');
    await confirmHelperContact(helper, rewriteBackend.data.empty_contact_id);
    await expect(idea).toHaveValue('');
    await setWorkspaceContext(helper, true);
    await expect(supplement).toHaveValue('');
    await expect(helper.getByText('暂无可用的最近聊天。可以补充上下文，或先写下想法。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    replyTransport.nextMessages = 'hold';
    const heldBefore = replyTransport.heldCount;
    await helper.getByRole('button', { name: '刷新最近聊天', exact: true }).click();
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await helper.getByRole('button', { name: '确认手动输入联系人', exact: true }).click();
    await expect(helper.getByRole('region', { name: '手动输入联系人确认' }).getByRole('status'))
      .toHaveText('手动输入模式 · 本次联系人已由你确认');
    await confirmHelperContact(helper, contactId);
    replyTransport.release();
    await expect(idea).toHaveValue('这次不去，简短婉拒。');
    await expect(supplement).toHaveValue('合成粘贴原话：周末有空吗？');
    await expect(helper.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true })).not.toBeChecked();
    expect(replyTransport.requests).toHaveLength(generatedCount);
    expect(replyTransport.explorationRequests).toHaveLength(0);
  });
}
