import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { confirmDeletion, expectDeletionCleared, saveDeletionDiscussion } from './assistant-session-deletion-support';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

// 重建后的历史候选从公开讨论 DOM 复制，来源登记和删除清除仍经过生产组件与真实 HTTP。
export async function assistantSessionDeletionRecoveredCopy(browser: Browser, origin: string) {
  const name = '重建后复制历史候选的未保存编辑随会话清除，旧粘贴不能重新保存且独立输入保留';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const { helper, rewriteBackend } = pages;
    const candidateText = '重建后可见的合成历史候选（说法1）。';
    const saved = await saveDeletionDiscussion(pages, '重建后从已保存讨论复制的合成输入。', '重建后可见的合成历史候选');
    await helper.getByText('我的表达样本', { exact: true }).click();
    const independent = '重建后仍独立保留的主动保存合成样本。';
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(independent);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByRole('list', { name: '表达样本目录', exact: true }).getByText(independent, { exact: true })).toBeVisible();
    const samplePath = `/api/contacts/${saved.contactId}/style-samples`;
    const retained = await rewriteBackend.request(samplePath);
    expect(retained.status).toBe(200);
    expect(retained.data.samples).toEqual([expect.objectContaining({ text: independent, origin_kind: 'manual' })]);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

    await host.close();
    await rewriteBackend.command('restart');
    const rebuilt = new PageHost(await browser.newContext(), origin, userData);
    try {
      await rebuilt.backend.connect();
      const nextManager = await rebuilt.open('manager');
      await expect(nextManager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
      await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      const nextHelper = await rebuilt.open('helper');
      await confirmHelperContact(nextHelper, saved.contactId);
      const discussion = nextHelper.getByRole('region', { name: '已保存的讨论', exact: true });
      const historical = discussion.getByText(candidateText, { exact: true });
      await expect(historical).toBeVisible();
      const recovered = await nextHelper.evaluate(async () => window.notalone.replies.getState());
      expect(recovered).toMatchObject({ result: null, selectedCandidateId: null,
        savedSession: { phase: 'ready', sessionId: saved.sessionId, turns: [expect.objectContaining({ state: 'completed' })] } });
      expect((await rewriteBackend.request(saved.path)).status).toBe(200);
      await expect(nextHelper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      await nextHelper.getByText('我的表达样本', { exact: true }).click();
      const manual = nextHelper.getByRole('textbox', { name: '手工表达样本', exact: true });
      const samples = nextHelper.getByRole('list', { name: '表达样本目录', exact: true });
      await expect(samples.getByText(independent, { exact: true })).toBeVisible();
      const copied = await historical.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        const text = selection.toString();
        element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
        return text;
      });
      expect(copied).toBe(candidateText);
      await manual.evaluate((element, text) => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      }, copied);
      await expect(manual).toHaveValue(copied);
      await manual.fill(`${copied}尚未保存的历史候选合成编辑。`);
      expect(await rewriteBackend.request(samplePath)).toEqual(retained);
      await confirmDeletion(nextHelper);
      await expect(nextHelper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
      expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
      await expect(manual).toHaveValue('');
      await expectDeletionCleared(nextHelper);
      await expect(samples.getByText(independent, { exact: true })).toBeVisible();
      expect(await rewriteBackend.request(samplePath)).toEqual(retained);

      // 删除后的同一剪贴板内容再次粘贴，应立即拒绝且不能保存。
      await manual.evaluate((element, text) => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      }, copied);
      await expect(nextHelper.getByRole('alert').filter({ hasText: '无法核验粘贴来源' })).toBeVisible();
      await expect(manual).toHaveValue('');
      await expect(nextHelper.getByRole('button', { name: '主动保存手工文字', exact: true })).toBeDisabled();
      expect(await rewriteBackend.request(samplePath)).toEqual(retained);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

      await nextManager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
      const otherContactId = rewriteBackend.data.contact_ids[1];
      await confirmHelperContact(nextHelper, otherContactId);
      await expect(nextHelper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
      const newDraft = '新范围独立输入且不应被旧候选删除清除的合成草稿。';
      const newManual = '新范围独立手写且尚未保存的合成文字。';
      await nextHelper.getByRole('textbox', { name: '草稿', exact: true }).fill(newDraft);
      await manual.fill(newManual);
      await nextHelper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
      await nextHelper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
      await expect(nextHelper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue(newDraft);
      await expect(manual).toHaveValue(newManual);
      expect((await nextHelper.evaluate(async () => window.notalone.replies.getState())).contactId).toBe(otherContactId);
      expect((await rewriteBackend.request(`/api/contacts/${otherContactId}/style-samples`)).data.samples).toEqual([]);
      expect(await rewriteBackend.request(samplePath)).toEqual(retained);
      expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    } finally { await rebuilt.close(); }
  });
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
