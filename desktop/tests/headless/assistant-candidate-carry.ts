import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import path from 'node:path';
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
  await expect(helper.getByRole('button', { name: '携已选版本新开', exact: true })).toBeEnabled();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('未提交的旧会话合成草稿不得携入。');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('未提交的旧会话临时要求不得携入。');
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '携已选版本新开', exact: true }).click();
  await expandSavedDiscussion(helper);
  const carried = helper.getByRole('article', { name: '携入的已选版本', exact: true });
  await expect(carried).toBeVisible();
  for (const text of expectedTexts) await expect(carried.getByText(text, { exact: true })).toBeVisible();
  await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
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
  expect((await rewriteBackend.request(path)).data).toEqual(original);
  expect(await rewriteBackend.command('metrics')).toEqual(before);
  process.stdout.write(`page_test_carry: blank_empty=true carry_messages=${expectedTexts.length} old_unchanged=true new_turns=0 automatic_model_delta=0 migrations=55 repeat=0\n`);
}

async function selectedVersion(pages: RewritePages): Promise<string> {
  const { helper, rewriteBackend } = pages;
  await chooseContact(pages);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('合成原稿：谢谢邀请，这次不参与。');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('只属于旧讨论的合成要求。');
  await openAssistantHistory(helper);
  await expect(helper.getByRole('button', { name: '携已选版本新开', exact: true })).toBeDisabled();
  await rewriteBackend.plan({ count: 2, message_groups: [['未选用的合成第一组。'],
    ['待编辑的合成第一条。', '待编辑的合成第二条。']] });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true }))
    .toHaveValue('待编辑的合成第一条。\n\n待编辑的合成第二条。');
  // 即时草稿沿用文本编辑；通过公开旧会话入口读取已保存版本再逐条修改。
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
  await expect(helper.getByRole('button', { name: '携已选版本新开', exact: true })).toBeDisabled();
  await group.getByRole('textbox', { name: '说法2第1条编辑文本', exact: true }).fill('明确选用的合成编辑第一条。');
  await group.getByRole('textbox', { name: '说法2第2条编辑文本', exact: true }).fill('明确选用的合成编辑第二条。');
  await group.getByRole('button', { name: '保存本组修改', exact: true }).click();
  await expect(group.getByRole('combobox', { name: '说法2版本', exact: true }).getByRole('option')).toHaveCount(2);
  await group.getByRole('radio', { name: '选择说法2当前版本', exact: true }).click();
  await expect(group.getByRole('radio', { name: '选择说法2当前版本', exact: true })).toBeChecked();
  await openAssistantHistory(helper);
  await expect(helper.getByRole('button', { name: '携已选版本新开', exact: true })).toBeEnabled();
  return (await helper.evaluate(async () => window.notalone.replies.getState())).savedSession!.sessionId!;
}

export async function assistantCandidateCarry(browser: Browser, origin: string) {
  for (const full of [false, true]) {
    const name = `${full ? '已满' : '普通'}会话公开空新开与完整已选编辑版本携入，旧记录及零自动生成`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, async (pages, host, userData) => {
      const oldId = await selectedVersion(pages);
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
        await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('已满预算的合成当前草稿。');
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        await expect(helper.getByRole('alert', { name: '模型输入预算', exact: true })).toBeVisible();
        expect(await pages.rewriteBackend.command('metrics')).toEqual({ model_calls: 1, migration_count: 55, migration_repeat: 0 });
        await exerciseFork(current, oldId, texts);
      } finally { transport.release(); await next.close(); await transport.close(); }
    }, undefined, path.resolve('tests/fixtures/assistant-input-budget-page-backend.py'));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
