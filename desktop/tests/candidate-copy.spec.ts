import { expect } from '@playwright/test';
import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { confirmHelperContact } from './foreground-confirmation-actions';

// 仅在主 Agent 认可的 App 时段执行；先覆盖合成占位文本，再比较本轮写入。
test('原生复制取得当前编辑文本，复制并收起只隐藏本次小窗', async ({ runningApp: { app }, rewriteBackend }) => {
  const sentinel = 'NotAlone 本轮原生复制合成占位。';
  const edited = '今天到不了，我们下次再约时间。';
  const hiddenEdit = '我先处理手头的事情，晚些再联系。';
  const { manager, helper } = await openRewriteAppPages(app);
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toBeVisible();
  await app.evaluate(async ({ clipboard }, text) => { await clipboard.writeText(text); }, sentinel);
  try {
    await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('只说明今天到不了，不增加其他承诺。');
    await rewriteBackend.plan({ count: 1, prefix: '原生复制原候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('原生复制原候选（说法1）。');
    await editor.fill(edited);
    await helper.getByRole('button', { name: '复制', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '已复制当前编辑文本' })).toBeVisible();
    await expect.poll(() => app.evaluate(async ({ clipboard }, text) => (await clipboard.readText()) === text, edited)).toBe(true);
    await expect.poll(async () => (await app.browserWindow(helper)).evaluate((window) => window.isVisible())).toBe(true);
    await expect(editor).toHaveValue(edited);
    await helper.getByText('查看原候选', { exact: true }).click();
    await expect(helper.getByText('原生复制原候选（说法1）。', { exact: true })).toBeVisible();

    // 管理窗口不能借具名桥接复制小窗文本；系统接收端保持已知的本轮文本。
    const request = await helper.evaluate(async () => {
      const state = await window.notalone.replies.getState();
      return { contactId: state.contactId!, scopeRevision: state.scopeRevision,
        replyRequestId: state.result!.replyRequestId, candidateId: state.selectedCandidateId!, hideAfterCopy: false };
    });
    expect(await manager.evaluate(async (request) => {
      try { await window.notalone.candidateCopy.copy(request); return 'accepted'; } catch { return 'rejected'; }
    }, request)).toBe('rejected');
    expect(await app.evaluate(async ({ clipboard }, text) => (await clipboard.readText()) === text, edited)).toBe(true);

    await editor.fill(hiddenEdit);
    await helper.getByRole('button', { name: '复制并收起', exact: true }).click();
    await expect.poll(() => app.evaluate(async ({ clipboard }, text) => (await clipboard.readText()) === text, hiddenEdit)).toBe(true);
    await expect.poll(async () => (await app.browserWindow(helper)).evaluate((window) => window.isVisible())).toBe(false);
    await expect.poll(async () => (await app.browserWindow(manager)).evaluate((window) => window.isVisible())).toBe(true);
    await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
    await expect.poll(async () => (await app.browserWindow(helper)).evaluate((window) => window.isVisible())).toBe(true);
    await expect(editor).toHaveValue(hiddenEdit);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally {
    // 只在剪贴板仍是本轮已知文本时清空，比较结果不回传剪贴板正文。
    await app.evaluate(async ({ clipboard }, texts) => {
      if (texts.includes(await clipboard.readText())) await clipboard.writeText('');
    }, [sentinel, edited, hiddenEdit]);
  }
});
