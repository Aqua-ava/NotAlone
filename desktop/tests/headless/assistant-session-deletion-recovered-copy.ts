import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { confirmDeletion, expectDeletionCleared, saveDeletionDiscussion } from './assistant-session-deletion-support';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

// 重建后的历史候选从公开讨论 DOM 复制，来源登记和删除清除仍经过生产组件与真实 HTTP。
export async function assistantSessionDeletionRecoveredCopy(browser: Browser, origin: string) {
  const name = '重建后历史候选复制与删除清理，其他联系人独立输入保留';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const { helper, rewriteBackend } = pages;
    const candidateText = '重建后可见的合成历史候选（说法1）。';
    const saved = await saveDeletionDiscussion(pages, '重建后从已保存讨论复制的合成输入。', '重建后可见的合成历史候选');

    await host.close();
    await rewriteBackend.command('restart');
    const rebuilt = new PageHost(await browser.newContext(), origin, userData);
    try {
      await rebuilt.backend.connect();
      const nextManager = await rebuilt.open('manager');
      await expect(nextManager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue('');
      await nextManager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
      const nextHelper = await rebuilt.open('helper');
      await confirmHelperContact(nextHelper, saved.contactId);
      const discussion = nextHelper.getByRole('region', { name: '已保存的讨论', exact: true });
      const historical = discussion.getByText(candidateText, { exact: true });
      await expect.poll(() => nextHelper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase)).toBe('ready');
      await expandSavedDiscussion(nextHelper);
      await expect(historical).toBeVisible();
      const recovered = await nextHelper.evaluate(async () => window.notalone.replies.getState());
      expect(recovered).toMatchObject({ result: null, selectedCandidateId: null,
        savedSession: { phase: 'ready', sessionId: saved.sessionId, turns: [expect.objectContaining({ state: 'completed' })] } });
      expect((await rewriteBackend.request(saved.path)).status).toBe(200);
      await expect(nextHelper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      const copied = await historical.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        const text = selection.toString();
        element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
        return text;
      });
      expect(copied).toBe(candidateText);
      await confirmDeletion(nextHelper);
      await expect(nextHelper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
      expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
      await expectDeletionCleared(nextHelper);

      await nextManager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人乙' });
      const otherContactId = rewriteBackend.data.contact_ids[1];
      await confirmHelperContact(nextHelper, otherContactId);
      await expect(nextHelper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
      const newDraft = '新范围独立输入且不应被旧候选删除清除的合成草稿。';
      await nextHelper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(newDraft);
      await openAssistantHistory(nextHelper);
      await nextHelper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
      await expandSavedDiscussion(nextHelper);
      await expect(nextHelper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue(newDraft);
      expect((await nextHelper.evaluate(async () => window.notalone.replies.getState())).contactId).toBe(otherContactId);
      expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    } finally { await rebuilt.close(); }
  });
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
