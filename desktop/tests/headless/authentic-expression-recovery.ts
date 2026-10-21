import { selectContact } from '../contact-picker-actions.mjs';
import { fillWorkspaceThought, setWorkspaceContext } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { openImportManagement } from '../memory-page-actions';
import { randomUUID } from 'node:crypto';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

const independentInput = '独立保存的合成讨论：稍后再确认。';
const independentReply = '独立保存的合成候选。';
const currentIntent = '本次明确拒绝聚会，不增加安排。';
const referenceReply = '这次我不参加。';
const sourceDirection = '只结合最近的合成聊天回应，不增加安排。';
const sourceReply = '来自合成原始来源的候选。';

type Generation = { request: Record<string, unknown>; result: Record<string, unknown> };

function latestGeneration(pages: RewritePages): Generation {
  const response = pages.replyTransport.results.at(-1)!;
  expect(response.status).toBe(200);
  return { request: pages.replyTransport.requests.at(-1)!, result: response.data };
}

async function chooseContact(manager: Page, helper: Page, contactId: string) {
  await manager.getByRole('button', { name: '联系人', exact: true }).click();
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await confirmHelperContact(helper, contactId);
}

async function generate(pages: RewritePages, text: string) {
  await pages.rewriteBackend.plan({ count: 1, text, basis: '仅核验合成材料的数据与控制契约。' });
  await pages.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(text);
  const generation = latestGeneration(pages);
  expect(generation.request).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express' } });
  return generation;
}

async function expectSavedAfterDeletion(helper: Page, redactedCount: number) {
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
  await expect(discussion.getByText(independentInput, { exact: true })).toBeVisible();
  await expect(discussion.getByText(independentReply, { exact: true })).toBeVisible();
  for (const text of [currentIntent, referenceReply, sourceDirection, sourceReply]) {
    await expect(discussion.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  const state = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(state.result).toBeNull();
  expect(state.savedSession?.phase).toBe('ready');
  const completed = state.savedSession!.turns.filter((turn) => turn.state === 'completed');
  expect(completed).toHaveLength(1);
  expect(completed[0].input?.content).toMatchObject({ draft_text: independentInput, input_kind: 'workspace',
    workspace_action: 'express', include_relationship_context: false });
  expect(completed[0].reply?.candidates[0].text).toBe(independentReply);
  const redacted = state.savedSession!.turns.filter((turn) => turn.state === 'redacted');
  expect(redacted).toHaveLength(redactedCount);
  for (const turn of redacted) { expect(turn.input).toBeNull(); expect(turn.reply).toBeNull(); }
}

async function deletionRecovery(pages: RewritePages, host: PageHost, userData: string,
  browser: Browser, origin: string) {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  const contactId = rewriteBackend.data.contact_ids[0];
  await chooseContact(manager, helper, contactId);
  await setWorkspaceContext(helper, false);
  await fillWorkspaceThought(helper, independentInput);
  const independent = await generate(pages, independentReply);
  expect(independent.request).toMatchObject({ content: { include_relationship_context: false } });
  await setWorkspaceContext(helper, true);
  await fillWorkspaceThought(helper, sourceDirection);
  await generate(pages, sourceReply);
  await setWorkspaceContext(helper, true);
  await fillWorkspaceThought(helper, currentIntent);
  const reference = await generate(pages, referenceReply);
  expect(reference.request).toMatchObject({ content: { include_relationship_context: true, draft_text: currentIntent } });
  const payloads = (await rewriteBackend.command('observations')).payloads as Record<string, unknown>[];
  const payload = payloads.at(-1)!;
  expect(payload.fidelity_contract).toMatchObject({ current_intent: { text: currentIntent } });
  const sessionPath = `/api/contacts/${contactId}/assistant-sessions/${reference.result.session_id}`;
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const sources = manager.getByRole('region', { name: '已导入资料', exact: true });
  await sources.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(sources.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
  await expect.poll(() => manager.evaluate(async () => (await window.notalone.sources.getState()).busySourceId)).toBeNull();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  expect((await rewriteBackend.request(sessionPath + '/replies', reference.request)).status).not.toBe(200);
  const saved = await rewriteBackend.request(sessionPath);
  expect(saved.status).toBe(200);
  expect(saved.data.current_input_version_id).toBeNull();
  const continuation = { ...reference.request, idempotency_key: randomUUID(),
    continued_from_candidate_id: (reference.result.candidates as { candidate_id: string }[])[0].candidate_id };
  // HTTP 空 expected 以省略字段表示，不能让解析层 400 代替已删候选守卫。
  delete (continuation as Record<string, unknown>).expected_input_version_id;
  expect(await rewriteBackend.request(sessionPath + '/replies', continuation)).toEqual({
    status: 409, data: { error: 'assistant_session_rejected', reason: 'continued_candidate_unavailable' },
  });
  expect(await rewriteBackend.request(sessionPath)).toEqual(saved);
  expect((await rewriteBackend.request(`/api/contacts/${contactId}/replies/${reference.result.reply_request_id}/evidence`)).status).not.toBe(200);
  expect((await rewriteBackend.request(sessionPath + '/replies', independent.request)).data).toEqual(independent.result);

  replyTransport.failRuntime = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  replyTransport.failRuntime = false;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await chooseContact(manager, helper, contactId);
  await expectSavedAfterDeletion(helper, 2);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);

  // restart只重新装配同一Python夹具内的后端；公开宿主也重新创建，不称进程重启。
  await host.close();
  await rewriteBackend.command('restart');
  const reopened = new PageHost(await browser.newContext(), origin, userData);
  try {
    await reopened.backend.connect();
    const nextManager = await reopened.open('manager');
    await selectContact(nextManager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    const nextHelper = await reopened.open('helper');
    await confirmHelperContact(nextHelper, contactId);
    await expectSavedAfterDeletion(nextHelper, 2);
    expect((await rewriteBackend.request(sessionPath + '/replies', reference.request)).status).not.toBe(200);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
  } finally { await reopened.close(); }
}

export async function authenticExpressionRecovery(browser: Browser, origin: string) {
  const name = '删除原始来源后重连与重开不复活派生讨论';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  await withRewritePages(browser, origin, (pages, host, userData) => deletionRecovery(pages, host, userData, browser, origin));
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
