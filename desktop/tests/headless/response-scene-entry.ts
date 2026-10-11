import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function responseSceneEntry(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('我想保留这份草稿，今晚再说明安排。');
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    const targets = helper.getByRole('group', { name: '待回复消息', exact: true });
    await expect(targets.getByRole('radio', { checked: true })).toHaveCount(0);
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('说明今晚会晚一点，不增加承诺。');
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    expect(replyTransport.requests).toEqual([]);
    await helper.getByRole('button', { name: '改写', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('我想保留这份草稿，今晚再说明安排。');
    await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('说明今晚会晚一点，不增加承诺。');
    await expect(targets.getByRole('radio', { checked: true })).toHaveCount(0);
    expect(replyTransport.requests).toEqual([]);
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await rewriteBackend.plan({ count: 1, prefix: '我今晚晚一点再回复' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我今晚晚一点再回复（说法1）。');
    expect(replyTransport.requests).toHaveLength(1);
    expect(replyTransport.requests[0]).toMatchObject({ content: { type: 'reply_to_message', direction: '说明今晚会晚一点，不增加承诺。' } });
    const requestId = replyTransport.results[0].data.reply_request_id as string;
    const persisted = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/replies/${requestId}/evidence`);
    expect(persisted.status).toBe(200);
    expect(JSON.stringify(persisted.data)).toContain('甲的私密合成历史：今晚我会晚一点回复你。');
    expect(JSON.stringify(persisted.data)).not.toContain('乙的私密合成历史');
    expect(JSON.stringify(persisted.data)).not.toContain('另一用户的私密合成历史');
    const original = replyTransport.results[0];
    const path = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${original.data.session_id}/replies`;
    const replay = await rewriteBackend.request(path, replyTransport.requests[0]);
    expect(replay).toEqual(original);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await helper.getByRole('button', { name: '改写', exact: true }).click();
    await rewriteBackend.plan({ count: 1, prefix: '保留草稿的回应' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('保留草稿的回应（说法1）。');
    expect(replyTransport.requests.at(-1)).toMatchObject({ content: { type: 'rewrite_draft', draft_text: '我想保留这份草稿，今晚再说明安排。', include_relationship_context: false } });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  });
}
