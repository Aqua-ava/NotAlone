import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 两个审查反例共同观察公开保存结果；宿主选区/剪贴板事件仅使用合成正文。
export async function styleCopyLimits(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByText('我的表达样本', { exact: true }).click();
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    const message = helper.getByRole('radio', { name: /甲的私密合成历史/ });
    await message.click(); await expect(message).toBeChecked();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('只回应本次消息，不增加安排。');
    await rewriteBackend.plan({ count: 1, prefix: '复制边界合成候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('复制边界合成候选（说法1）。');
    const manual = helper.getByRole('textbox', { name: '手工表达样本', exact: true });
    const cases = [
      { id: 'cut-fragment', event: 'cut', edited: '剪切选区仍来自合成候选。', length: 8, final: '剪切片段编辑后主动保存。' },
      { id: 'long-copy-shortened', event: 'copy', edited: '合成较长说法'.repeat(850), length: 5100, final: '长片段截短并继续编辑后主动保存。' },
    ];
    const observed: Array<{ caseId: string; originKind: string | undefined; hasSources: boolean }> = [];
    for (const item of cases) {
      await manual.fill('');
      await editor.fill(item.edited);
      await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
        .result?.candidates[0].editedText).toBe(item.edited);
      await editor.evaluate((element, input) => {
        const editor = element as HTMLTextAreaElement;
        editor.focus(); editor.setSelectionRange(0, input.length);
        editor.dispatchEvent(new ClipboardEvent(input.event, { bubbles: true }));
      }, { length: item.length, event: item.event });
      await manual.evaluate((element, text) => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
      }, item.edited.slice(0, item.length));
      await expect(manual).toHaveValue(item.edited.slice(0, Math.min(item.length, 4096)));
      await manual.fill(item.final);
      await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
      await expect(helper.getByRole('list', { name: '表达样本目录', exact: true })
        .getByText(item.final, { exact: true })).toBeVisible();
      const sample = await helper.evaluate(async (text) => (await window.notalone.styleSamples.getState())
        .samples.find((item) => item.text === text), item.final);
      observed.push({ caseId: item.id, originKind: sample?.originKind, hasSources: Boolean(sample?.sourceIds.length) });
    }
    // 先完整记录两条公开结果，再统一断言，避免首RED阻止第二反例实际到达。
    process.stdout.write(`page_test_copy_limits: ${JSON.stringify(observed)}\n`);
    expect(observed).toEqual([
      { caseId: 'cut-fragment', originKind: 'candidate', hasSources: true },
      { caseId: 'long-copy-shortened', originKind: 'candidate', hasSources: true },
    ]);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });
}
