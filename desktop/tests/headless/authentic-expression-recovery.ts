import { fillWorkspaceThought, setWorkspaceContext } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { selectMemoryCategory } from '../memory-page-actions';
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
const sourceDirection = '只结合最近的合成聊天回应，不增加安排。';
const sourceReply = '来自合成原始来源的样本候选。';

type Generation = { request: Record<string, unknown>; result: Record<string, unknown> };

function latestGeneration(pages: RewritePages): Generation {
  const response = pages.replyTransport.results.at(-1)!;
  expect(response.status).toBe(200);
  return { request: pages.replyTransport.requests.at(-1)!, result: response.data };
}

async function chooseContact(manager: Page, helper: Page, contactId: string) {
  await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
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
  for (const text of [currentIntent, referenceReply, sourceDirection, sourceReply, manualSample]) {
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
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(0);
}

async function deletionRecovery(pages: RewritePages, host: PageHost, userData: string,
  browser: Browser, origin: string, removal: 'sample' | 'source') {
  const { manager, helper, rewriteBackend, replyTransport } = pages;
  const contactId = rewriteBackend.data.contact_ids[0];
  await chooseContact(manager, helper, contactId);
  await setWorkspaceContext(helper, false);
  await fillWorkspaceThought(helper, independentInput);
  const independent = await generate(pages, independentReply);
  expect(independent.request).toMatchObject({ content: { include_relationship_context: false } });
  await helper.getByText('我的表达样本', { exact: true }).click();
  if (removal === 'sample') {
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(manualSample);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
  } else {
    await setWorkspaceContext(helper, true);
    await fillWorkspaceThought(helper, sourceDirection);
    await generate(pages, sourceReply);
    await helper.getByRole('group', { name: '说法1消息组', exact: true }).getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
  }
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples.length).toBe(1);
  const sample = (await helper.evaluate(async () => window.notalone.styleSamples.getState())).samples[0];
  expect(sample.originKind).toBe(removal === 'sample' ? 'manual' : 'candidate');
  if (removal === 'source') expect(sample.sourceIds.length).toBeGreaterThan(0);
  await setWorkspaceContext(helper, true);
  await fillWorkspaceThought(helper, currentIntent);
  const reference = await generate(pages, referenceReply);
  expect(reference.request).toMatchObject({ content: { include_relationship_context: true, draft_text: currentIntent } });
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
    await manager.getByRole('button', { name: '记忆', exact: true }).click();
    await selectMemoryCategory(manager, '来源与过程');
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


// C03：删除讨论只保留主动保存的最终样本；原始来源随后删除仍传递清理。
export async function authenticExpressionSessionRetention(browser: Browser, origin: string) {
  for (const removal of ['sample', 'source'] as const) {
    const name = `删除助手会话后样本独立再用，随后删除${removal === 'sample' ? '样本' : '原始来源'}清除新派生`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, async (pages) => {
      const { manager, helper, rewriteBackend } = pages;
      const contactId = rewriteBackend.data.contact_ids[0];
      await chooseContact(manager, helper, contactId);
      await setWorkspaceContext(helper, true);
      await fillWorkspaceThought(helper, sourceDirection);
      const first = await generate(pages, sourceReply);
      await helper.getByText('我的表达样本', { exact: true }).click();
      await helper.getByRole('group', { name: '说法1消息组', exact: true }).getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
      const list = helper.getByRole('list', { name: '表达样本目录', exact: true });
      await expect(list.getByText(sourceReply, { exact: true })).toBeVisible();
      const samplePath = `/api/contacts/${contactId}/style-samples`;
      const savedSamples = await rewriteBackend.request(samplePath);
      expect(savedSamples.status).toBe(200);
      expect(savedSamples.data.samples).toHaveLength(1);
      const sample = (savedSamples.data.samples as Array<{ sample_id: string; origin_kind: string; source_ids: string[] }>)[0];
      expect(sample.origin_kind).toBe('candidate');
      expect(sample.source_ids.length).toBeGreaterThan(0);
      const oldPath = `/api/contacts/${contactId}/assistant-sessions/${first.result.session_id}`;
      await openAssistantHistory(helper);
      await helper.getByRole('button', { name: '删除当前助手会话', exact: true }).click();
      await helper.getByRole('group', { name: '确认删除助手会话', exact: true })
        .getByRole('button', { name: '确认删除会话', exact: true }).click();
      await expect(helper.getByRole('status').filter({ hasText: '当前助手会话已删除' })).toBeVisible();
      expect((await rewriteBackend.request(oldPath)).status).toBe(404);
      expect(await rewriteBackend.request(samplePath)).toEqual(savedSamples);
      await expect(list.getByText(sourceReply, { exact: true })).toBeVisible();
      await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })).toHaveCount(0);
      await openAssistantHistory(helper);
      await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
      await expect(helper.getByText('当前会话还没有讨论。', { exact: true })).toBeVisible();
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
      await setWorkspaceContext(helper, true);
      await fillWorkspaceThought(helper, currentIntent);
      const second = await generate(pages, referenceReply);
      expect(second.result.session_id).not.toBe(first.result.session_id);
      expect((second.result.context_receipt as { style_sample_ids: string[] }).style_sample_ids).toEqual([sample.sample_id]);
      const payloads = (await rewriteBackend.command('observations')).payloads as Record<string, unknown>[];
      expect(payloads).toHaveLength(2);
      expect(payloads[1].fidelity_contract).toMatchObject({ current_intent: { text: currentIntent } });
      expect(payloads[1].style_references).toEqual([expect.objectContaining({ sample_id: sample.sample_id, text: sourceReply })]);
      const nextPath = `/api/contacts/${contactId}/assistant-sessions/${second.result.session_id}`;
      if (removal === 'sample') {
        await helper.getByRole('button', { name: `删除表达样本：${sourceReply}`, exact: true }).click();
      } else {
        await manager.getByRole('button', { name: '记忆', exact: true }).click();
        await selectMemoryCategory(manager, '来源与过程');
        const sources = manager.getByRole('region', { name: '来源删除管理', exact: true });
        await sources.getByRole('button', { name: '删除来源', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(sources.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      }
      await expect.poll(async () => (await rewriteBackend.request(samplePath)).data.samples).toEqual([]);
      const erased = await rewriteBackend.request(nextPath);
      expect(erased.status).toBe(200);
      expect(erased.data.current_input_version_id).toBeNull();
      expect(erased.data.turns).toEqual([expect.objectContaining({ state: 'redacted', input: null, reply: null })]);
      expect((await rewriteBackend.request(nextPath + '/replies', second.request)).status).not.toBe(200);
      expect((await rewriteBackend.request(oldPath)).status).toBe(404);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
    });
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
