import { fillWorkspaceThought, fillWorkspaceInstruction, generateWorkspace, setWorkspaceContext } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';

const candidateEditor = (page: Page, number = 1) => page.getByRole('group', { name: `说法${number}消息组`, exact: true }).getByRole('textbox');

async function chooseContact({ manager, helper, rewriteBackend }: RewritePages, index: 0 | 1 = 0) {
  await manager.getByRole('button', { name: index === 0 ? '选择合成联系人甲' : '选择合成联系人乙', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[index]);
}

async function saveDraft(pages: RewritePages, draft: string, prefix: string) {
  await chooseContact(pages);
  await fillWorkspaceThought(pages.helper, draft);
  await setWorkspaceContext(pages.helper, false);
  await pages.rewriteBackend.plan({ count: 1, prefix });
  await generateWorkspace(pages.helper, 'express');
  await expect(candidateEditor(pages.helper))
    .toHaveValue(`${prefix}（说法1）。`);
}

async function saveDependentReply(pages: RewritePages) {
  await chooseContact(pages);
  await fillWorkspaceThought(pages.helper, '依赖来源的恢复讨论。');
  await setWorkspaceContext(pages.helper, true);
  await pages.rewriteBackend.plan({ count: 1, prefix: '依赖来源的恢复候选' });
  await generateWorkspace(pages.helper, 'express');
  await expect(candidateEditor(pages.helper))
    .toHaveValue('依赖来源的恢复候选（说法1）。');
}

function readSavedDiscussion(helper: Page) {
  return helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    await window.notalone.replies.readSavedSession({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision });
  });
}

async function expectRecoveredDiscussion(helper: Page) {
  await expandSavedDiscussion(helper);
  const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
  await expect(discussion.getByText('已保存的合成讨论：明天再确认。', { exact: true })).toBeVisible();
  await expect(discussion.getByText('跨连接保存的合成候选（说法1）。', { exact: true })).toBeVisible();
  await expect(discussion.getByText('跨连接保存的合成候选（说法2）。', { exact: true })).toBeVisible();
  await expect(discussion.getByRole('article')).toHaveCount(1);
  await expect(candidateEditor(helper)).toHaveValue('跨连接可靠保存的合成编辑。');
  await expect(helper.getByRole('group', { name: '说法1消息组', exact: true }).getByText('修改版本 1', { exact: true })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
  await expect(candidateEditor(helper)).not.toHaveValue('未保存的合成编辑。');
  expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
    result: null, selectedCandidateId: null, direction: '', purpose: '', canRetry: false,
  });
}

// 使用同一合成联系人和 PostgreSQL；重建宿主只替换必要生命周期输入。
export async function assistantSessionRecovery(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 重连与重开恢复原讨论和已保存候选版本，丢弃未保存编辑\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }, host, userData) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('已保存的合成讨论：明天再确认。');
    await rewriteBackend.plan({ count: 2, prefix: '跨连接保存的合成候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(candidateEditor(helper))
      .toHaveValue('跨连接保存的合成候选（说法1）。');
    await candidateEditor(helper).fill('跨连接可靠保存的合成编辑。');
    await candidateEditor(helper).blur();
    await expect(helper.getByRole('group', { name: '说法1消息组', exact: true })
      .getByText('修改版本 1', { exact: true })).toBeVisible();
    await fillWorkspaceThought(helper, '未提交的新合成草稿。');
    await fillWorkspaceInstruction(helper, '未提交的合成要求。');
    await helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('polite');
    // 最后一次编辑保持焦点，断线前不触发失焦保存。
    await candidateEditor(helper).fill('未保存的合成编辑。');
    await expect(helper.getByRole('group', { name: '说法1消息组', exact: true })
      .getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();

    replyTransport.failRuntime = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })).toHaveCount(0);
    replyTransport.failRuntime = false;
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await expectRecoveredDiscussion(helper);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

    await host.close();
    await rewriteBackend.command('restart');
    const reopened = new PageHost(await browser.newContext(), origin, userData);
    try {
      await reopened.backend.connect();
      const nextManager = await reopened.open('manager');
      await expect(nextManager.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
      await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      const nextHelper = await reopened.open('helper');
      await confirmHelperContact(nextHelper, contactId);
      await expectRecoveredDiscussion(nextHelper);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    } finally { await reopened.close(); }
  });
  process.stdout.write('page_test_scenario_passed: 重连与重开恢复原讨论和已保存候选版本，丢弃未保存编辑\n');
}

async function contactScope(pages: RewritePages) {
  const { helper, rewriteBackend, replyTransport } = pages;
  await saveDraft(pages, '甲的已保存讨论。', '甲的恢复候选');
  await readSavedDiscussion(helper);
  replyTransport.nextSessionRead = 'hold';
  const heldBefore = replyTransport.heldCount;
  const pending = readSavedDiscussion(helper);
  try {
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.sessionReads.at(-1)).toEqual({ status: 200, states: ['completed'] });
    await chooseContact(pages, 1);
    await openAssistantHistory(helper);
    await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
    replyTransport.release();
    await pending;
    await expect(helper.getByText('甲的已保存讨论。', { exact: true })).toHaveCount(0);
    await expect(helper.getByText('甲的恢复候选（说法1）。', { exact: true })).toHaveCount(0);
    expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
      contactId: rewriteBackend.data.contact_ids[1], result: null, savedSession: { phase: 'ready', turns: [] },
    });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { replyTransport.release(); await pending; }
}

async function staleConnection(pages: RewritePages) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  await saveDependentReply(pages);
  await readSavedDiscussion(helper);
  replyTransport.nextSessionRead = 'hold';
  const heldBefore = replyTransport.heldCount;
  const pending = readSavedDiscussion(helper);
  try {
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.sessionReads.at(-1)).toEqual({ status: 200, states: ['completed'] });
    replyTransport.failRuntime = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    await rewriteBackend.command('withdraw_target_source');
    replyTransport.failRuntime = false;
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    await chooseContact(pages);
    await expandSavedDiscussion(helper);
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
      .getByText('相关来源不可用', { exact: true })).toBeVisible();
    replyTransport.release();
    await pending;
    await expect(helper.getByText('依赖来源的恢复讨论。', { exact: true })).toHaveCount(0);
    await expect(helper.getByText('依赖来源的恢复候选（说法1）。', { exact: true })).toHaveCount(0);
    await expect(candidateEditor(helper)).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { replyTransport.failRuntime = false; replyTransport.release(); await pending; }
}

async function runningRequest(pages: RewritePages) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  await chooseContact(pages);
  await openAssistantHistory(helper);
  await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('已经保存但尚未完成的合成输入。');
  await rewriteBackend.command('hold');
  await rewriteBackend.plan({ count: 1, prefix: '用户读取后才显示的原候选' });
  const pending = helper.evaluate(async () => {
    const contact = await window.notalone.contacts.getState();
    await window.notalone.replies.generate({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision, newRequest: true, workspaceAction: 'express' });
  });
  try {
    await expect(helper.getByRole('status').filter({ hasText: '正在等待本次生成结果' })).toBeVisible();
    await readSavedDiscussion(helper);
    await expandSavedDiscussion(helper);
    await expect(helper.getByText('本轮生成尚未完成。', { exact: true })).toBeVisible();
    replyTransport.failRuntime = true;
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    replyTransport.failRuntime = false;
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    await chooseContact(pages);
    await expandSavedDiscussion(helper);
    await expect(helper.getByText('本轮生成尚未完成。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
      .getByText('已经保存但尚未完成的合成输入。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    await expect(helper.getByRole('button', { name: '重试同一次生成', exact: true })).toHaveCount(0);
    expect(replyTransport.requests).toHaveLength(1);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(0);
    await rewriteBackend.command('release');
    await pending;
    await expect.poll(() => replyTransport.results.length).toBe(1);
    await readSavedDiscussion(helper);
    await expandSavedDiscussion(helper);
    await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
      .getByText('用户读取后才显示的原候选（说法1）。', { exact: true })).toBeVisible();
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    expect(replyTransport.requests).toHaveLength(1);
  } finally { replyTransport.failRuntime = false; await rewriteBackend.command('release'); await pending; }
}

async function deletedSource(pages: RewritePages, host: PageHost, userData: string, browser: Browser, origin: string) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  await saveDraft(pages, '不依赖来源的恢复讨论。', '不依赖来源的恢复候选');
  await saveDependentReply(pages);
  await chooseContact(pages, 1);
  await chooseContact(pages);
  await expandSavedDiscussion(helper);
  await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
    .getByText('依赖来源的恢复讨论。', { exact: true })).toBeVisible();
  replyTransport.nextSessionRead = 'hold';
  const heldBefore = replyTransport.heldCount;
  const pending = readSavedDiscussion(helper);
  try {
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.sessionReads.at(-1)).toEqual({ status: 200, states: ['completed', 'completed'] });
    await manager.getByRole('button', { name: '记忆', exact: true }).click();
    await selectMemoryCategory(manager, '来源与过程');
    const sources = manager.getByRole('region', { name: '来源删除管理', exact: true });
    await sources.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(sources.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
    await expect.poll(() => manager.evaluate(async () => (await window.notalone.sources.getState()).busySourceId)).toBeNull();
    await readSavedDiscussion(helper);
    replyTransport.release();
    await pending;
    await expandSavedDiscussion(helper);
    const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
    await expect(discussion.getByText('相关来源已删除', { exact: true })).toBeVisible();
    await expect(discussion.getByText('不依赖来源的恢复讨论。', { exact: true })).toBeVisible();
    await expect(discussion.getByText('不依赖来源的恢复候选（说法1）。', { exact: true })).toBeVisible();
    await expect(discussion.getByText('依赖来源的恢复讨论。', { exact: true })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('依赖来源的恢复讨论。');
    await expect(helper.getByText('依赖来源的恢复候选（说法1）。', { exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  } finally { replyTransport.release(); await pending; }
  await host.close();
  await rewriteBackend.command('restart');
  const reopened = new PageHost(await browser.newContext(), origin, userData);
  try {
    await reopened.backend.connect();
    const nextManager = await reopened.open('manager');
    await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    const nextHelper = await reopened.open('helper');
    await confirmHelperContact(nextHelper, rewriteBackend.data.contact_ids[0]);
    await expandSavedDiscussion(nextHelper);
    const discussion = nextHelper.getByRole('region', { name: '已保存的讨论', exact: true });
    await expect(discussion.getByText('相关来源已删除', { exact: true })).toBeVisible();
    await expect(discussion.getByText('不依赖来源的恢复讨论。', { exact: true })).toBeVisible();
    await expect(nextHelper.getByText('依赖来源的恢复讨论。', { exact: true })).toHaveCount(0);
    await expect(nextHelper.getByText('依赖来源的恢复候选（说法1）。', { exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  } finally { await reopened.close(); }
}

async function authorization(pages: RewritePages) {
  const { helper, rewriteBackend } = pages;
  await saveDraft(pages, '按真实联系人隔离的讨论。', '范围隔离的原候选');
  await readSavedDiscussion(helper);
  const state = await helper.evaluate(async () => window.notalone.replies.getState());
  const sessionId = state.savedSession!.sessionId;
  const other = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[1]}/assistant-sessions/${sessionId}`);
  expect(other).toEqual({ status: 404, data: { error: 'not_found' } });
  const foreign = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.other_contact_id}/assistant-session/default`, {});
  expect(foreign).toEqual({ status: 404, data: { error: 'not_found' } });
  await chooseContact(pages, 1);
  await rewriteBackend.command('revoke', { contact_id: rewriteBackend.data.contact_ids[0] });
  // 桌面绑定撤销后，按 ADR-065 显式确认手动范围；讨论读取仍按 owner/contact 隔离。
  await chooseContact(pages);
  await readSavedDiscussion(helper);
  await expandSavedDiscussion(helper);
  const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
  await expect(discussion.getByText('按真实联系人隔离的讨论。', { exact: true })).toBeVisible();
  await expect(discussion.getByText('范围隔离的原候选（说法1）。', { exact: true })).toBeVisible();
  expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
    contactId: rewriteBackend.data.contact_ids[0], savedSession: { phase: 'ready', sessionId },
  });
  expect(await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[1]}/assistant-sessions/${sessionId}`))
    .toEqual(other);
  expect(await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.other_contact_id}/assistant-session/default`, {}))
    .toEqual(foreign);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
}

async function readFailure(pages: RewritePages) {
  const { helper, rewriteBackend, replyTransport } = pages;
  await saveDraft(pages, '恢复读取失败不能沿用缓存。', '恢复读取成功的原候选');
  await chooseContact(pages, 1);
  await chooseContact(pages);
  await expandSavedDiscussion(helper);
  await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
    .getByText('恢复读取失败不能沿用缓存。', { exact: true })).toBeVisible();
  const candidate = candidateEditor(helper);
  await candidate.fill('读取暂时失败也应保留的合成候选编辑。');
  await candidate.blur();
  await expect(helper.getByRole('group', { name: '说法1消息组', exact: true })
    .getByText('修改版本 1', { exact: true })).toBeVisible();
  const beforeFailure = await helper.evaluate(async () => window.notalone.replies.getState());
  replyTransport.failSessionReads = true;
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect(helper.getByRole('alert').filter({ hasText: '已保存讨论暂不可用' })).toBeVisible();
  await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })).toHaveCount(0);
  await expect(helper.getByText('恢复读取失败不能沿用缓存。', { exact: true })).toHaveCount(0);
  // 503 只证明本次讨论读取未知，不撤销仍有效的候选和用户编辑。
  await expect(candidate).toHaveValue('读取暂时失败也应保留的合成候选编辑。');
  expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
    result: { replyRequestId: beforeFailure.result!.replyRequestId },
    savedSession: { phase: 'failed', turns: [], inputs: [], currentInputVersionId: null },
  });
  const attempts = replyTransport.sessionRequests.length;
  replyTransport.failSessionReads = false;
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('重试时保留的未提交草稿。');
  await expect(helper.getByRole('alert').filter({ hasText: '已保存讨论暂不可用' })).toBeVisible();
  expect(replyTransport.sessionRequests).toHaveLength(attempts);
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '重试读取已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
    .getByText('恢复读取成功的原候选（说法1）。', { exact: true })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('重试时保留的未提交草稿。');
  await expect(candidate).toHaveValue('读取暂时失败也应保留的合成候选编辑。');
  expect(replyTransport.sessionRequests).toHaveLength(attempts + 1);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
}

export async function assistantSessionRecoveryGuards(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: RewritePages, host: PageHost, userData: string) => Promise<void>]> = [
    ['迟到读取不能恢复其他联系人讨论', contactScope],
    ['断线前迟到读取不能复活来源已失效正文', staleConnection],
    ['恢复运行中记录不自动重试生成', runningRequest],
    ['来源删除后迟到读取与重开均保持无正文占位', (pages, host, userData) => deletedSource(pages, host, userData, browser, origin)],
    ['手动确认恢复按用户与联系人隔离，撤销桌面绑定不触发生成', authorization],
    ['读取失败隔离讨论并保留候选编辑，只在用户重试时重新读取', readFailure],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
