import { expect, type Browser, type Page } from '@playwright/test';
import { withEventPages, type EventPages } from './message-events';
import { prepareDirectionTask, openDirectionTask } from './reply-strategy-bounded-updates';

async function reopen(manager: Page): Promise<Page> {
  const opened = manager.context().waitForEvent('page');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await expect(helper.getByRole('button', { name: '回应消息', exact: true })).toBeVisible();
  return helper;
}
async function saved(pages: EventPages, sessionId: string) {
  const response = await pages.fixture.request(`/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}`);
  expect(response.status).toBe(200);
  if (!Array.isArray(response.data.turns)) throw new Error('本轮真实会话快照格式无效。');
  return { turns: response.data.turns, current_input_version_id: response.data.current_input_version_id };
}
async function noAutomaticAfterClose(pages: EventPages, scene: '回应消息' | '主动聊聊') {
  await prepareDirectionTask(pages, scene);
  const first = await openDirectionTask(pages, '小窗关闭前的未确认合成理解。');
  await pages.helper.close();
  await pages.fixture.plan({ explore: { understanding: '关闭后未经用户开启的理解不得执行。' } });
  await pages.fixture.command('hold');
  try {
    await pages.fixture.command('append_burst');
    await expect.poll(async () => (await pages.manager.evaluate(() => window.notalone.replies.getState())).messageNotice.changed).toBe(true);
    // 覆盖原150ms通知合并窗口；固定等待只观察有限触发结果，不延长生产预算。
    await pages.manager.waitForTimeout(400);
    const observed = await pages.fixture.command('observations');
    expect(observed.model_entered).toBe(false);
    expect(observed.payloads).toHaveLength(1);
    expect((await saved(pages, first.sessionId)).current_input_version_id).toBe(first.inputVersion);
    const helper = await reopen(pages.manager);
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
    const state = await helper.evaluate(() => window.notalone.replies.getState());
    expect(state.exploration.result).toBeNull();
    expect(state.exploration.phase).not.toBe('waiting');
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  } finally { await pages.fixture.command('release'); }
}
async function lateExplorationAfterClose(pages: EventPages) {
  await prepareDirectionTask(pages, '主动聊聊');
  await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
  const sessionId = (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
  await pages.fixture.plan({ explore: { understanding: '已经关闭的任务不得显示这条理解。' } });
  await pages.fixture.command('hold');
  try {
    await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect.poll(async () => (await pages.fixture.command('observations')).model_entered).toBe(true);
    const identities = await pages.fixture.command('exploration_identities');
    if (!Array.isArray(identities.items)) throw new Error('本轮实际探索身份格式无效。');
    expect(identities.items).toHaveLength(1);
    const identity = identities.items[0];
    expect(identity.session_id).toBe(sessionId);
    expect(typeof identity.exploration_id).toBe('string');
    await pages.helper.close();
    await pages.fixture.command('release');
    await expect.poll(async () => (await pages.fixture.request(`/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}/explorations/${identity.exploration_id}`)).status).toBe(200);
    await pages.awaitPendingCommands();
    expect((await saved(pages, sessionId)).turns).toEqual([]);
    const helper = await reopen(pages.manager);
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
    const state = await helper.evaluate(() => window.notalone.replies.getState());
    expect(state.exploration.result).toBeNull();
    expect(state.exploration.phase).not.toBe('waiting');
    expect(state.savedSession?.turns).toEqual([]);
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  } finally { await pages.fixture.command('release'); }
}
async function candidateContinuesAfterClose(pages: EventPages, scene: '回应消息' | '主动聊聊') {
  await prepareDirectionTask(pages, scene);
  await pages.helper.getByRole('textbox', { name: scene === '回应消息' ? '表达方向' : '主动目的', exact: true })
    .fill('只关心近况，不增加安排承诺。');
  await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
  const before = await pages.helper.evaluate(() => window.notalone.replies.getState());
  const sessionId = before.savedSession!.sessionId!;
  await pages.fixture.plan({ count: 1, message_groups: [['最近过得怎么样？', '方便时说就好，不急着安排。']] });
  await pages.fixture.command('hold');
  try {
    await pages.helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect.poll(async () => (await pages.fixture.command('observations')).model_entered).toBe(true);
    await pages.helper.close();
    await pages.fixture.command('append_burst');
    await pages.fixture.command('release');
    await expect.poll(async () => (await saved(pages, sessionId)).turns[0]?.state).toBe('completed');
    const original = await saved(pages, sessionId);
    expect(original.turns).toHaveLength(1);
    expect(original.turns[0].reply.candidates[0].messages.map((message: { text: string }) => message.text))
      .toEqual(['最近过得怎么样？', '方便时说就好，不急着安排。']);
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
    const helper = await reopen(pages.manager);
    await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getState())).savedSession?.turns[0]?.state).toBe('completed');
    const restored = await helper.evaluate(() => window.notalone.replies.getState());
    expect(restored.savedSession?.sessionId).toBe(sessionId);
    expect(restored.savedSession?.currentInputVersionId).toBe(original.current_input_version_id);
    expect(restored.exploration.result).toBeNull();
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  } finally { await pages.fixture.command('release'); }
}

export async function replyStrategyLifecycle(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊'] as const) {
    const name = `${scene}关闭探索后不因真实SSE复活`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, (pages) => noAutomaticAfterClose(pages, scene));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
  process.stdout.write('page_test_scenario: 关闭在途探索拒绝迟到建议\n');
  await withEventPages(browser, origin, lateExplorationAfterClose);
  process.stdout.write('page_test_scenario_passed: 关闭在途探索拒绝迟到建议\n');
  for (const scene of ['回应消息', '主动聊聊'] as const) {
    const name = `${scene}关闭小窗仍唯一保存原消息组`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, (pages) => candidateContinuesAfterClose(pages, scene));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
