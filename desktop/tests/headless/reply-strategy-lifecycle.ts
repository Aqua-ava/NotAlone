import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { generateWorkspace } from '../workspace-actions';
import { withEventPages, type EventPages } from './message-events';
import { prepareWorkspaceTask, openWorkspaceTask, type WorkspaceAction } from './reply-strategy-bounded-updates';

async function reopen(manager: Page): Promise<Page> {
  const opened = manager.context().waitForEvent('page');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeVisible();
  return helper;
}
async function saved(pages: EventPages, sessionId: string) {
  const response = await pages.fixture.request(`/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}`);
  expect(response.status).toBe(200);
  if (!Array.isArray(response.data.turns)) throw new Error('本轮真实会话快照格式无效。');
  return { turns: response.data.turns, current_input_version_id: response.data.current_input_version_id };
}
async function noAutomaticAfterClose(pages: EventPages, action: WorkspaceAction) {
  await prepareWorkspaceTask(pages, action);
  const first = await openWorkspaceTask(pages, action, '小窗关闭前的合成候选');
  const before = await saved(pages, first.sessionId);
  await pages.helper.close();
  await pages.fixture.command('hold');
  try {
    await pages.fixture.command('append_burst');
    await expect.poll(async () => (await pages.manager.evaluate(() => window.notalone.replies.getState())).messageNotice.changed).toBe(true);
    // 覆盖原150ms通知合并窗口，验证关闭后也没有隐藏的自动模型任务。
    await pages.manager.waitForTimeout(400);
    const observed = await pages.fixture.command('observations');
    expect(observed.model_entered).toBe(false);
    expect(observed.payloads).toHaveLength(1);
    expect(await saved(pages, first.sessionId)).toEqual(before);
    const helper = await reopen(pages.manager);
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
    const state = await helper.evaluate(() => window.notalone.replies.getState());
    expect(state.savedSession?.sessionId).toBe(first.sessionId);
    expect(state.savedSession?.currentInputVersionId).toBe(first.inputVersion);
    expect(state.savedSession?.turns).toHaveLength(1);
    expect(state.exploration.result).toBeNull();
    await expect(helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ })).toHaveValue('小窗关闭前的合成候选（说法1）。');
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  } finally { await pages.fixture.command('release'); }
}
async function candidateContinues(pages: EventPages, action: WorkspaceAction, departure: 'close' | 'switch') {
  await prepareWorkspaceTask(pages, action);
  const sessionId = (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
  const messages = ['方便时再告诉我就好。', '不急着安排其他事情。'];
  await pages.fixture.plan({ count: 1, message_groups: [messages] });
  await pages.fixture.command('hold_generation');
  try {
    await generateWorkspace(pages.helper, action);
    await expect.poll(async () => (await pages.fixture.command('observations')).generation_entered).toBe(true);
    const generating = await saved(pages, sessionId);
    expect((await pages.fixture.command('observations')).payloads).toEqual([]);
    let nextSessionId: string | null | undefined;
    if (departure === 'close') await pages.helper.close();
    else {
      await openAssistantHistory(pages.helper);
      const create = pages.helper.getByRole('button', { name: '新开助手会话', exact: true });
      await expect(create).toBeEnabled();
      await create.click();
      await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession?.sessionId).not.toBe(sessionId);
      await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
      nextSessionId = (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId;
      expect(typeof nextSessionId).toBe('string');
    }
    await pages.fixture.command('append_burst');
    await expect.poll(async () => (await pages.manager.evaluate(() => window.notalone.replies.getState())).messageNotice.changed).toBe(true);
    await pages.manager.waitForTimeout(400);
    expect((await saved(pages, sessionId)).current_input_version_id).toBe(generating.current_input_version_id);
    expect((await pages.fixture.command('observations')).payloads).toEqual([]);
    await pages.fixture.command('release');
    await expect.poll(async () => (await saved(pages, sessionId)).turns[0]?.state).toBe('completed');
    await pages.awaitPendingCommands();
    const original = await saved(pages, sessionId);
    expect(original.turns).toHaveLength(1);
    expect(original.turns[0].reply.candidates[0].messages.map((message: { text: string }) => message.text)).toEqual(messages);
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
    let helper: Page;
    if (departure === 'close') helper = await reopen(pages.manager);
    else {
      helper = pages.helper;
      const switched = await helper.evaluate(() => window.notalone.replies.getState());
      expect(switched.savedSession?.sessionId).toBe(nextSessionId);
      expect(switched.savedSession?.turns).toEqual([]);
      expect(switched.result).toBeNull();
      expect(switched.exploration.result).toBeNull();
      await openAssistantHistory(helper);
      await helper.getByRole('button', { name: '刷新会话列表', exact: true }).click();
      await openAssistantHistory(helper);
      await helper.getByRole('button', { name: `查看会话 ${sessionId}`, exact: true }).click();
      await expandSavedDiscussion(helper);
    }
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).savedSession?.turns[0]?.state).toBe('completed');
    const restored = await helper.evaluate(() => window.notalone.replies.getState());
    expect(restored.savedSession?.sessionId).toBe(sessionId);
    expect(restored.savedSession?.currentInputVersionId).toBe(original.current_input_version_id);
    expect(restored.options).toMatchObject({ inputKind: 'workspace', workspaceAction: action });
    await expect(helper.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(messages[0]);
    await expect(helper.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue(messages[1]);
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  } finally { await pages.fixture.command('release'); }
}
export async function replyStrategyLifecycle(browser: Browser, origin: string) {
  for (const action of ['express', 'suggest'] as const) {
    const name = `${action}关闭完成候选后通知不自动生成且重开可恢复`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, pages => noAutomaticAfterClose(pages, action));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
// 保留 runner 的历史 case 名；确认方向已移除，覆盖的是两种显式动作的在途归属。
export async function replyStrategyConfirmedLifecycle(browser: Browser, origin: string) {
  for (const departure of ['close', 'switch'] as const) for (const action of ['express', 'suggest'] as const) {
    const name = `${action}直接生成后${departure === 'close' ? '关闭小窗' : '切换会话'}仍唯一保存原消息组`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, pages => candidateContinues(pages, action, departure));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
