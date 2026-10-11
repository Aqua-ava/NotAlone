import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withEventPages, type EventPages } from './message-events';

const manualNotice = '本次自动更新已暂停，请点“更新理解”继续。';
async function current(pages: EventPages) {
  return pages.helper.evaluate(async () => (await window.notalone.replies.getState()).exploration.result);
}
async function prepare(pages: EventPages, scene: '回应消息' | '主动聊聊') {
  const { manager, helper, fixture } = pages;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, fixture.data.contact_ids[0]);
  await helper.getByRole('button', { name: scene, exact: true }).click();
  if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的原始合成消息/ }).click();
  else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想了解近况，还未决定本次意愿。');
  await helper.getByRole('combobox', { name: '策略选择', exact: true }).selectOption('disabled');
  await expect(helper.getByRole('status').filter({ hasText: '新消息提醒已连接' })).toBeVisible();
}
async function open(pages: EventPages, understanding: string) {
  await pages.fixture.plan({ explore: { understanding } });
  await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText(understanding);
  const result = await current(pages);
  expect(result?.confirmedIntent).toBeNull();
  return result!;
}
async function reread(pages: EventPages, sessionId: string) {
  const saved = await pages.fixture.request(`/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${sessionId}`);
  expect(saved.status).toBe(200);
  return saved.data;
}
async function bounded(pages: EventPages, scene: '回应消息' | '主动聊聊') {
  await prepare(pages, scene);
  // 打开场景尚不是开启任务，经过真实消息投影的通知也不能自主调用模型。
  await pages.fixture.command('append_message');
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  expect((await pages.fixture.command('observations')).payloads).toEqual([]);
  let result = await open(pages, '用户明确开启的合成方向任务。');
  const root = result;
  for (let index = 0; index < 3; index++) {
    const understanding = `第${index + 1}次有界合成更新，意愿仍未确认。`;
    await pages.fixture.plan({ explore: { understanding } });
    await pages.fixture.command('append_burst');
    await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText(understanding);
    const next = (await current(pages))!;
    expect(next.taskId).not.toBe(result.taskId);
    expect(next.inputVersion).not.toBe(result.inputVersion);
    expect(next.sessionId).toBe(root.sessionId);
    expect(next.confirmedIntent).toBeNull();
    expect(next.usedSkill).toBeNull();
    const saved = await reread(pages, root.sessionId);
    expect(saved.current_input_version_id).toBe(next.inputVersion);
    expect(saved.turns).toEqual([]);
    const observations = await pages.fixture.command('observations');
    expect(observations.payloads).toHaveLength(index + 2);
    expect(JSON.stringify(observations.payloads)).not.toContain('乙的新合成消息');
    expect(JSON.stringify(observations.payloads)).not.toContain('另一用户的新合成消息');
    result = next;
  }
  await pages.fixture.command('append_burst');
  await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(4);
  expect((await current(pages))?.taskId).toBe(result.taskId);
  await pages.fixture.plan({ explore: { understanding: '用户手动更新后的合成理解。' } });
  await pages.helper.getByRole('button', { name: '更新理解', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText('用户手动更新后的合成理解。');
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(5);
  await expect(pages.helper.getByRole('region', { name: '候选回复', exact: true }).getByRole('textbox', { name: /候选.*编辑文本/ })).toHaveCount(0);
  const saved = await reread(pages, root.sessionId);
  expect(saved.turns).toEqual([]);
}
async function stopsAfterFailure(pages: EventPages, expired: boolean) {
  await prepare(pages, '主动聊聊');
  const first = await open(pages, '等待新消息的合成任务。');
  if (expired) await pages.fixture.command('age_exploration');
  else await pages.fixture.plan({ fault: 'failure' });
  await pages.fixture.command('append_message');
  await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
  const count = expired ? 1 : 2;
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(count);
  await pages.fixture.command('append_message');
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(count);
  await pages.fixture.plan({ explore: { understanding: '用户再次手动开启的合成探索。' } });
  await pages.helper.getByRole('button', { name: '更新理解', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText('用户再次手动开启的合成探索。');
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(count + 1);
  expect((await reread(pages, first.sessionId)).turns).toEqual([]);
}
async function leavingScene(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  const first = await open(pages, '离开场景前的合成任务。');
  await pages.helper.getByRole('button', { name: '改写', exact: true }).click();
  await pages.fixture.command('append_burst');
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  expect((await reread(pages, first.sessionId)).current_input_version_id).toBe(first.inputVersion);
  expect(await current(pages)).toBeNull();
}

async function messagesWhileOpening(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  await pages.fixture.plan({ explore: { understanding: '初始快照仍在模型处理。' } });
  await pages.fixture.command('hold');
  try {
    await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect.poll(async () => (await pages.fixture.command('observations')).model_entered).toBe(true);
    await pages.fixture.plan({ explore: { understanding: '明确任务首次等待期间的消息已合并更新。' } });
    await pages.fixture.command('append_burst');
    await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
    expect((await pages.fixture.command('observations')).payloads).toEqual([]);
    await pages.fixture.command('release');
    await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true }))
      .toContainText('明确任务首次等待期间的消息已合并更新。');
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(2);
    const result = (await current(pages))!;
    expect(result.confirmedIntent).toBeNull();
    const saved = await reread(pages, result.sessionId);
    expect(saved.current_input_version_id).toBe(result.inputVersion);
    expect(saved.turns).toEqual([]);
  } finally { await pages.fixture.command('release'); }
}

async function interruptedAutomaticRequest(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  await open(pages, '中断前的合成理解。');
  await pages.fixture.plan({ explore: { understanding: '中断后不能迟到发布的理解。' } });
  await pages.fixture.command('hold');
  try {
    await pages.fixture.command('append_message');
    await expect.poll(async () => (await pages.fixture.command('observations')).model_entered).toBe(true);
    await pages.fixture.command('disconnect_stream');
    await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
    await expect(pages.helper.getByRole('button', { name: '更新理解', exact: true })).toBeEnabled();
    await pages.fixture.command('release');
    await expect.poll(async () => (await pages.fixture.command('observations')).payloads).toHaveLength(2);
    await pages.fixture.plan({ explore: { understanding: '中断后用户明确手动更新。' } });
    await pages.helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true }))
      .toContainText('中断后用户明确手动更新。');
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(3);
    const result = (await current(pages))!;
    expect(result.confirmedIntent).toBeNull();
    expect((await reread(pages, result.sessionId)).turns).toEqual([]);
  } finally { await pages.fixture.command('release'); }
}
async function unsubmittedAnswer(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  await pages.fixture.plan({ explore: { understanding: '尚需用户说明时间范围。',
    question: { text: '本次是关心今天，还是询问近期？', impact: 'ambiguity' } } });
  await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
  const answer = pages.helper.getByRole('textbox', { name: '关键问题回答', exact: true });
  await expect(answer).toBeVisible();
  const first = (await current(pages))!;
  await answer.fill('这段合成回答还没提交，我正在补充。');
  await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
  await pages.fixture.command('append_burst');
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  await expect(answer).toHaveValue('这段合成回答还没提交，我正在补充。');
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
  expect((await current(pages))?.taskId).toBe(first.taskId);
  const saved = await reread(pages, first.sessionId);
  expect(saved.current_input_version_id).toBe(first.inputVersion);
  expect(saved.turns).toEqual([]);
}

async function interruptedFirstRequest(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  await pages.fixture.plan({ explore: { understanding: '首次明确请求完成，但自动任务已暂停。' } });
  await pages.fixture.command('hold');
  try {
    await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect.poll(async () => (await pages.fixture.command('observations')).model_entered).toBe(true);
    await pages.fixture.command('disconnect_stream');
    await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
    await pages.fixture.command('release');
    await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true }))
      .toContainText('首次明确请求完成，但自动任务已暂停。');
    await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
    await pages.fixture.command('append_burst');
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(1);
    await pages.fixture.plan({ explore: { understanding: '首次断流后用户重新手动开启。' } });
    await pages.helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true }))
      .toContainText('首次断流后用户重新手动开启。');
    expect((await pages.fixture.command('observations')).payloads).toHaveLength(2);
    expect((await reread(pages, (await current(pages))!.sessionId)).turns).toEqual([]);
  } finally { await pages.fixture.command('release'); }
}
async function answerCannotMoveToNewQuestion(pages: EventPages, changePurpose: boolean) {
  await prepare(pages, '主动聊聊');
  await pages.fixture.plan({ explore: { question: { text: '原问题：是否询问今天？', impact: 'ambiguity' } } });
  await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
  const answer = pages.helper.getByRole('textbox', { name: '关键问题回答', exact: true });
  await expect(answer).toBeVisible();
  const first = (await current(pages))!;
  const draft = '只回答原问题的合成未提交文字。';
  await answer.fill(draft);
  await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toBeVisible();
  if (changePurpose) await pages.helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('改为只了解合成近期状态。');
  await pages.fixture.plan({ explore: { understanding: '新输入有一个独立问题。',
    question: { text: '新问题：是否只询问近期？', impact: 'ambiguity' } } });
  await pages.helper.getByRole('button', { name: '更新理解', exact: true }).click();
  await expect(pages.helper.getByRole('group', { name: '关键澄清', exact: true })).toContainText('新问题：是否只询问近期？');
  await expect(answer).toHaveValue('');
  await expect(pages.helper.getByRole('button', { name: '提交回答', exact: true })).toBeDisabled();
  const next = (await current(pages))!;
  expect(next.inputVersion).not.toBe(first.inputVersion);
  expect(next.question?.questionId).not.toBe(first.question?.questionId);
  const observations = await pages.fixture.command('observations');
  expect(observations.payloads).toHaveLength(2);
  expect(JSON.stringify(observations.payloads)).not.toContain(draft);
  expect((await reread(pages, next.sessionId)).turns).toEqual([]);
}
async function confirmedQuestionKeepsIntent(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  await pages.fixture.plan({ explore: { question: { text: '这次是否不增加承诺？', impact: 'commitment' } } });
  await pages.helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
  await expect(pages.helper.getByRole('group', { name: '关键澄清', exact: true })).toBeVisible();
  await pages.helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText('已确认本次意愿');
  const selected = (await current(pages))!;
  expect(selected.confirmedIntent).toBe('表示愿意等待，但不增加承诺。');
  await pages.helper.getByRole('textbox', { name: '关键问题回答', exact: true }).fill('原问题的未提交合成回答。');
  await expect(pages.helper.getByRole('status').filter({ hasText: manualNotice })).toHaveCount(0);
  await pages.fixture.plan({ explore: { understanding: '手动刷新仍保留用户已确认的意愿。',
    question: { text: '继续澄清承诺边界。', impact: 'commitment' } } });
  await pages.helper.getByRole('button', { name: '更新理解', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true }))
    .toContainText('手动刷新仍保留用户已确认的意愿。');
  const next = (await current(pages))!;
  expect(next.confirmedIntent).toBe(selected.confirmedIntent);
  expect(next.sessionId).toBe(selected.sessionId);
  expect(next.inputVersion).not.toBe(selected.inputVersion);
  await expect(pages.helper.getByRole('textbox', { name: '关键问题回答', exact: true })).toHaveValue('');
  await pages.fixture.command('append_burst');
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(2);
  expect((await current(pages))?.confirmedIntent).toBe(selected.confirmedIntent);
  expect((await reread(pages, next.sessionId)).turns).toEqual([]);
}

async function freshTaskAfterDeletion(pages: EventPages) {
  await prepare(pages, '主动聊聊');
  const old = await open(pages, '准备删除的合成方向讨论。');
  const oldScope = await pages.helper.evaluate(async () => (await window.notalone.replies.getState()).scopeRevision);
  const oldPath = `/api/contacts/${pages.fixture.data.contact_ids[0]}/assistant-sessions/${old.sessionId}`;
  await pages.helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
  await pages.helper.getByRole('group', { name: '确认删除助手会话', exact: true })
    .getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect(pages.helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
  expect((await pages.fixture.request(oldPath)).status).toBe(404);
  // 同一联系人／scope直接明确探索，不点击恢复、新开会话或重新选择联系人。
  await pages.helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
  await pages.helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('删除旧讨论后，想了解近况，还没确认意愿。');
  await pages.helper.getByRole('combobox', { name: '策略选择', exact: true }).selectOption('disabled');
  const fresh = await open(pages, '用户明确开启的新合成任务。');
  expect(fresh.sessionId).not.toBe(old.sessionId);
  expect(await pages.helper.evaluate(async () => window.notalone.replies.getState())).toMatchObject({
    scopeRevision: oldScope, confirmedSessionDeletion: { sessionId: old.sessionId },
  });
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(2);
  await pages.fixture.plan({ explore: { understanding: '已删除旧会话后的新任务收到真实通知。' } });
  await pages.fixture.command('append_burst');
  await expect(pages.helper.getByRole('region', { name: '理解与方向', exact: true }))
    .toContainText('已删除旧会话后的新任务收到真实通知。');
  const next = (await current(pages))!;
  expect(next.sessionId).toBe(fresh.sessionId);
  expect(next.taskId).not.toBe(fresh.taskId);
  expect(next.inputVersion).not.toBe(fresh.inputVersion);
  expect(next.confirmedIntent).toBeNull();
  expect((await pages.fixture.command('observations')).payloads).toHaveLength(3);
  const saved = await reread(pages, next.sessionId);
  expect(saved.current_input_version_id).toBe(next.inputVersion);
  expect(saved.turns).toEqual([]);
  expect((await pages.fixture.request(oldPath)).status).toBe(404);
}

export async function replyStrategyBoundedUpdates(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: EventPages) => Promise<void>]> = [
    ...(['回应消息', '主动聊聊'] as const).map((scene): [string, (pages: EventPages) => Promise<void>] =>
      [`${scene}显式任务内合并真实通知与三次预算`, (pages) => bounded(pages, scene)]),
    ['自动探索失败后停止重试并等待手动更新', (pages) => stopsAfterFailure(pages, false)],
    ['真实根任务过期后模型前拒绝并等待手动更新', (pages) => stopsAfterFailure(pages, true)],
    ['切回草稿停止探索更新且不改原讨论输入', leavingScene],
    ['首次明确探索等待期间的通知合并为一次后续更新', messagesWhileOpening],
    ['自动请求在途遇到消息流中断后可手动刷新', interruptedAutomaticRequest],
    ['编辑尚未提交的关键回答后仅提醒且保留文字', unsubmittedAnswer],
    ['首次手动请求中断后完成回执不重启自动任务', interruptedFirstRequest],
    ['手动刷新后的新问题不继承旧问题回答草稿', (pages) => answerCannotMoveToNewQuestion(pages, false)],
    ['改变目的后的新问题不继承旧输入回答草稿', (pages) => answerCannotMoveToNewQuestion(pages, true)],
    ['编辑已确认任务的回答后手动刷新保留意愿接续', confirmedQuestionKeepsIntent],
    ['旧会话确认删除后直接明确的新任务继续有界更新', freshTaskAfterDeletion],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, async (pages) => {
      try { await scenario(pages); }
      catch (error) {
        const [readState, readObservations] = await Promise.allSettled([
          pages.helper.evaluate(async () => window.notalone.replies.getState()),
          pages.fixture.command('observations'),
        ]);
        // 仅留本轮合成任务的阶段和计数，不记录正文、身份或握手。
        if (readState.status === 'fulfilled' && readObservations.status === 'fulfilled') {
          const state = readState.value, observations = readObservations.value;
          process.stdout.write(`page_test_strategy_observation: ${JSON.stringify({
            phase: state.exploration.phase, paused: Boolean(state.exploration.automaticUpdatesPaused),
            mode: state.mode, savedPhase: state.savedSession?.phase, generationBlock: state.generationBlock,
            modelEntered: observations.model_entered, payloadCount: (observations.payloads as unknown[]).length,
          })}\n`);
        } else process.stdout.write('page_test_strategy_observation: 本轮阶段证据未读取成功，保留原断言失败。\n');
        throw error;
      }
    });
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
