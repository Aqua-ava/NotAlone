import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { randomUUID } from 'node:crypto';
import { expect, type Browser } from '@playwright/test';
import type { RewritePages } from '../rewrite-page-scenarios';
import { confirmDeletion, deleteFixtureSession, expectDeletionCleared, saveDeletionDiscussion } from './assistant-session-deletion-support';
import { withRewritePages } from './rewrite-acceptance';

async function deleteTransportFailure(pages: RewritePages) {
  const { helper, rewriteBackend, replyTransport } = pages;
  const draft = '传输失败后保留以便确认的合成讨论。';
  const saved = await saveDeletionDiscussion(pages, draft, '传输重试的合成候选', true);
  replyTransport.failSessionDeletes = saved.path;
  try {
    await confirmDeletion(helper);
    await expect(helper.getByRole('alert').filter({ hasText: '助手会话删除尚未确认完成' })).toBeVisible();
    expect(replyTransport.sessionDeletes.at(-1)).toEqual({ path: saved.path, status: 503 });
    expect(replyTransport.sessionReads.at(-1)?.status).toBe(200);
    expect((await rewriteBackend.request(saved.path)).status).toBe(200);
    await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue(draft);
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('会话删除时也要清除的合成要求。');
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    const strategyPosts = replyTransport.explorationRequests.length;
    const blocked = await helper.evaluate(async () => {
      const contact = await window.notalone.contacts.getState();
      const scope = { contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision };
      await window.notalone.replies.setMode({ ...scope, mode: 'initiate_conversation' });
      await window.notalone.replies.updatePurpose({ ...scope, purpose: '核对删除中的合成测试安排。' });
      const rejected = [];
      for (const action of [() => window.notalone.replies.explore(scope),
        () => window.notalone.replies.changeDirections(scope), () => window.notalone.replies.generate({ ...scope, newRequest: true })]) {
        try { await action(); rejected.push(false); } catch { rejected.push(true); }
      }
      await window.notalone.replies.retryExploration(scope);
      await window.notalone.replies.setMode({ ...scope, mode: 'rewrite_draft' });
      return rejected;
    });
    expect(blocked).toEqual([true, true, true]);
    expect(replyTransport.explorationRequests).toHaveLength(strategyPosts);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    replyTransport.failSessionDeletes = null;
    await helper.getByRole('button', { name: '重试删除会话', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
    expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
    await expectDeletionCleared(helper);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { replyTransport.failSessionDeletes = null; }
}

async function deletionVerificationFailure(pages: RewritePages) {
  const { helper, rewriteBackend, replyTransport } = pages;
  const draft = '删除已提交但尚未复验的合成讨论。';
  const saved = await saveDeletionDiscussion(pages, draft, '复验失败的合成候选');
  replyTransport.failSessionReads = true;
  try {
    await confirmDeletion(helper);
    await expect(helper.getByRole('alert').filter({ hasText: '助手会话删除尚未确认完成' })).toBeVisible();
    expect(replyTransport.sessionDeletes.at(-1)).toEqual({ path: saved.path, status: 200 });
    expect(replyTransport.sessionReads.at(-1)?.status).toBe(503);
    await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue(draft);
    expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
      sessionDeletion: 'failed', savedSession: { sessionId: saved.sessionId, turns: [] },
    });
    replyTransport.failSessionReads = false;
    expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
    await expect(helper.getByRole('button', { name: '重试删除会话', exact: true })).toBeVisible();
    await helper.getByRole('button', { name: '重试删除会话', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已不存在' })).toBeVisible();
    expect(replyTransport.sessionDeletes.at(-1)).toEqual({ path: saved.path, status: 404 });
    await expectDeletionCleared(helper);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { replyTransport.failSessionReads = false; }
}

async function knownSessionOnly(pages: RewritePages) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  const saved = await saveDeletionDiscussion(pages, '另一个确认客户端删除的合成讨论。', '已知会话的合成候选');
  const before = replyTransport.sessionDeletes.length;
  const rejected = await helper.evaluate(async ({ saved, unknownId, foreignId, otherId, ownerId }) => {
    const state = await window.notalone.contacts.getState();
    const command = { contactId: saved.contactId, scopeRevision: state.scopeRevision, sessionId: saved.sessionId, confirmed: true };
    const remove = window.notalone.replies.deleteSavedSession as (value: unknown) => Promise<void>;
    const invalid = [
      { ...command, confirmed: false }, { ...command, ownerId },
      { ...command, contactId: otherId }, { ...command, contactId: foreignId },
      { ...command, scopeRevision: state.scopeRevision + 1 }, { ...command, sessionId: unknownId },
    ];
    return Promise.all(invalid.map(async (value) => { try { await remove(value); return false; } catch { return true; } }));
  }, { saved, unknownId: randomUUID(), foreignId: rewriteBackend.data.other_contact_id,
    otherId: rewriteBackend.data.contact_ids[1], ownerId: rewriteBackend.data.owner_id });
  expect(rejected).toEqual(Array(6).fill(true));
  expect(await manager.evaluate(async ({ saved }) => {
    const state = await window.notalone.contacts.getState();
    try { await window.notalone.replies.deleteSavedSession({ contactId: saved.contactId, scopeRevision: state.scopeRevision,
      sessionId: saved.sessionId, confirmed: true }); return false; } catch { return true; }
  }, { saved })).toBe(true);
  expect(replyTransport.sessionDeletes).toHaveLength(before);
  for (const contactId of [rewriteBackend.data.contact_ids[1], rewriteBackend.data.other_contact_id]) {
    expect(await deleteFixtureSession(rewriteBackend, contactId, saved.sessionId)).toEqual({ status: 404, data: { error: 'not_found' } });
  }
  expect((await rewriteBackend.request(saved.path)).status).toBe(200);
  expect(await deleteFixtureSession(rewriteBackend, saved.contactId, saved.sessionId)).toEqual({
    status: 200, data: { session_id: saved.sessionId, state: 'deleted' },
  });
  await confirmDeletion(helper);
  await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已不存在' })).toBeVisible();
  expect(replyTransport.sessionDeletes.at(-1)).toEqual({ path: saved.path, status: 404 });
  await expectDeletionCleared(helper);
  expect(await deleteFixtureSession(rewriteBackend, saved.contactId, saved.sessionId)).toEqual({ status: 404, data: { error: 'not_found' } });
  expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
}

async function newSessionClearsDeletionNotice(pages: RewritePages) {
  const { helper, rewriteBackend } = pages;
  const saved = await saveDeletionDiscussion(pages, '删除提示只属于旧会话的合成讨论。', '旧会话的合成候选');
  await confirmDeletion(helper);
  await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
  expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
  const deleted = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(deleted.confirmedSessionDeletion).toMatchObject({ sessionId: saved.sessionId, contactId: saved.contactId,
    scopeRevision: deleted.scopeRevision });
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
  const restored = await helper.evaluate(async () => window.notalone.replies.getState());
  const freshId = restored.savedSession!.sessionId!;
  expect(freshId).not.toBe(saved.sessionId);
  expect((await rewriteBackend.request(`/api/contacts/${saved.contactId}/assistant-sessions/${freshId}`)).data)
    .toMatchObject({ turns: [], inputs: [] });
  await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
  expect(restored.confirmedSessionDeletion).toEqual(deleted.confirmedSessionDeletion);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);

  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('读取新会话后明确生成的合成草稿。');
  await rewriteBackend.plan({ count: 1, prefix: '读取后新会话的合成候选' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('读取后新会话的合成候选（说法1）。');
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  await confirmDeletion(helper);
  await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
  const deletedAgain = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(deletedAgain.confirmedSessionDeletion!.sessionId).toBe(freshId);
  expect(await rewriteBackend.request(`/api/contacts/${saved.contactId}/assistant-sessions/${freshId}`))
    .toEqual({ status: 404, data: { error: 'not_found' } });
  // 不读取默认会话，用户明确生成时也会采用新的 sid；历史清除回执保持独立。
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('直接明确生成下一会话的合成草稿。');
  await rewriteBackend.plan({ count: 1, prefix: '直接生成新会话的合成候选' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('直接生成新会话的合成候选（说法1）。');
  const generated = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(generated.savedSession!.sessionId).not.toBe(freshId);
  expect((await rewriteBackend.request(`/api/contacts/${saved.contactId}/assistant-sessions/${generated.savedSession!.sessionId!}`)).status).toBe(200);
  await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
  expect(generated.confirmedSessionDeletion).toEqual(deletedAgain.confirmedSessionDeletion);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
}

async function unsavedCandidateCopy(pages: RewritePages, copies: string[]) {
  const { helper, rewriteBackend } = pages;
  const saved = await saveDeletionDiscussion(pages, '核对删除后旧复制来源的合成讨论。', '未保存副本的合成候选');
  await helper.getByRole('group', { name: '说法1消息组', exact: true }).getByRole('button', { name: '复制第1条', exact: true }).click();
  await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toBeVisible();
  expect(copies).toEqual(['未保存副本的合成候选（说法1）。']);
  await confirmDeletion(helper);
  await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
  await expectDeletionCleared(helper);
  expect(await rewriteBackend.request(saved.path)).toEqual({ status: 404, data: { error: 'not_found' } });
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();

  await expandSavedDiscussion(helper);
  await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
  const fresh = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(fresh.savedSession!.sessionId).not.toBe(saved.sessionId);
  expect((await rewriteBackend.request(`/api/contacts/${saved.contactId}/assistant-sessions/${fresh.savedSession!.sessionId!}`)).data)
    .toMatchObject({ turns: [], inputs: [] });
  await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('用户明确发起的新会话合成草稿。');
  await rewriteBackend.plan({ count: 1, prefix: '新会话的独立合成候选' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('新会话的独立合成候选（说法1）。');
  await expect(helper.getByRole('status').filter({ hasText: /当前助手会话已删除|当前助手会话已不存在/ })).toHaveCount(0);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
}

export async function assistantSessionDeletionFaults(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: RewritePages) => Promise<void>]> = [
    ['删除传输失败保留输入，实际仍可读时只允许重试', deleteTransportFailure],
    ['删除已提交但复验失败不能宣称完成，重试已知404后才清空', deletionVerificationFailure],
    ['重复或外部删除只对已读且确认的会话生效，其他角色与范围拒绝', knownSessionOnly],
    ['删除后读取或显式生成采用新会话时不继承旧删除提示', newSessionClearsDeletionNotice],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
  const name = '删除清除候选与来源投影，新会话不显示旧删除状态';
  const copies: string[] = [];
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, (pages) => unsavedCandidateCopy(pages, copies), {
    async writeText(text) { copies.push(text); }, hideWindow() { throw new Error('本轮复制测试不收起窗口。'); },
  });
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
