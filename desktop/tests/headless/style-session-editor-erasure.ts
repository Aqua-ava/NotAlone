import { expect, type Browser, type Locator } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { withRewritePages } from './rewrite-acceptance';

const replyText = '合成候选只表达本次拒绝，不新增约定。';
const savedManual = '主动保存且独立保留的合成手写样本。';
const unsavedCandidate = '合成候选片段粘贴后编辑，但尚未主动保存。';
const unsavedManual = '这段独立手写与复制候选无关，尚未保存。';
const unsavedSample = '主动保存样本的列表片段粘贴后继续编辑。';

async function copyCandidate(editor: Locator, size: number) {
  await editor.evaluate((element, length) => {
    const input = element as HTMLTextAreaElement;
    input.focus(); input.setSelectionRange(0, length);
    input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
  }, size);
}

async function pasteAndEdit(manual: Locator, fragment: string, text: string) {
  // 合成宿主剪贴板事件仍经过生产组件和来源控制器，不直接改其状态。
  await manual.evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
  }, fragment);
  await manual.fill(text);
}

async function editorAfterSessionDeletion(pages: RewritePages, kind: 'candidate' | 'manual' | 'sample') {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  const contactId = rewriteBackend.data.contact_ids[0];
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, contactId);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('本次合成意图是拒绝，不新增承诺。');
  await rewriteBackend.plan({ count: 1, text: replyText, basis: '只核对删除与独立保留的数据契约。' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue(replyText);
  const generation = replyTransport.results.at(-1)!;
  expect(generation.status).toBe(200);
  expect(typeof generation.data.session_id).toBe('string');
  const sessionPath = `/api/contacts/${contactId}/assistant-sessions/${generation.data.session_id}`;
  const beforeSession = await rewriteBackend.request(sessionPath);
  expect(beforeSession.status).toBe(200);
  expect(beforeSession.data.turns).toEqual([expect.objectContaining({ state: 'completed', input: expect.any(Object) })]);

  await helper.getByText('我的表达样本', { exact: true }).click();
  const manual = helper.getByRole('textbox', { name: '手工表达样本', exact: true });
  const list = helper.getByRole('list', { name: '表达样本目录', exact: true });
  await manual.fill(savedManual);
  await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
  await expect(list.getByText(savedManual, { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
  await expect(list.getByText(replyText, { exact: true })).toBeVisible();
  const samplePath = `/api/contacts/${contactId}/style-samples`;
  const beforeSamples = await rewriteBackend.request(samplePath);
  expect(beforeSamples.status).toBe(200);
  expect(beforeSamples.data.samples).toHaveLength(2);

  const fragment = replyText.slice(0, 8);
  if (kind === 'sample') {
    await list.getByText(replyText, { exact: true }).evaluate((element, size) => {
      const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, size);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
    }, fragment.length);
    await pasteAndEdit(manual, fragment, unsavedSample);
  } else {
    await copyCandidate(editor, fragment.length);
    if (kind === 'candidate') await pasteAndEdit(manual, fragment, unsavedCandidate);
    else await manual.fill(unsavedManual);
  }
  const expectedBefore = kind === 'candidate' ? unsavedCandidate : kind === 'manual' ? unsavedManual : unsavedSample;
  await expect(manual).toHaveValue(expectedBefore);
  await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
  const confirmation = helper.getByRole('group', { name: '确认删除助手会话', exact: true });
  await expect(confirmation.getByText('已主动保存的表达样本仍会保留，可在表达样本管理中单独删除。', { exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: '取消删除会话', exact: true }).click();
  await expect(manual).toHaveValue(expectedBefore);
  expect((await rewriteBackend.request(sessionPath)).status).toBe(200);

  await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
  expect((await rewriteBackend.request(sessionPath)).status).toBe(404);
  await expect(manual).toHaveValue(kind === 'candidate' ? '' : expectedBefore);
  await expect(editor).toHaveCount(0);
  expect((await rewriteBackend.request(samplePath)).data).toEqual(beforeSamples.data);
  await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
  await expect(list.getByText(savedManual, { exact: true })).toBeVisible();
  await expect(list.getByText(replyText, { exact: true })).toBeVisible();
  expect((await rewriteBackend.request(sessionPath + '/replies', replyTransport.requests[0])).status).not.toBe(200);
  expect((await rewriteBackend.request(`/api/contacts/${contactId}/replies/${generation.data.reply_request_id}/evidence`)).status).not.toBe(200);

  if (kind !== 'manual') {
    if (kind === 'candidate') await pasteAndEdit(manual, fragment, '删除后再次粘贴旧片段，不能洗为手工样本。');
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByRole('alert').filter({ hasText: '样本操作暂时不可用' })).toBeVisible();
    expect((await rewriteBackend.request(samplePath)).data).toEqual(beforeSamples.data);
    await manual.fill('');
    await manual.fill('清空来源后新写的独立合成样本。');
  }
  await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
  const finalText = kind === 'manual' ? unsavedManual : '清空来源后新写的独立合成样本。';
  await expect(list.getByText(finalText, { exact: true })).toBeVisible();
  const afterSamples = await rewriteBackend.request(samplePath);
  expect(afterSamples.status).toBe(200);
  expect(afterSamples.data.samples).toHaveLength(3);
  expect((afterSamples.data.samples as Array<Record<string, unknown>>).find((item) => item.text === finalText))
    .toMatchObject({ origin_kind: 'manual', origin_id: null, source_ids: [] });
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
}

export async function styleSessionEditorErasure(browser: Browser, origin: string) {
  const scenarios = [
    ['candidate', '删除助手会话清除未保存候选片段，主动保存样本独立保留'],
    ['manual', '只复制未粘贴的候选不影响独立手写编辑'],
    ['sample', '删除助手会话保留已保存样本列表复制及其来历'],
  ] as const;
  for (const [kind, name] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, (pages) => editorAfterSessionDeletion(pages, kind));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
