import { setWorkspaceContext } from '../workspace-actions';
import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

async function copyEditorPrefix(editor: Locator, length: number) {
  await editor.evaluate((element, size) => {
    const input = element as HTMLTextAreaElement;
    input.focus(); input.setSelectionRange(0, size);
    input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
  }, length);
}

async function paste(input: Locator, fragment: string) {
  // 只替换宿主剪贴板输入；插入与拒绝仍由真实组件处理。
  await input.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, fragment);
}

async function rejectPaste(helper: Page, input: Locator, fragment: string, sampleCount: number) {
  await expect(input).toHaveValue('');
  await paste(input, fragment);
  await expect(helper.getByRole('alert').filter({ hasText: '无法核验粘贴来源' })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(helper.getByRole('button', { name: '主动保存手工文字', exact: true })).toBeDisabled();
  expect((await helper.evaluate(() => window.notalone.styleSamples.getState())).samples).toHaveLength(sampleCount);
}

export async function styleCopyOrigin(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByText('我的表达样本', { exact: true }).click();
    await setWorkspaceContext(helper, true);
    const message = helper.getByRole('checkbox', { name: /甲的私密合成历史/ });
    await message.check(); await expect(message).toBeChecked();
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('只回应选定消息，不增加安排。');
    await rewriteBackend.plan({ count: 1, prefix: '片段来历候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('片段来历候选（说法1）。');
    const edited = '这是合成来源候选，选区仍保留来历。';
    await editor.fill(edited);
    await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
      .candidateDrafts?.[0]?.messages[0].text).toBe(edited);
    const fragment = edited.slice(0, 8);
    await copyEditorPrefix(editor, fragment.length);
    const manual = helper.getByRole('textbox', { name: '手工表达样本', exact: true });
    const finalText = `我的前缀：${fragment}；粘贴后继续编辑。`;
    await paste(manual, fragment);
    await expect(manual).toHaveValue(fragment);
    await manual.fill(finalText);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    const list = helper.getByRole('list', { name: '表达样本目录', exact: true });
    await expect(list.getByText(finalText, { exact: true })).toBeVisible();
    const sample = await helper.evaluate(async (text) =>
      (await window.notalone.styleSamples.getState()).samples.find((item) => item.text === text), finalText);
    expect(sample?.originKind).toBe('candidate');
    expect(sample?.sourceIds.length).toBeGreaterThan(0);

    // 列表、跨样本与跨联系人选区必须在插入前拒绝，不能成为无来源手工样本。
    const savedFragment = finalText.slice(0, 8);
    await list.getByText(finalText, { exact: true }).evaluate((element, size) => {
      const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, size);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
    }, savedFragment.length);
    await rejectPaste(helper, manual, savedFragment, 1);

    await manual.fill('');
    const independent = '清空后独立手写的合成样本。';
    await manual.fill(independent);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(list.getByText(independent, { exact: true })).toBeVisible();
    const combined = await list.evaluate((element) => {
      const paragraphs = element.querySelectorAll('li > p');
      const range = document.createRange(); range.setStart(paragraphs[0].firstChild!, 0);
      range.setEnd(paragraphs[1].firstChild!, paragraphs[1].textContent!.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const text = selection.toString();
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
      return text;
    });
    await rejectPaste(helper, manual, combined, 2);

    await manual.fill('');
    await copyEditorPrefix(editor, fragment.length);
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[1]);
    await rejectPaste(helper, manual, fragment, 0);

    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await expect(list.getByText(finalText, { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '记忆', exact: true }).click();
    await selectMemoryCategory(manager, '来源与过程');
    await manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(manager.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(list.getByText(finalText, { exact: true })).toHaveCount(0);
    await expect(list.getByText(independent, { exact: true })).toBeVisible();
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });
}
