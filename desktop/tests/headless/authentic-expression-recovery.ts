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
const manualSample = '合成旧说法：我过去总答应，明晚七点陪你去合成海边。';
const sourceDirection = '只回应选定的合成消息，不增加安排。';
const sourceReply = '来自合成原始来源的样本候选。';

type Generation = { request: Record<string, unknown>; result: Record<string, unknown> };

function latestGeneration(pages: RewritePages): Generation {
  const response = pages.replyTransport.results.at(-1)!;
  expect(response.status).toBe(200);
  return { request: pages.replyTransport.requests.at(-1)!, result: response.data };
}

async function chooseContact(manager: Page, helper: Page, contactId: string) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, contactId);
}

async function generate(pages: RewritePages, text: string) {
  await pages.rewriteBackend.plan({ count: 1, text, basis: '仅核验合成材料的数据与控制契约。' });
  await pages.helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(text);
  return latestGeneration(pages);
}

async function expectSavedAfterDeletion(helper: Page, redactedCount: number) {
  const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
  await expect(discussion.getByText(independentInput, { exact: true })).toBeVisible();
  await expect(discussion.getByText(independentReply, { exact: true })).toBeVisible();
  for (const text of [currentIntent, referenceReply, sourceDirection, sourceReply, manualSample]) {
    await expect(discussion.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  const state = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(state.result).toBeNull();
  expect(state.savedSession?.phase).toBe('ready');
  const completed = state.savedSession!.turns.filter((turn) => turn.state === 'completed');
  expect(completed).toHaveLength(1);
  expect(completed[0].input?.content).toMatchObject({ draft_text: independentInput });
  expect(completed[0].reply?.candidates[0].text).toBe(independentReply);
  const redacted = state.savedSession!.turns.filter((turn) => turn.state === 'redacted');
  expect(redacted).toHaveLength(redactedCount);
  for (const turn of redacted) { expect(turn.input).toBeNull(); expect(turn.reply).toBeNull(); }
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(0);
}

async function deletionRecovery(pages: RewritePages, host: PageHost, userData: string,
  browser: Browser, origin: string, removal: 'sample' | 'source') {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  const contactId = rewriteBackend.data.contact_ids[0];
  await chooseContact(manager, helper, contactId);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill(independentInput);
  const independent = await generate(pages, independentReply);
  await helper.getByText('我的表达样本', { exact: true }).click();
  if (removal === 'sample') {
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(manualSample);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
  } else {
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill(sourceDirection);
    await generate(pages, sourceReply);
    await helper.getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
  }
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(1);
  const sample = (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples[0];
  expect(sample.originKind).toBe(removal === 'sample' ? 'manual' : 'candidate');
  if (removal === 'source') expect(sample.sourceIds.length).toBeGreaterThan(0);
  await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
  await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill(currentIntent);
  const reference = await generate(pages, referenceReply);
  const payloads = (await rewriteBackend.command('observations')).payloads as Record<string, unknown>[];
  const payload = payloads.at(-1)!;
  expect(payload.fidelity_contract).toMatchObject({ current_intent: { text: currentIntent } });
  expect(payload.style_references).toEqual([expect.objectContaining({ sample_id: sample.sampleId, text: sample.text,
    factual_role: 'expression_reference', weight: 'low' })]);
  expect((reference.result.context_receipt as { style_sample_ids: string[] }).style_sample_ids).toEqual([sample.sampleId]);
  await expect(helper.getByRole('region', { name: '本次表达参考', exact: true }).getByText(sample.text, { exact: true })).toBeVisible();
  const sessionPath = `/api/contacts/${contactId}/assistant-sessions/${reference.result.session_id}`;
  if (removal === 'sample') {
    await helper.getByRole('button', { name: `删除表达样本：${sample.text}`, exact: true }).click();
  } else {
    await manager.getByRole('button', { name: '关系资料', exact: true }).click();
    const sources = manager.getByRole('region', { name: '来源删除管理', exact: true });
    await sources.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(sources.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
    await expect.poll(() => manager.evaluate(async () => (await window.notalone.sources.getState()).busySourceId)).toBeNull();
  }
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(0);
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  expect((await rewriteBackend.request(sessionPath + '/replies', reference.request)).status).not.toBe(200);
  const saved = await rewriteBackend.request(sessionPath);
  expect(saved.status).toBe(200);
  expect((await rewriteBackend.request(sessionPath + '/replies', { ...reference.request, idempotency_key: randomUUID(),
    expected_input_version_id: saved.data.current_input_version_id,
    continued_from_candidate_id: (reference.result.candidates as { candidate_id: string }[])[0].candidate_id })).status).not.toBe(200);
  expect((await rewriteBackend.request(`/api/contacts/${contactId}/replies/${reference.result.reply_request_id}/evidence`)).status).not.toBe(200);
  expect((await rewriteBackend.request(sessionPath + '/replies', independent.request)).data).toEqual(independent.result);

  replyTransport.failRuntime = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  replyTransport.failRuntime = false;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await chooseContact(manager, helper, contactId);
  await expectSavedAfterDeletion(helper, removal === 'sample' ? 1 : 2);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(removal === 'sample' ? 2 : 3);

  // restart只重新装配同一Python夹具内的后端；公开宿主也重新创建，不称进程重启。
  await host.close();
  await rewriteBackend.command('restart');
  const reopened = new PageHost(await browser.newContext(), origin, userData);
  try {
    await reopened.backend.connect();
    const nextManager = await reopened.open('manager');
    await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    const nextHelper = await reopened.open('helper');
    await confirmHelperContact(nextHelper, contactId);
    await expectSavedAfterDeletion(nextHelper, removal === 'sample' ? 1 : 2);
    expect((await rewriteBackend.request(sessionPath + '/replies', reference.request)).status).not.toBe(200);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(removal === 'sample' ? 2 : 3);
  } finally { await reopened.close(); }
}

export async function authenticExpressionRecovery(browser: Browser, origin: string) {
  for (const removal of ['sample', 'source'] as const) {
    const name = removal === 'sample' ? '删除样本后重连与重开保留独立讨论' : '删除原始来源后重连与重开不复活样本和派生讨论';
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, (pages, host, userData) => deletionRecovery(pages, host, userData, browser, origin, removal));
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
