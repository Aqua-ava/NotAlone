import { fillWorkspaceInstruction, setWorkspaceTone, openWorkspaceSettings } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import type { RewritePages } from '../rewrite-page-scenarios';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { chooseDeletionContact, confirmDeletion, expectDeletionCleared, saveDeletionDiscussion } from './assistant-session-deletion-support';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

async function expectEmptyRecovery(helper: Page, contactId: string, deletedId: string) {
  await openAssistantHistory(helper);
  await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
  await openWorkspaceSettings(helper);
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('button', { name: '重试同一次生成', exact: true })).toHaveCount(0);
  const state = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(state).toMatchObject({ contactId, result: null, selectedCandidateId: null, canRetry: false,
    phase: 'idle', direction: '', purpose: '', savedSession: { phase: 'ready', turns: [] } });
  expect(state.savedSession!.sessionId).not.toBe(deletedId);
  return state.savedSession!.sessionId!;
}

async function runningDeletion(pages: RewritePages, host: PageHost, userData: string, browser: Browser, origin: string) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  await chooseDeletionContact(pages);
  const contactId = rewriteBackend.data.contact_ids[0];
  expect((await rewriteBackend.request('/api/memories/manual-contact', {
    contact_id: contactId, text: '会话清除仍保留的合成联系人偏好。', category: 'preference',
  })).status).toBe(200);
  expect((await rewriteBackend.request('/api/memories/manual-owner', {
    text: '会话清除仍保留的合成本人偏好。', category: 'preference',
  })).status).toBe(200);
  const retainedPaths = [`/api/contacts/${contactId}/sources`, `/api/contacts/${contactId}/messages?limit=20`,
    `/api/contacts/${contactId}/memories`, '/api/memories/owner'];
  const retained = await Promise.all(retainedPaths.map((path) => rewriteBackend.request(path)));
  for (const read of retained) expect(read.status).toBe(200);
  const draft = '生成尚未完成也必须清除的合成讨论。';
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(draft);
  await setWorkspaceTone(helper, 'polite');
  await fillWorkspaceInstruction(helper, '生成中删除时清除的合成要求。');
  await rewriteBackend.plan({ count: 1, prefix: '删除后不可复活的合成候选' });
  await rewriteBackend.command('hold');
  try {
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '正在等待本次生成结果' })).toBeVisible();
    await expect.poll(async () => (await rewriteBackend.command('observations')).model_entered).toBe(true);
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expandSavedDiscussion(helper);
    await expect(helper.getByText('本轮生成尚未完成。', { exact: true })).toBeVisible();
    const state = await helper.evaluate(async () => window.notalone.replies.getState());
    const sessionId = state.savedSession!.sessionId!;
    const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}`;
    expect((await rewriteBackend.request(path)).data.turns).toEqual([expect.objectContaining({ state: 'running', reply: null })]);
    await confirmDeletion(helper);
    await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
    expect(await rewriteBackend.request(path)).toEqual({ status: 404, data: { error: 'not_found' } });
    await expectDeletionCleared(helper);
    await rewriteBackend.command('release');
    await expect.poll(() => replyTransport.results.length).toBe(1);
    expect(replyTransport.results[0].status).not.toBe(200);
    await expect(helper.getByText('删除后不可复活的合成候选（说法1）。', { exact: true })).toHaveCount(0);
    await expectDeletionCleared(helper);
    const oldRequest = replyTransport.requests[0];
    expect(await rewriteBackend.request('/api/reply/generate', oldRequest)).toEqual({ status: 409, data: { error: 'reply_input_invalidated' } });
    expect(await Promise.all(retainedPaths.map((endpoint) => rewriteBackend.request(endpoint)))).toEqual(retained);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

    replyTransport.failRuntime = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    replyTransport.failRuntime = false;
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    await chooseDeletionContact(pages);
    const freshId = await expectEmptyRecovery(helper, contactId, sessionId);
    const freshPath = `/api/contacts/${contactId}/assistant-sessions/${freshId}`;
    expect((await rewriteBackend.request(freshPath)).data).toMatchObject({ turns: [], inputs: [] });
    expect((await rewriteBackend.request(`${freshPath}/replies`, oldRequest)).status).not.toBe(200);
    expect((await rewriteBackend.request(freshPath)).data).toMatchObject({ turns: [], inputs: [] });
    expect(await rewriteBackend.request(path)).toEqual({ status: 404, data: { error: 'not_found' } });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

    await host.close();
    await rewriteBackend.command('restart');
    const rebuilt = new PageHost(await browser.newContext(), origin, userData);
    try {
      await rebuilt.backend.connect();
      const nextManager = await rebuilt.open('manager');
      await expect(nextManager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue('');
      await nextManager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
      const nextHelper = await rebuilt.open('helper');
      await confirmHelperContact(nextHelper, contactId);
      const rebuiltId = await expectEmptyRecovery(nextHelper, contactId, sessionId);
      expect((await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${rebuiltId}`)).data)
        .toMatchObject({ turns: [], inputs: [] });
      expect(await rewriteBackend.request(path)).toEqual({ status: 404, data: { error: 'not_found' } });
      expect(await Promise.all(retainedPaths.map((endpoint) => rewriteBackend.request(endpoint)))).toEqual(retained);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    } finally { await rebuilt.close(); }
  } finally { replyTransport.failRuntime = false; await rewriteBackend.command('release'); }
}

async function completedResponseHeld(pages: RewritePages) {
  const { helper, rewriteBackend, replyTransport } = pages;
  await chooseDeletionContact(pages);
  const contactId = rewriteBackend.data.contact_ids[0];
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('候选已保存但响应迟到的合成讨论。');
  await rewriteBackend.plan({ count: 1, prefix: '已保存但迟到的合成候选' });
  const heldBefore = replyTransport.heldCount;
  replyTransport.nextReply = 'hold';
  try {
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.results.at(-1)?.status).toBe(200);
    const oldRequest = replyTransport.requests[0];
    const baseline = await rewriteBackend.request('/api/reply/generate', oldRequest);
    expect(baseline.status).toBe(200);
    expect(baseline.data.reply_request_id).toBe(replyTransport.results[0].data.reply_request_id);
    expect(baseline.data.candidates).toEqual(replyTransport.results[0].data.candidates);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expandSavedDiscussion(helper);
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
      .getByText('已保存但迟到的合成候选（说法1）。', { exact: true })).toBeVisible();
    const state = await helper.evaluate(async () => window.notalone.replies.getState());
    const path = `/api/contacts/${contactId}/assistant-sessions/${state.savedSession!.sessionId!}`;
    await confirmDeletion(helper);
    await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
    replyTransport.release();
    expect(await rewriteBackend.request(path)).toEqual({ status: 404, data: { error: 'not_found' } });
    expect(await rewriteBackend.request('/api/reply/generate', oldRequest)).toEqual({ status: 409, data: { error: 'reply_input_invalidated' } });
    await expectDeletionCleared(helper);
    await expect(helper.getByText('已保存但迟到的合成候选（说法1）。', { exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { replyTransport.release(); }
}

async function staleDeletionVerification(pages: RewritePages, change: 'contact' | 'session' | 'connection') {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  const saved = await saveDeletionDiscussion(pages, '旧范围待复验删除的合成讨论。', '旧范围待清除的合成候选');
  const heldBefore = replyTransport.heldCount;
  replyTransport.nextSessionRead = 'hold';
  try {
    await confirmDeletion(helper);
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.sessionDeletes.at(-1)).toEqual({ path: saved.path, status: 200 });
    expect(replyTransport.sessionReads.at(-1)?.status).toBe(404);
    await expect(helper.getByRole('status').filter({ hasText: '正在删除并核对助手会话' })).toBeVisible();
    if (change === 'connection') {
      replyTransport.failRuntime = true;
      await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      replyTransport.failRuntime = false;
      await manager.getByRole('button', { name: '重试连接', exact: true }).click();
      await chooseDeletionContact(pages);
    } else {
      await chooseDeletionContact(pages, 1);
      if (change === 'session') await chooseDeletionContact(pages);
    }
    const currentId = rewriteBackend.data.contact_ids[change === 'contact' ? 1 : 0];
    const draft = '新范围不能被旧删除结果清除的合成草稿。';
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(draft);
    await fillWorkspaceInstruction(helper, '新范围保留的合成要求。');
    const current = await helper.evaluate(async () => window.notalone.replies.getState());
    expect(current.savedSession!.sessionId).not.toBe(saved.sessionId);
    const currentPath = `/api/contacts/${currentId}/assistant-sessions/${current.savedSession!.sessionId!}`;
    expect((await rewriteBackend.request(currentPath)).status).toBe(200);
    replyTransport.release();
    expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue(draft);
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('新范围保留的合成要求。');
    await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
    await expect(helper.getByText('旧范围待复验删除的合成讨论。', { exact: true })).toHaveCount(0);
    expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
      contactId: currentId, scopeRevision: current.scopeRevision, result: null,
      savedSession: { phase: 'ready', sessionId: current.savedSession!.sessionId, turns: [] },
    });
    expect((await rewriteBackend.request(currentPath)).data).toMatchObject({ turns: [], inputs: [] });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { replyTransport.failRuntime = false; replyTransport.release(); }
}

export async function assistantSessionDeletionLifecycle(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: RewritePages, host: PageHost, userData: string) => Promise<void>]> = [
    ['真实生成中删除禁止迟到写回与旧键重播，重连重建无旧缓存且独立资料保留',
      (pages, host, userData) => runningDeletion(pages, host, userData, browser, origin)],
    ['已保存候选的迟到HTTP响应不能复活已删除讨论', completedResponseHeld],
    ['删除复验迟到不能清除另一个联系人的新草稿', (pages) => staleDeletionVerification(pages, 'contact')],
    ['同联系人切换到新会话后旧删除复验不能清除新草稿', (pages) => staleDeletionVerification(pages, 'session')],
    ['连接变化后旧删除复验不能清除重连后的新草稿', (pages) => staleDeletionVerification(pages, 'connection')],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
