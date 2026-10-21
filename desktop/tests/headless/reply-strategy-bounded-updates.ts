import { openAssistantHistory } from '../assistant-history-actions';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { fillWorkspaceThought, generateWorkspace, setWorkspaceContext, workspaceInput } from '../workspace-actions';
import { withEventPages, type EventPages } from './message-events';

export type WorkspaceAction = 'express' | 'suggest';
export async function prepareWorkspaceTask(pages: EventPages, action: WorkspaceAction) {
  await pages.manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
  await confirmHelperContact(pages.helper, pages.fixture.data.contact_ids[0]);
  await fillWorkspaceThought(pages.helper, action === 'express' ? '只关心近期状态，不增加安排承诺。' : '');
  await expect(pages.helper.getByRole('status').filter({ hasText: '新消息提醒已连接' })).toBeVisible();
  await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession?.phase).toBe('ready');
}
export async function openWorkspaceTask(pages: EventPages, action: WorkspaceAction, prefix: string) {
  const basis = '先关心近况，给对方自由回应的空间。';
  await pages.fixture.plan({ count: 1, prefix, basis });
  await generateWorkspace(pages.helper, action);
  await expect(pages.helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ })).toHaveValue(`${prefix}（说法1）。`);
  await expect(pages.helper.getByRole('region', { name: '候选回复', exact: true }).getByText(basis, { exact: true })).toBeVisible();
  await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession?.turns.at(-1)?.state).toBe('completed');
  const state = await pages.helper.evaluate(() => window.notalone.replies.getState());
  expect(state.exploration.result).toBeNull();
  expect(state.options).toMatchObject({ inputKind: 'workspace', workspaceAction: action });
  return { sessionId: state.savedSession!.sessionId!, inputVersion: state.savedSession!.currentInputVersionId! };
}
async function reread(pages: EventPages, sessionId: string) {
  const saved = await pages.fixture.request(`/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}`);
  expect(saved.status).toBe(200);
  return saved.data;
}
async function burstWithoutGeneration(pages: EventPages, count: number) {
  await pages.fixture.command('append_burst');
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  // 真实 SSE 已投影后覆盖原150ms合并窗口，检查没有延迟发起的模型请求。
  await pages.helper.waitForTimeout(400);
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(count);
}
async function bounded(pages: EventPages, action: WorkspaceAction) {
  await prepareWorkspaceTask(pages, action);
  await burstWithoutGeneration(pages, 0);
  const first = await openWorkspaceTask(pages, action, '用户明确请求的候选');
  const before = await reread(pages, first.sessionId);
  const editor = pages.helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ });
  await editor.fill('正在编辑的合成候选，不要被新消息替换。');
  await pages.fixture.command('append_other_contact');
  await pages.fixture.command('append_other_owner');
  for (let index = 0; index < 4; index++) await burstWithoutGeneration(pages, 1);
  await expect(editor).toHaveValue('正在编辑的合成候选，不要被新消息替换。');
  const unchanged = await reread(pages, first.sessionId);
  expect(unchanged.current_input_version_id).toBe(before.current_input_version_id);
  expect(unchanged.turns).toEqual(before.turns);
  await openWorkspaceTask(pages, action, '再次明确请求的候选');
  const observations = await pages.fixture.command('observations');
  expect(observations.payloads).toHaveLength(2);
  const payload = JSON.stringify((observations.payloads as object[]).at(-1));
  expect(payload).toContain('甲的新合成消息');
  expect(payload).not.toContain('乙的新合成消息');
  expect(payload).not.toContain('另一用户的新合成消息');
}
async function messagesWhileGenerating(pages: EventPages, interrupted: boolean) {
  await prepareWorkspaceTask(pages, 'suggest');
  const sessionId = (await pages.helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
  await pages.fixture.plan({ count: 1, prefix: '首次明确请求的候选' });
  await pages.fixture.command('hold');
  try {
    await generateWorkspace(pages.helper, 'suggest');
    await expect.poll(async () => (await pages.fixture.command('observations')).model_entered).toBe(true);
    const before = await reread(pages, sessionId);
    if (interrupted) {
      await pages.fixture.command('disconnect_stream');
      await expect(pages.helper.getByRole('status').filter({ hasText: '消息提醒已中断' })).toBeVisible();
    }
    await pages.fixture.command('append_burst');
    if (interrupted) await pages.helper.getByRole('button', { name: '重连消息提醒', exact: true }).click();
    await expect(pages.helper.getByRole('status').filter({ hasText: '新消息提醒已连接' })).toBeVisible();
    await pages.helper.waitForTimeout(400);
    expect((await pages.fixture.command('observations')).payloads).toEqual([]);
    expect((await reread(pages, sessionId)).current_input_version_id).toBe(before.current_input_version_id);
    await pages.fixture.command('release');
    await expect(pages.helper.getByRole('textbox', { name: /^(候选1|说法1第1条)编辑文本$/ })).toHaveValue('首次明确请求的候选（说法1）。');
    await burstWithoutGeneration(pages, 1);
    const after = await reread(pages, sessionId);
    expect(after.current_input_version_id).toBe(before.current_input_version_id);
    expect(after.turns).toHaveLength(1);
  } finally { await pages.fixture.command('release'); }
}
async function unsubmittedInputs(pages: EventPages) {
  await prepareWorkspaceTask(pages, 'express');
  const first = await openWorkspaceTask(pages, 'express', '编辑输入前的候选');
  const before = await reread(pages, first.sessionId);
  const thought = '这段合成想法还没提交，我正在补充。';
  await fillWorkspaceThought(pages.helper, thought);
  await setWorkspaceContext(pages.helper, true);
  const context = pages.helper.getByRole('textbox', { name: '补充聊天上下文', exact: true });
  await context.fill('仅本次补充的合成聊天，不代表用户承诺。');
  await burstWithoutGeneration(pages, 1);
  await expect(workspaceInput(pages.helper)).toHaveValue(thought);
  await expect(context).toHaveValue('仅本次补充的合成聊天，不代表用户承诺。');
  expect((await reread(pages, first.sessionId)).current_input_version_id).toBe(before.current_input_version_id);
  expect(JSON.stringify((await pages.fixture.command('observations')).payloads)).not.toContain(thought);
}
async function failureNeedsExplicitRequest(pages: EventPages) {
  await prepareWorkspaceTask(pages, 'suggest');
  await pages.fixture.plan({ fault: 'failure' });
  await generateWorkspace(pages.helper, 'suggest');
  await expect.poll(async () => (await pages.helper.evaluate(() => window.notalone.replies.getState())).phase).toBe('failed');
  const count = ((await pages.fixture.command('observations')).payloads as unknown[]).length;
  expect(count).toBe(1);
  await burstWithoutGeneration(pages, count);
  await openWorkspaceTask(pages, 'suggest', '失败后用户明确请求的候选');
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(count + 1);
}
async function freshTaskAfterDeletion(pages: EventPages) {
  await prepareWorkspaceTask(pages, 'suggest');
  const old = await openWorkspaceTask(pages, 'suggest', '准备删除的合成候选');
  const oldScope = (await pages.helper.evaluate(() => window.notalone.replies.getState())).scopeRevision;
  const oldPath = `/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${old.sessionId}`;
  await openAssistantHistory(pages.helper);
  await pages.helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
  await pages.helper.getByRole('group', { name: '确认删除助手会话', exact: true })
    .getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
  expect((await pages.fixture.request(oldPath)).status).toBe(404);
  await burstWithoutGeneration(pages, 1);
  await fillWorkspaceThought(pages.helper, '删除旧讨论后想了解近况。');
  const fresh = await openWorkspaceTask(pages, 'suggest', '删除后用户明确请求的候选');
  expect(fresh.sessionId).not.toBe(old.sessionId);
  expect((await pages.helper.evaluate(() => window.notalone.replies.getState())).scopeRevision).toBe(oldScope);
  await burstWithoutGeneration(pages, 2);
  const saved = await reread(pages, fresh.sessionId);
  expect(saved.current_input_version_id).toBe(fresh.inputVersion);
  expect(saved.turns).toHaveLength(1);
  expect((await pages.fixture.request(oldPath)).status).toBe(404);
}
async function savedVersionStaysUnchanged(pages: EventPages) {
  await prepareWorkspaceTask(pages, 'express');
  const first = await openWorkspaceTask(pages, 'express', '保存编辑前的合成候选');
  const saved = await pages.helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    const identity = { contactId: state.contactId!, scopeRevision: state.scopeRevision,
      sessionId: state.savedSession!.sessionId!, candidateId: state.result!.candidates[0].original.candidateId };
    const read = await window.notalone.replies.readCandidateVersions(identity);
    const version = read.candidateVersions!.items.find(item => item.candidateId === identity.candidateId)!.history!.versions.at(-1)!;
    const updated = await window.notalone.replies.saveCandidateVersion({ ...identity, editKey: crypto.randomUUID(),
      parentVersionId: version.versionId, requirements: '本次只修改说法。',
      messages: version.messages.map(message => ({ ...message, text: '用户明确保存的合成版本编辑。' })) });
    return { identity, versions: updated.candidateVersions };
  });
  expect(saved.versions!.items.find(item => item.candidateId === saved.identity.candidateId)!.history!.versions.at(-1)!.text)
    .toBe('用户明确保存的合成版本编辑。');
  const before = await reread(pages, first.sessionId);
  await burstWithoutGeneration(pages, 1);
  const rereadVersions = await pages.helper.evaluate(identity => window.notalone.replies.readCandidateVersions(identity), saved.identity);
  expect(rereadVersions.candidateVersions).toEqual(saved.versions);
  const after = await reread(pages, first.sessionId);
  expect(after.current_input_version_id).toBe(before.current_input_version_id);
  expect(after.turns).toEqual(before.turns);
}
export async function replyStrategyBoundedUpdates(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: EventPages) => Promise<void>]> = [
    ...(['express', 'suggest'] as const).map((action): [string, (pages: EventPages) => Promise<void>] =>
      [`${action}仅明确操作调用模型且通知保持候选编辑与隔离`, pages => bounded(pages, action)]),
    ['首次候选在途收到消息不追加生成', pages => messagesWhileGenerating(pages, false)],
    ['首次候选在途断流重连不追加生成', pages => messagesWhileGenerating(pages, true)],
    ['未提交的想法与补充上下文不被通知修改或上传', unsubmittedInputs],
    ['失败后仅用户明确动作可以重新生成', failureNeedsExplicitRequest],
    ['删除旧讨论后明确请求建立新会话且不自动复活', freshTaskAfterDeletion],
    ['公开入口保存候选版本后通知不修改版本或讨论', savedVersionStaysUnchanged],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
