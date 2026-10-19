import { fillWorkspaceInstruction, openWorkspaceSettings } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { RewriteHttpProxy } from '../rewrite-http-proxy';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

async function chooseContact(pages: RewritePages) {
  await pages.manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(pages.helper, pages.rewriteBackend.data.contact_ids[0]);
  await expect.poll(() => pages.helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase))
    .toBe('ready');
}

async function exerciseFork(pages: RewritePages, originalId: string, expectedTexts: string[]) {
  const { helper, rewriteBackend } = pages;
  const contactId = rewriteBackend.data.contact_ids[0];
  const path = `/api/contacts/${contactId}/assistant-sessions/${originalId}`;
  const original = (await rewriteBackend.request(path)).data;
  const before = await rewriteBackend.command('metrics');
  const group = helper.getByRole('group', { name: '说法2消息组', exact: true });
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
  await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
  const blank = (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!;
  expect(blank).toMatchObject({ phase: 'ready', inputs: [], turns: [], currentInputVersionId: null });
  expect(blank.sessionId).not.toBe(originalId);
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '刷新会话列表', exact: true }).click();
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: `查看会话 ${originalId}`, exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.sessionId))
    .toBe(originalId);
  await openAssistantHistory(helper);
  await expect(group.getByRole('button', { name: '用这组回复新开会话', exact: true })).toBeEnabled();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('未提交的旧会话合成草稿不得携入。');
  await fillWorkspaceInstruction(helper, '未提交的旧会话临时要求不得携入。');
  await openAssistantHistory(helper);
  const originalCandidate = await helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    const candidate = state.candidateVersions!.items.find(item => item.history!.candidateNumber === 2)!;
    return { candidateId: candidate.candidateId, versionId: candidate.displayVersionId };
  });
  await group.getByRole('button', { name: '用这组回复新开会话', exact: true }).click();
  await expandSavedDiscussion(helper);
  const carried = helper.getByRole('article', { name: '携入的已选版本', exact: true });
  await expect(carried).toBeVisible();
  for (const text of expectedTexts) await expect(carried.getByText(text, { exact: true })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
  await openWorkspaceSettings(helper);
  await expect(helper.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('');
  await expect(helper.getByRole('article', { name: '第1轮讨论', exact: true })).toHaveCount(0);
  const state = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(state.savedSession).toMatchObject({ phase: 'ready', turns: [] });
  expect(state.savedSession!.inputs).toHaveLength(1);
  expect(state.savedSession!.inputs[0]).toMatchObject({ type: 'candidate_carry', state: 'active',
    inputVersionId: state.savedSession!.currentInputVersionId,
    content: { type: 'candidate_carry', originSessionId: originalId } });
  expect(state.savedSession!.inputs[0].content!.type).toBe('candidate_carry');
  const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${state.savedSession!.sessionId}`);
  expect(saved.status).toBe(200);
  expect(saved.data.turns).toEqual([]);
  expect((saved.data.inputs as Array<{ content: { messages: Array<{ text: string }> } }>)[0].content.messages.map((m) => m.text))
    .toEqual(expectedTexts);
  const origin = state.savedSession!.inputs[0].content;
  if (origin?.type !== 'candidate_carry') throw new Error('本次携入的权威来历未恢复。');
  expect(origin.originCandidateId).toBe(originalCandidate.candidateId);
  expect(origin.originVersionId).toBe(originalCandidate.versionId);
  expect(origin.originSelectionId).toBeTruthy();
  expect((await rewriteBackend.request(path)).data).toEqual(original);
  expect(await rewriteBackend.command('metrics')).toEqual(before);
  process.stdout.write(`page_test_carry: blank_empty=true carry_messages=${expectedTexts.length} old_unchanged=true new_turns=0 automatic_model_delta=0 migrations=${before.migration_count} repeat=${before.migration_repeat}\n`);
}

async function saveGroupMessage(pages: RewritePages, messageNumber: 1 | 2, text: string, versionNumber: number) {
  const { helper, rewriteBackend } = pages;
  const group = helper.getByRole('group', { name: '说法2消息组', exact: true });
  const editor = group.getByRole('textbox', { name: `说法2第${messageNumber}条编辑文本`, exact: true });
  let stage = 'editing';
  try {
    await editor.fill(text);
    await expect(editor).toHaveValue(text);
    await expect(group.getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
    stage = 'saving';
    await editor.blur();
    await expect(group.getByText(`修改版本 ${versionNumber}`, { exact: true })).toBeVisible();
    await expect(group.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
  } catch (error) {
    const state = await helper.evaluate(() => window.notalone.replies.getState());
    const view = state.candidateVersions?.items.find(item => item.history?.candidateNumber === 2);
    const draft = state.candidateDrafts?.find(item => item.candidateId === view?.candidateId);
    const diagnostic: Record<string, unknown> = { stage, messageNumber, expectedVersion: versionNumber,
      phase: state.phase, savedPhase: state.savedSession?.phase, versionsPhase: state.candidateVersions?.phase,
      viewPhase: view?.phase, displayedVersionNumber: view?.history?.versions.find(item => item.versionId === view.displayVersionId)?.versionNumber,
      versionNumbers: view?.history?.versions.map(item => item.versionNumber),
      retainedEditMatches: draft?.messages[messageNumber - 1]?.text === text,
      renderedEditMatches: await editor.inputValue().then(value => value === text).catch(() => null) };
    if (view?.candidateId && state.savedSession?.sessionId) {
      const response = await rewriteBackend.request(`/api/contacts/${state.contactId}/assistant-sessions/${state.savedSession.sessionId}/candidates/${view.candidateId}/versions`);
      diagnostic.savedVersions = { status: response.status, versions: Array.isArray(response.data.versions)
        ? response.data.versions.map(version => ({ number: version.version_number,
          editedMessageMatches: version.messages?.[messageNumber - 1]?.text === text })) : null };
    }
    // 只记录保存阶段、版本序号和相等性，不回显合成正文或身份。
    process.stderr.write(`page_test_carry_edit: ${JSON.stringify(diagnostic)}\n`);
    throw error;
  }
}

async function selectedVersion(pages: RewritePages): Promise<string> {
  const { helper, rewriteBackend } = pages;
  await chooseContact(pages);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('合成原稿：谢谢邀请，这次不参与。');
  await fillWorkspaceInstruction(helper, '只属于旧讨论的合成要求。');
  await openAssistantHistory(helper);
  await expect(helper.getByRole('button', { name: '携已选版本新开', exact: true })).toHaveCount(0);
  await rewriteBackend.plan({ count: 2, message_groups: [['未选用的合成第一组。'],
    ['待编辑的合成第一条。', '待编辑的合成第二条。']] });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '说法2第1条编辑文本', exact: true })).toHaveValue('待编辑的合成第一条。');
  await expect(helper.getByRole('textbox', { name: '说法2第2条编辑文本', exact: true })).toHaveValue('待编辑的合成第二条。');
  expect(pages.replyTransport.requests.at(-1)).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express' } });
  // 工作区直接提供逐条版本编辑；重读同一讨论须保持消息组和原来历。
  const generatedSessionId = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
  const generatedMetrics = await rewriteBackend.command('metrics');
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '刷新会话列表', exact: true }).click();
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: `查看会话 ${generatedSessionId}`, exact: true }).click();
  await expandSavedDiscussion(helper);
  const group = helper.getByRole('group', { name: '说法2消息组', exact: true });
  await expect(group.getByRole('textbox', { name: '说法2第1条编辑文本', exact: true })).toBeVisible();
  expect(await rewriteBackend.command('metrics')).toEqual(generatedMetrics);
  await openAssistantHistory(helper);
  await expect(group.getByRole('button', { name: '用这组回复新开会话', exact: true })).toBeEnabled();
  await saveGroupMessage(pages, 1, '明确选用的合成编辑第一条。', 1);
  await saveGroupMessage(pages, 2, '明确选用的合成编辑第二条。', 2);
  await openAssistantHistory(helper);
  await expect(group.getByRole('button', { name: '用这组回复新开会话', exact: true })).toBeEnabled();
  return (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
}

export async function assistantCandidateCarry(browser: Browser, origin: string) {
  const migrationCount = (await readdir(path.resolve('../backend/database/migrations'))).filter(name => /^\d{3}.*\.sql$/.test(name)).length;
  expect(migrationCount).toBeGreaterThan(0);
  for (const full of [false, true]) {
    const name = `${full ? '已满' : '普通'}会话公开空新开与完整已选编辑版本携入，旧记录及零自动生成`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, async (pages, host, userData) => {
      const oldId = await selectedVersion(pages);
      expect(await pages.rewriteBackend.command('metrics')).toEqual({ model_calls: 1, migration_count: migrationCount, migration_repeat: 0 });
      const texts = ['明确选用的合成编辑第一条。', '明确选用的合成编辑第二条。'];
      if (!full) return exerciseFork(pages, oldId, texts);
      await host.close();
      await pages.rewriteBackend.command('configure', { capacity: 101 });
      const transport = await RewriteHttpProxy.attach(pages.rewriteBackend.infoPath);
      const next = new PageHost(await browser.newContext(), origin, userData);
      try {
        await next.backend.connect();
        const manager = await next.open('manager');
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const helper: Page = await opened;
        const current = { manager, helper, rewriteBackend: pages.rewriteBackend, replyTransport: transport };
        await chooseContact(current);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('已满预算的合成当前草稿。');
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(helper.getByRole('alert', { name: '模型输入预算', exact: true })).toBeVisible();
        expect(await pages.rewriteBackend.command('metrics')).toEqual({ model_calls: 1, migration_count: migrationCount, migration_repeat: 0 });
        await exerciseFork(current, oldId, texts);
      } finally { transport.release(); await next.close(); await transport.close(); }
    }, undefined, path.resolve('tests/fixtures/assistant-input-budget-page-backend.py'));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
