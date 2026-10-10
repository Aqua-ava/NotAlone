import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function conversationStrategyEntry(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('保留这段合成草稿。');
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await expect(helper.getByRole('radio', { name: /甲的私密合成历史/ })).not.toBeChecked();
    await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '主动目的', exact: true })).toHaveValue('');
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
    await helper.getByRole('button', { name: '改写', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('保留这段合成草稿。');
    await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
    await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想问候近况，不安排见面。');
    await rewriteBackend.plan({ count: 2, prefix: '最近怎么样，有空聊聊吗' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('最近怎么样，有空聊聊吗（说法1）。');
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ input_mode: 'initiate_conversation', confirmed_purpose: '想问候近况，不安排见面。' });
    expect(payloads[0]).not.toHaveProperty('current_text');
    expect(payloads[0]).not.toHaveProperty('target_message_id');
    expect(JSON.stringify(payloads[0])).not.toContain('乙的私密合成历史');
    expect(replyTransport.requests).toHaveLength(1);
    await helper.getByText('这组候选的生成输入 · 合成联系人甲', { exact: true }).click();
    await expect(helper.getByText('主动目的：想问候近况，不安排见面。', { exact: true })).toBeVisible();
  });
}
