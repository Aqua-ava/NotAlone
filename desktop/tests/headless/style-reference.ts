import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 保存、实际选取展示和删除使用生产controller/HTTP/PG；只替换生成模型。
export async function styleReference(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByText('我的表达样本', { exact: true }).click();
    const manual = helper.getByRole('textbox', { name: '手工表达样本', exact: true });
    for (let index = 0; index < 7; index++) {
      await manual.fill(`合成样本${index}：我过去总答应，明晚七点陪你去合成海边。`);
      await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
      await expect(manual).toHaveValue('');
      await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(index + 1);
    }
    await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
    await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('明确拒绝本次聚会，不增加约定。');
    await rewriteBackend.plan({ count: 1, text: '本次我不参加。', basis: '保留当前拒绝，不沿旧样本增加约定。' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('本次我不参加。');
    const observed = await rewriteBackend.command('observations');
    const payload = (observed.payloads as Record<string, unknown>[]).at(-1)!;
    const references = payload.style_references as { sample_id: string; text: string; factual_role: string; weight: string }[];
    expect(references).toHaveLength(5);
    expect(references.every((item) => item.factual_role === 'expression_reference' && item.weight === 'low')).toBe(true);
    expect(payload.fidelity_contract).toMatchObject({ current_intent: { text: '明确拒绝本次聚会，不增加约定。' } });
    const displayed = helper.getByRole('region', { name: '本次表达参考', exact: true });
    for (const reference of references) await expect(displayed.getByText(reference.text, { exact: true })).toBeVisible();
    const output = replyTransport.results.at(-1)!.data;
    expect((output.context_receipt as { style_sample_ids: string[] }).style_sample_ids.slice().sort())
      .toEqual(references.map((item) => item.sample_id).sort());
    const replayPath = `/api/contacts/${contactId}/assistant-sessions/${output.session_id}/replies`;
    const request = replyTransport.requests.at(-1)!;
    expect((await rewriteBackend.request(replayPath, request)).data).toEqual(output);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

    await helper.getByRole('button', { name: `删除表达样本：${references[0].text}`, exact: true }).click();
    await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(6);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(displayed).toHaveCount(0);
    expect((await rewriteBackend.request(replayPath, request)).status).not.toBe(200);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[1]);
    await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(0);
    await expect(helper.getByRole('list', { name: '表达样本目录', exact: true }).getByRole('listitem')).toHaveCount(0);
  });
}
