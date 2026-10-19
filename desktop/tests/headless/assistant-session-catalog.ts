import { fillWorkspaceInstruction, setWorkspaceTone, fillWorkspaceThought, generateWorkspace, setWorkspaceContext, openWorkspaceSettings } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { randomUUID } from 'node:crypto';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { withRewritePages } from './rewrite-acceptance';

async function chooseContact({ manager, helper, rewriteBackend }: RewritePages, index: 0 | 1 = 0) {
  await manager.getByRole('button', { name: index === 0 ? '选择合成联系人甲' : '选择合成联系人乙', exact: true }).click();
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[index]);
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase)).toBe('ready');
}
async function saveDraft(pages: RewritePages) {
  await chooseContact(pages);
  await pages.helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('目录中保留的合成旧草稿。');
  await pages.rewriteBackend.plan({ count: 1, prefix: '目录中保留的合成旧候选' });
  await pages.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('目录中保留的合成旧候选（说法1）。');
  expect(pages.replyTransport.requests.at(-1)).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express' } });
  await openAssistantHistory(pages.helper);
  await pages.helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(pages.helper);
  await expect(pages.helper.getByRole('article', { name: '第1轮讨论', exact: true })).toBeVisible();
  return (await pages.helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
}
async function listSessions(helper: Page) {
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '刷新会话列表', exact: true }).click();
  await expect(helper.getByRole('list', { name: '助手会话目录', exact: true })).toBeVisible();
}
async function selectSession(helper: Page, sessionId: string) {
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: `查看会话 ${sessionId}`, exact: true }).click();
  await expect.poll(() => helper.evaluate(async () => { const state = await window.notalone.replies.getState();
    return { sessionId: state.savedSession?.sessionId, read: state.savedSession?.phase,
      catalog: state.sessionCatalog?.phase, pending: state.sessionCatalog?.selectionPending }; })).toEqual({
    sessionId, read: 'ready', catalog: 'ready', pending: false });
  // 切换完成会替换旧历史 DOM；先等新记录挂载，再通过 summary 展开对应讨论。
  const saved = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!;
  await expect(helper.locator('.session-history .session-entry-details')).toHaveCount(saved.inputs.length);
  await expandSavedDiscussion(helper);
}

export async function assistantSessionCatalog(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 显式新开空会话与选择旧候选，生成沿实际选择的 ID\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { helper, rewriteBackend } = pages, oldId = await saveDraft(pages);
    const contactId = rewriteBackend.data.contact_ids[0], path = `/api/contacts/${contactId}/assistant-sessions`;
    const before = (await rewriteBackend.request(`${path}/${oldId}`)).data;
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('尚未提交的临时合成草稿。');
    await setWorkspaceTone(helper, 'polite');
    await fillWorkspaceInstruction(helper, '不要搬入新会话的要求。');
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    await expect.poll(() => helper.evaluate(async (sid) => { const state = await window.notalone.replies.getState();
      return state.savedSession?.sessionId !== sid && state.sessionCatalog?.phase === 'ready'; }, oldId)).toBe(true);
    await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
    const opened = (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!;
    expect(opened).toMatchObject({ phase: 'ready', turns: [], inputs: [], currentInputVersionId: null });
    expect(opened.sessionId).not.toBe(oldId);
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    await openWorkspaceSettings(helper);
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
    await expect(helper.getByRole('combobox', { name: '本次语气', exact: true })).toHaveValue('original');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await listSessions(helper); await selectSession(helper, oldId);
    await expect(helper.getByRole('article', { name: '第1轮讨论', exact: true }).getByText('目录中保留的合成旧候选（说法1）。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue('目录中保留的合成旧候选（说法1）。');
    expect((await rewriteBackend.request(`${path}/${oldId}`)).data).toEqual(before);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    // 另一客户端改变 current；本次 UI 仍沿显式选择的实际 ID 生成。
    expect((await rewriteBackend.request(path, {})).status).toBe(200);
    await fillWorkspaceThought(helper, '');
    await rewriteBackend.plan({ count: 1, prefix: '属于显式旧会话的新候选' });
    await generateWorkspace(helper, 'suggest');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('属于显式旧会话的新候选（说法1）。');
    expect(pages.replyTransport.requests.at(-1)).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'suggest', draft_text: '' } });
    expect((await helper.evaluate(async () => window.notalone.replies.getState())).result?.assistantSessionId).toBe(oldId);
    expect(((await rewriteBackend.request(`${path}/${oldId}`)).data.turns as unknown[])).toHaveLength(2);
  });
  process.stdout.write('page_test_scenario: 旧纯讨论完整可见，切换清临时策略状态且撤销绑定仍可查看\n');
  await withRewritePages(browser, origin, async (pages) => {
    await chooseContact(pages);
    const { helper, rewriteBackend } = pages, contactId = rewriteBackend.data.contact_ids[0];
    const oldId = (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
    const path = `/api/contacts/${contactId}/assistant-sessions`;
    // 只准备旧版本历史兼容记录；当前界面的新输入仍必须通过统一工作区。
    const content = { type: 'purpose_exploration', purpose_hint: '旧纯讨论的完整合成目的。', correction: '合成纠正：只问近况。',
      requirements: '旧纯讨论要求：不安排见面。', answer: '旧纯讨论回答：稍后再聊。', confirmed_intent: '旧纯讨论意愿：问候。', skill_mode: 'disabled', skill_version_id: null };
    const recorded = await rewriteBackend.request(`${path}/${oldId}/inputs`, { content });
    expect(recorded.status).toBe(200);
    await fillWorkspaceThought(helper, '未提交的合成想法。');
    await fillWorkspaceInstruction(helper, '未提交的合成本次要求。');
    await setWorkspaceContext(helper, true);
    await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('未提交的合成聊天背景。');
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    await expect.poll(() => helper.evaluate(async (sid) => { const state = await window.notalone.replies.getState();
      return state.savedSession?.sessionId !== sid && state.sessionCatalog?.phase === 'ready'; }, oldId)).toBe(true);
    await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
    expect(await helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({ direction: '', purpose: '', correction: '',
      requirements: '', clarificationAnswer: '', exploration: { phase: 'idle', result: null }, skillChoice: { mode: 'auto', versionId: null } });
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    await openWorkspaceSettings(helper);
    await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
    expect((await helper.evaluate(() => window.notalone.replies.getState())).options.contextText ?? '').toBe('');
    await rewriteBackend.command('revoke', { contact_id: contactId });
    await listSessions(helper); await selectSession(helper, oldId);
    const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
    for (const text of [content.purpose_hint, [content.correction, content.requirements].join('\n'), content.answer, content.confirmed_intent]) {
      await expect(discussion.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(discussion.getByRole('article', { name: '第1轮讨论', exact: true })).toHaveCount(0);
    await expect(discussion.getByText('当前会话还没有讨论。', { exact: true })).toHaveCount(0);
    const saved = (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!;
    expect(saved.currentInputVersionId).toBe(recorded.data.input_version_id);
    expect(saved.inputs).toHaveLength(1); expect(saved.turns).toEqual([]);
    expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
    expect((await rewriteBackend.request(`${path}/${oldId}/replies`, { contact_id: contactId, idempotency_key: randomUUID(),
      content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express', draft_text: '撤销绑定后不能生成。', user_instruction: null,
        include_relationship_context: false } })).status).toBe(409);
  });
}

export async function assistantSessionCatalogGuards(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 切换读取失败保留编辑与候选，明确重选后恢复\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { helper, rewriteBackend, replyTransport } = pages, oldId = await saveDraft(pages);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('切换失败应保留的合成草稿。');
    await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('切换失败应保留的候选编辑。');
    await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).blur();
    await expect(helper.getByRole('group', { name: '说法1消息组', exact: true }).getByText('修改版本 1', { exact: true })).toBeVisible();
    replyTransport.failSessionReads = true;
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    await expect(helper.getByText('助手会话操作尚未确认，请刷新列表后明确选择会话。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('切换失败应保留的合成草稿。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('切换失败应保留的候选编辑。');
    expect((await helper.evaluate(async () => window.notalone.replies.getState())).savedSession?.sessionId).toBe(oldId);
    const contactId = rewriteBackend.data.contact_ids[0], path = `/api/contacts/${contactId}/assistant-sessions`;
    const listed = await rewriteBackend.request(path); expect(listed.data.current_session_id).not.toBe(oldId);
    replyTransport.failSessionReads = false;
    await listSessions(helper); await selectSession(helper, oldId);
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    await expect(helper.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue('切换失败应保留的候选编辑。');
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });
  process.stdout.write('page_test_scenario: 跨范围和未知 ID 拒绝，不切换草稿；迟到读取不带入下一联系人\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { helper, manager, rewriteBackend, replyTransport } = pages;
    await chooseContact(pages, 1);
    const foreignId = (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
    await chooseContact(pages);
    const oldId = (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('甲的保留草稿。');
    for (const sessionId of [foreignId, randomUUID()]) {
      await helper.evaluate(async (sid) => { const contact = await window.notalone.contacts.getState();
        await window.notalone.replies.selectSavedSession({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision, sessionId: sid }); }, sessionId);
      await expect(helper.getByText('助手会话操作尚未确认，请刷新列表后明确选择会话。', { exact: true })).toBeVisible();
      await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('甲的保留草稿。');
      expect((await helper.evaluate(async () => window.notalone.replies.getState())).savedSession?.sessionId).toBe(oldId);
      await listSessions(helper); await selectSession(helper, oldId);
      await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('甲的保留草稿。');
    }
    replyTransport.nextSessionRead = 'hold'; const held = replyTransport.heldCount;
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    await expect.poll(() => replyTransport.heldCount).toBe(held + 1);
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[1]);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('乙的新合成草稿。');
    replyTransport.release();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.sessionId)).toBe(foreignId);
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('乙的新合成草稿。');
    expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
  });
  process.stdout.write('page_test_scenario: 无记录目录不隐式创建，未绑定联系人不能借新开授权生成\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    const contactId = rewriteBackend.data.empty_contact_id;
    await manager.getByRole('button', { name: '选择无消息的合成联系人', exact: true }).click();
    // 本场明确检验未授权联系人，不能用人工确认帮助函数改变待验证的前提。
    const readAuthorization = () => helper.evaluate(async () => {
      const contact = await window.notalone.contacts.getState();
      const foreground = await window.notalone.foreground.getState();
      const reply = await window.notalone.replies.getState();
      return { contactId: contact.selectedContactId, confirmation: foreground.confirmation,
        confirmedContactId: foreground.confirmedContactId, foregroundBlock: foreground.generationBlock,
        replyContactId: reply.contactId, scopeMatches: reply.scopeRevision === contact.scopeRevision,
        replyBlock: reply.generationBlock };
    });
    const unauthorized = { contactId, confirmation: 'required', confirmedContactId: null,
      foregroundBlock: 'foreground-confirmation-required', replyContactId: contactId,
      scopeMatches: true, replyBlock: 'foreground-confirmation-required' };
    await expect.poll(readAuthorization).toEqual(unauthorized);
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase)).toBe('failed');
    const path = `/api/contacts/${contactId}/assistant-sessions`;
    for (let count = 0; count < 2; count++) {
      await listSessions(helper);
      await expect(helper.getByText('这位联系人还没有助手会话。', { exact: true })).toBeVisible();
      expect((await rewriteBackend.request(path)).data).toEqual({ sessions: [], current_session_id: null });
    }
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    await expect(helper.getByText('助手会话操作尚未确认，请刷新列表后明确选择会话。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
    expect(await rewriteBackend.request(path, {})).toEqual({ status: 409,
      data: { error: 'assistant_session_rejected', reason: 'no_active_binding' } });
    expect((await rewriteBackend.request(path)).data).toEqual({ sessions: [], current_session_id: null });
    await expect.poll(readAuthorization).toEqual(unauthorized);
    expect(replyTransport.requests).toEqual([]);
    expect(replyTransport.explorationRequests).toEqual([]);
    expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
  });
}
