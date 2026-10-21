import { selectContact } from '../contact-picker-actions.mjs';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { openCandidateMoreActions, fillWorkspaceThought, fillWorkspaceInstruction, generateWorkspace, setWorkspaceContext } from '../workspace-actions';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withEventPages, type EventPages } from './message-events';

async function chooseContact(pages: EventPages, helper: Page, index: 0 | 1) {
  await selectContact(pages.manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: `合成联系人${index ? '乙' : '甲'}` });
  await confirmHelperContact(helper, pages.fixture.data.contact_ids[index]);
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase))
    .toBe('ready');
}

async function selectSession(helper: Page, sessionId: string) {
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '刷新会话列表', exact: true }).click();
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: `查看会话 ${sessionId}`, exact: true }).click();
  await expect.poll(() => helper.evaluate(async () => { const state = await window.notalone.replies.getState();
    return { sessionId: state.savedSession?.sessionId, phase: state.savedSession?.phase,
      catalog: state.sessionCatalog?.phase, pending: state.sessionCatalog?.selectionPending }; }))
    .toEqual({ sessionId, phase: 'ready', catalog: 'ready', pending: false });
  const saved = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!;
  await expect(helper.locator('.session-history .session-entry-details')).toHaveCount(saved.inputs.length);
  await expandSavedDiscussion(helper);
}

// 只增加跨票交叉场景；真实App停止／重开在独立有限窗口验收。
export async function assistantSessionCombination(browser: Browser, origin: string) {
  const name = '双联系人多会话：版本续改、新消息采用、恢复、预算与携入删除互不串扰';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withEventPages(browser, origin, async (pages) => {
    const { fixture } = pages;
    let helper = pages.helper;
    const contactA = fixture.data.contact_ids[0], contactB = fixture.data.contact_ids[1];
    await chooseContact(pages, helper, 0);
    await fillWorkspaceThought(helper, '感谢邀请，本次不参加。');
    await fillWorkspaceInstruction(helper, '自然一点；简短一点');
    await setWorkspaceContext(helper, true);
    await fixture.plan({ count: 1, message_groups: [['甲的合成感谢。', '甲本次不参加。']] });
    await generateWorkspace(helper);
    const group = helper.getByRole('group', { name: '说法1消息组', exact: true });
    await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('甲本次不参加。');
    const sessionA = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
    const pathA = `/api/contacts/${contactA}/assistant-sessions/${sessionA}`;
    await group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true }).fill('甲明确保存的拒绝。');
    await group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true }).blur();
    await expect(group.getByText('修改版本 1', { exact: true })).toBeVisible();
    await fixture.plan({ count: 1, message_groups: [['甲简短感谢。', '甲明确不参加。']] });
    await helper.getByRole('textbox', { name: '继续修改要求', exact: true }).fill('第一条简短一点');
    await helper.getByRole('button', { name: '继续修改', exact: true }).click();
    try {
      await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).continuation?.phase),
        { message: '已保存版本的本次继续修改应完成' }).toBe('completed');
    } catch (error) {
      const diagnostics = await Promise.allSettled([
        helper.evaluate(async () => {
          const state = await window.notalone.replies.getState();
          return { phase: state.phase, errorCode: state.errorCode ?? null,
            continuationPhase: state.continuation?.phase ?? null,
            generationBlock: state.generationBlock, sourceAvailability: state.sourceAvailability ?? null,
            savedPhase: state.savedSession?.phase, savedTurns: state.savedSession?.turns.map(turn => turn.state),
            versionPhase: state.candidateVersions?.phase, dirtyDraftCount: state.candidateDrafts?.length ?? 0,
            generationJobs: state.generationJobs?.map(job => job.phase) };
        }),
        fixture.command('model_status'),
        fixture.request(pathA).then(response => ({ status: response.status,
          turns: Array.isArray(response.data.turns) ? response.data.turns.map(turn => ({ state: turn.state,
            hasReply: Boolean(turn.reply), requiresReprepare: turn.requires_reprepare ?? false })) : null })),
      ]);
      // 只记录阶段和计数，不回显正文、握手或环境配置；原超时和业务断言保持不变。
      process.stderr.write(`page_test_combination_continuation: ${JSON.stringify(diagnostics.map((item, index) =>
        item.status === 'fulfilled' ? { source: ['ui', 'model', 'saved'][index], value: item.value }
          : { source: ['ui', 'model', 'saved'][index], unavailable: true }))}\n`);
      throw error;
    }
    const beforeMessage = (await fixture.request(pathA)).data;
    expect(beforeMessage.turns).toHaveLength(2);
    const priorReply = (await helper.evaluate(() => window.notalone.replies.getState())).result!.replyRequestId;
    const priorEvidencePath = `/api/contacts/${contactA}/replies/${priorReply}/evidence`;
    const priorEvidence = await fixture.request(priorEvidencePath);
    expect(priorEvidence.status).toBe(200);
    await fixture.command('append_other_contact');
    await pages.awaitPendingCommands();
    expect((await helper.evaluate(() => window.notalone.replies.getState())).messageNotice.changed).toBe(false);
    const arrived = await fixture.command('append_message');
    await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
    expect((await fixture.command('observations')).model_calls).toBe(2);
    await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('甲明确不参加。');
    expect(await fixture.request(priorEvidencePath)).toEqual(priorEvidence);
    // 工作区不再选择一条新消息；显式刷新背景后，由同一动作重新生成。
    await helper.getByRole('button', { name: '刷新最近聊天', exact: true }).click();
    await expect(helper.getByRole('checkbox', { name: /使用消息：甲的新合成消息/ })).toBeChecked();
    expect((await fixture.command('observations')).model_calls).toBe(2);
    await fixture.plan({ count: 1, message_groups: [['甲新消息后的感谢。', '甲仍不参加。']] });
    await generateWorkspace(helper);
    await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('甲仍不参加。');
    const adopted = (await fixture.request(pathA)).data;
    const turns = adopted.turns as Array<{ input: { content: Record<string, unknown> } }>;
    expect(turns).toHaveLength(3);
    expect(turns[2].input.content).toMatchObject({ input_kind: 'workspace', workspace_action: 'express',
      draft_text: '感谢邀请，本次不参加。', user_instruction: '自然一点；简短一点' });
    expect(turns[2].input.content).not.toHaveProperty('target_message_id');
    const adoptedReply = (await helper.evaluate(() => window.notalone.replies.getState())).result!.replyRequestId;
    const adoptedEvidence = await fixture.request(`/api/contacts/${contactA}/replies/${adoptedReply}/evidence`);
    expect(adoptedEvidence.status).toBe(200);
    expect(adoptedEvidence.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ evidence_id: arrived.message_id, kind: 'message' })]));
    await openAssistantHistory(helper);
    await openCandidateMoreActions(group);
    await expect(group.getByRole('button', { name: '用这组回复新开会话', exact: true })).toBeEnabled();
    await expect(group.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();

    await chooseContact(pages, helper, 1);
    await fillWorkspaceThought(helper, '乙的独立合成草稿。');
    await fixture.plan({ count: 1, prefix: '乙的独立合成候选' });
    await generateWorkspace(helper);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('乙的独立合成候选（说法1）。');
    const sessionB = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
    const pathB = `/api/contacts/${contactB}/assistant-sessions/${sessionB}`;
    const keptB = (await fixture.request(pathB)).data;
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
    // 点击只启动异步切换；先等权威新会话及目录恢复完成，再核验完整空状态。
    await expect.poll(() => helper.evaluate(async oldId => {
      const state = await window.notalone.replies.getState();
      return { changed: Boolean(state.savedSession?.sessionId && state.savedSession.sessionId !== oldId),
        phase: state.savedSession?.phase, catalog: state.sessionCatalog?.phase,
        pending: state.sessionCatalog?.selectionPending };
    }, sessionB)).toEqual({ changed: true, phase: 'ready', catalog: 'ready', pending: false });
    const openedB = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!;
    expect(openedB).toMatchObject({ phase: 'ready', inputs: [], turns: [], currentInputVersionId: null });
    expect((await fixture.request(`/api/contacts/${contactB}/assistant-sessions/${openedB.sessionId}`)).data)
      .toMatchObject({ inputs: [], turns: [], current_input_version_id: null });
    expect((await fixture.request(pathB)).data).toEqual(keptB);
    await selectSession(helper, sessionB);
    expect((await fixture.command('observations')).model_calls).toBe(4);
    expect((await fixture.request(`/api/contacts/${contactB}/assistant-sessions/${sessionA}`)).status).toBe(404);
    expect((await fixture.request(`/api/contacts/${fixture.data.other_contact_id}/assistant-sessions/${sessionA}`)).status).toBe(404);

    // 重建公开页面后只从权威存储恢复，未保存的草稿不参与恢复。
    await fillWorkspaceThought(helper, '未提交且不应恢复的乙草稿。');
    await helper.close();
    const opened = pages.manager.context().waitForEvent('page');
    await pages.manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
    helper = await opened;
    await chooseContact(pages, helper, 0);
    await selectSession(helper, sessionA);
    await expect(helper.getByRole('group', { name: '说法1消息组', exact: true })
      .getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue('甲仍不参加。');
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    expect((await fixture.command('observations')).model_calls).toBe(4);

    // 合法完整历史经公开HTTP保存，真实预算守卫必须拒绝而非截断。
    const large = '甲'.repeat(100000);
    const input = await fixture.request(`${pathA}/inputs`, { content: {
      type: 'purpose_exploration', purpose_hint: large }, expected_input_version_id: adopted.current_input_version_id });
    expect(input.status).toBe(200);
    await selectSession(helper, sessionA);
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
    await expandSavedDiscussion(helper);
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.currentInputVersionId))
      .toBe(input.data.input_version_id);
    await fillWorkspaceThought(helper, '甲超限后保留的合成草稿。');
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).draft))
      .toBe('甲超限后保留的合成草稿。');
    const beforeBudget = await helper.evaluate(() => window.notalone.replies.getState());
    expect(['idle', 'ready']).toContain(beforeBudget.phase);
    expect(beforeBudget.errorCode).toBeUndefined();
    const budgetScope = { contactId: contactA, scopeRevision: beforeBudget.scopeRevision, sessionId: sessionA };
    await generateWorkspace(helper);
    // 工作区先保存选项，再启动生成；先确认生成已进入公开状态，不能只等到前一个命令。
    await expect.poll(() => helper.evaluate(async captured => {
      const state = await window.notalone.replies.getState();
      return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
        && state.savedSession?.sessionId === captured.sessionId
        && (state.phase === 'waiting' || state.phase === 'failed');
    }, budgetScope)).toBe(true);
    await pages.awaitPendingCommands();
    const budgetState = await helper.evaluate(() => window.notalone.replies.getState());
    expect({ contactId: budgetState.contactId, scopeRevision: budgetState.scopeRevision,
      sessionId: budgetState.savedSession?.sessionId }).toEqual(budgetScope);
    expect(budgetState.phase).toBe('failed');
    expect(budgetState.errorCode).toBe('input_budget_exceeded');
    process.stdout.write(`page_test_combination_budget: phase=${budgetState.phase} code=${budgetState.errorCode} calls=4\n`);
    await expect(helper.getByRole('alert', { name: '模型输入预算', exact: true })).toBeVisible();
    expect((await fixture.command('observations')).model_calls).toBe(4);
    expect(((await fixture.request(pathA)).data.inputs as Array<{ content: { purpose_hint?: string } }>)
      .some((item) => item.content?.purpose_hint === large)).toBe(true);
    await openAssistantHistory(helper);
    await openCandidateMoreActions(helper.getByRole('group', { name: '说法1消息组', exact: true }));
    await helper.getByRole('group', { name: '说法1消息组', exact: true })
      .getByRole('button', { name: '用这组回复新开会话', exact: true }).click();
    await expandSavedDiscussion(helper);
    await expect(helper.getByRole('article', { name: '携入的已选版本', exact: true })).toBeVisible();
    const childA = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
    expect(childA).not.toBe(sessionA);
    const childPath = `/api/contacts/${contactA}/assistant-sessions/${childA}`;
    const carry = (await fixture.request(childPath)).data;
    expect(carry.turns).toEqual([]);
    expect((carry.inputs as Array<{ content: { messages: Array<{ text: string }> } }>)[0].content.messages.map((m) => m.text))
      .toEqual(['甲新消息后的感谢。', '甲仍不参加。']);
    await selectSession(helper, sessionA);
    await openAssistantHistory(helper);
    await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
    await helper.getByRole('group', { name: '确认删除助手会话', exact: true })
      .getByRole('button', { name: '确认删除会话', exact: true }).click();
    await expect.poll(async () => (await fixture.request(pathA)).status).toBe(404);
    await selectSession(helper, childA);
    const redacted = (await fixture.request(childPath)).data;
    expect(redacted.current_input_version_id).toBeNull();
    expect((redacted.inputs as Array<{ state: string; content: unknown }>)[0]).toMatchObject({ state: 'redacted', content: null });
    expect(JSON.stringify(await helper.evaluate(() => window.notalone.replies.getState()))).not.toContain('甲仍不参加。');
    expect((await fixture.request(pathB)).data).toEqual(keptB);
    expect((await fixture.command('observations')).model_calls).toBe(4);
    process.stdout.write('page_test_combination: contacts=2 models=4 recovery_delta=0 budget_delta=0 carry_delta=0 cross_scope=404 parent_deleted=true carry_redacted=true other_contact_unchanged=true\n');
  });
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
