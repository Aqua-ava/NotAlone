import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';
import { PageHost } from './page-host';
import type { RewriteFixture } from '../rewrite-backend-fixture';
import type { RewritePages } from '../rewrite-page-scenarios';

async function responseTarget({ manager, helper, rewriteBackend }: RewritePages, target = /甲的私密合成历史/) {
  const contactId = rewriteBackend.data.contact_ids[0];
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, contactId);
  await helper.getByRole('button', { name: '回应消息', exact: true }).click();
  await helper.getByRole('radio', { name: target }).click();
  return contactId;
}
function explorationPath(contactId: string, result: Record<string, unknown>) {
  return `/api/contacts/${contactId}/assistant-sessions/${result.session_id}/explorations/${result.exploration_id}`;
}
function choice(result: Record<string, unknown>) {
  return { input_version_id: result.input_version_id,
    suggestion_id: (result.options as Array<{ suggestion_id: string }>)[0].suggestion_id };
}
async function deleteDirectionSource(manager: Page, fixture: RewriteFixture, sourceId: string) {
  const contactId = fixture.data.contact_ids[0];
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await selectMemoryCategory(manager, '来源与过程');
  const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
    .filter({ hasText: `来源标识：${sourceId}` });
  await source.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const sources = await fixture.request(`/api/contacts/${contactId}/sources`);
  const deleted = (sources.data.sources as Array<{ source_id: string; task_id: string; status: string }>)
    .find((item) => item.source_id === sourceId)!;
  expect(deleted.status).toBe('deleted');
  expect((await fixture.request(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`)).data.status).toBe('succeeded');
}

// 保留原六场的行为覆盖；只将退役整数协议与两步选择改接正式UUID确认动作。
export async function understandingDirection(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: understanding-direction-continuity\n');
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    const contactId = await responseTarget(pages);
    const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
    await rewriteBackend.plan({ explore: { understanding: '对方说明回复会晚一点。', ambiguities: ['还不清楚你是否愿意等待。'] } });
    await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect(strategy).toContainText('对方说明回复会晚一点。');
    await expect(strategy).toContainText('甲的私密合成历史');
    await expect(strategy).toContainText('还不清楚你是否愿意等待。');
    expect(replyTransport.requests).toHaveLength(0);
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('这次讨论的是今晚的回复安排，不是邀约。');
    await rewriteBackend.plan({ explore: { understanding: '这里只涉及今晚回复的安排。', question: { text: '本次是否不增加承诺？', impact: 'commitment' } } });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect(strategy).toContainText('这里只涉及今晚回复的安排。');
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
    await expect(strategy).toContainText('已确认本次意愿：表示愿意等待，但不增加承诺。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('纠正理解，原方向仍保留。');
    await rewriteBackend.plan({ fault: 'failure' });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect(helper.getByRole('alert')).toContainText('方向建议暂不可用');
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('表示愿意等待，但不增加承诺。');
    const failed = replyTransport.explorationRequests.at(-1);
    await rewriteBackend.plan({ explore: { understanding: '纠正后仍沿用用户已确认的等待方向。' } });
    await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
    await expect(strategy).toContainText('纠正后仍沿用用户已确认的等待方向。');
    expect(replyTransport.explorationRequests.at(-1)).toEqual(failed);
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('本次纠正结果丢包，仍保留原方向。');
    replyTransport.nextExploration = 'drop';
    await rewriteBackend.plan({ explore: { understanding: '本次纠正已保存，返回丢包。' } });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect(helper.getByRole('alert')).toContainText('方向建议暂不可用');
    const dropped = replyTransport.explorationResults.at(-1)!;
    const droppedRequest = replyTransport.explorationRequests.at(-1);
    const beforeReplay = ((await rewriteBackend.command('observations')).payloads as unknown[]).length;
    await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
    await expect(strategy).toContainText('本次纠正已保存，返回丢包。');
    expect(replyTransport.explorationRequests.at(-1)).toEqual(droppedRequest);
    expect(replyTransport.explorationResults.at(-1)).toEqual(dropped);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(beforeReplay);
    await rewriteBackend.plan({ count: 1, prefix: '你方便时再回复就好' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('你方便时再回复就好（说法1）。');
    const generated = replyTransport.explorationResults.at(-1)!;
    const original = replyTransport.explorationRequests.at(-1)!;
    const turn = generated.data.turn as { session_id: string; reply_request_id: string; input_version_id: string; turn_id: string };
    const url = explorationPath(contactId, { ...generated.data, session_id: turn.session_id }) + '/confirm';
    const evidence = await rewriteBackend.request(`/api/contacts/${contactId}/replies/${turn.reply_request_id}/evidence`);
    expect(evidence.status).toBe(200);
    expect(JSON.stringify(evidence.data)).not.toContain('乙的私密合成历史');
    expect(JSON.stringify(evidence.data)).not.toContain('另一用户的私密合成历史');
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(6);
    expect(payloads.filter((item) => item.input_mode === 'reply_to_message')).toHaveLength(1);
    expect(payloads.at(-1)).toMatchObject({ understanding_correction: '本次纠正结果丢包，仍保留原方向。',
      fidelity_contract: { current_intent: { text: '表示愿意等待，但不增加承诺。' } } });
    // 确认响应只含候选；公开GET实际完成轮次后还原原生成输入和请求键。
    const history = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${turn.session_id}`);
    expect(history.status).toBe(200);
    const recorded = (history.data.turns as Array<{ turn_id: string; state: string; request_key: string;
      input: Record<string, unknown> }>).find((item) => item.turn_id === turn.turn_id)!;
    expect(recorded).toMatchObject({ turn_id: turn.turn_id, state: 'completed' });
    const { suggestion, ...savedContent } = recorded.input.content as Record<string, unknown>;
    const savedRequest = { ...recorded.input, contact_id: contactId, idempotency_key: recorded.request_key,
      content: savedContent, suggestion };
    const savedPath = `/api/contacts/${contactId}/assistant-sessions/${turn.session_id}/replies`;
    const savedReplay = await rewriteBackend.request(savedPath, savedRequest);
    expect(savedReplay.status).toBe(200);
    expect((await rewriteBackend.request(savedPath, { ...savedRequest,
      content: { ...savedContent, understanding_correction: '同一键换成另一个理解纠正。' } })).status).toBe(409);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(6);
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('我想直接说明今晚不再等了。');
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('今晚已经没有时间继续等待。');
    await rewriteBackend.plan({ explore: { understanding: '今晚的等待时间有限。' } });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect(strategy).toContainText('今晚的等待时间有限。');
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('我想直接说明今晚不再等了。');
    const updated = replyTransport.explorationResults.at(-1)!.data;
    expect(updated.input_version_id).not.toBe(turn.input_version_id);
    const afterChange = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(afterChange).toHaveLength(7);
    expect(afterChange.filter((item) => item.input_mode === 'reply_to_message')).toHaveLength(1);
    const changed = await rewriteBackend.request(url, { ...original, direct_intent: '同一确认换成另一种意愿。' });
    expect(changed.status).toBe(409);
    expect(await rewriteBackend.request(url, original)).toEqual(generated);
    expect(await rewriteBackend.request(savedPath, savedRequest)).toEqual(savedReplay);
    await host.close();
    await rewriteBackend.command('restart');
    const restarted = new PageHost(await browser.newContext(), origin, userData);
    try {
      await restarted.backend.connect();
      expect(await rewriteBackend.request(url, original)).toEqual(generated);
      expect(await rewriteBackend.request(savedPath, savedRequest)).toEqual(savedReplay);
    } finally { await restarted.close(); }
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(7);
  });
  process.stdout.write('page_test_scenario: understanding-direction-scope\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    const contactId = await responseTarget(pages);
    await rewriteBackend.plan({ explore: {} });
    await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
    const first = replyTransport.explorationResults.at(-1)!.data;
    const input = replyTransport.explorationRequests.at(-1)!;
    const path = explorationPath(contactId, first);
    const wrongOwner = path.replace(contactId, rewriteBackend.data.other_contact_id);
    const wrongContact = path.replace(contactId, rewriteBackend.data.contact_ids[1]);
    expect(await rewriteBackend.request(wrongOwner + '/confirm', choice(first)))
      .toEqual({ status: 409, data: { error: 'exploration_rejected' } });
    expect(await rewriteBackend.request(wrongContact + '/confirm', choice(first)))
      .toEqual({ status: 409, data: { error: 'exploration_rejected' } });
    const unconfirmed = await rewriteBackend.request('/api/reply/generate', {
      idempotency_key: randomUUID(), contact_id: contactId, content: { type: 'reply_to_message',
        target_message_id: (input.content as Record<string, unknown>).target_message_id,
        direction: '表示愿意等待，但不增加承诺。', direction_source: 'confirmed_suggestion' },
    });
    expect(unconfirmed.status).toBe(409);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    const beforeUpdate = replyTransport.explorationResults.length;
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('换一个理解快照。');
    await rewriteBackend.plan({ explore: {} });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect.poll(() => replyTransport.explorationResults.length).toBe(beforeUpdate + 1);
    expect(replyTransport.explorationResults.at(-1)!.status).toBe(200);
    expect(replyTransport.explorationResults.at(-1)!.data.input_version_id).not.toBe(first.input_version_id);
    expect((await rewriteBackend.request(path + '/confirm', choice(first))).status).toBe(409);
    await rewriteBackend.command('withdraw_target_source');
    await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
    await expect(helper.getByRole('alert')).toContainText('方向建议暂不可用');
    expect(replyTransport.explorationResults.at(-1)?.status).toBe(409);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  });
  process.stdout.write('page_test_scenario: understanding-direction-late-and-failure\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    await responseTarget(pages);
    await rewriteBackend.plan({ explore: { understanding: '旧快照理解' } });
    replyTransport.nextExploration = 'hold';
    await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect.poll(() => replyTransport.explorationResults.length).toBe(1);
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('更新输入使迟到理解失效。');
    await rewriteBackend.plan({ explore: { understanding: '新快照理解' } });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    const strategy = helper.getByRole('region', { name: '理解与方向', exact: true });
    await expect(strategy).toContainText('新快照理解');
    replyTransport.release();
    await expect(strategy).not.toContainText('旧快照理解');
    for (const plan of [{ explore: { invalid_evidence: true } }, { explore: { same_stance: true } }, { fault: 'failure' as const }]) {
      const count = replyTransport.explorationResults.length;
      await rewriteBackend.plan(plan);
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      await expect.poll(() => replyTransport.explorationResults.length).toBe(count + 1);
      await expect(helper.getByRole('alert')).toContainText('方向建议暂不可用');
      await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toHaveCount(0);
    }
    expect(replyTransport.requests).toHaveLength(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(5);
    const ledger = await rewriteBackend.request('/api/ledger/summary');
    expect(ledger.status).toBe(200);
    expect(JSON.stringify(ledger.data)).not.toContain('甲的私密合成历史');
  });
  process.stdout.write('page_test_scenario: understanding-direction-private-input-deletion\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { manager, helper, rewriteBackend, replyTransport } = pages;
    const contactId = await responseTarget(pages);
    const marker = '保留合成来源派生隐私标记，表示愿意等待。';
    await rewriteBackend.plan({ explore: { direction: marker } });
    await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
    const first = replyTransport.explorationResults.at(-1)!.data;
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('合成来源派生纠正，不确认意愿。');
    await rewriteBackend.plan({ explore: { direction: marker, question: { text: '是否只保留本次意愿？', impact: 'commitment' } } });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect.poll(() => replyTransport.explorationResults.length).toBe(2);
    expect((await rewriteBackend.request(explorationPath(contactId, first) + '/confirm', choice(first))).status).toBe(409);
    expect(await rewriteBackend.command('reply_privacy_counts')).toEqual({ total: 0, sensitive: 0, failed: 0 });
    await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue(marker);
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill(`${marker} 用户追加本次措辞。`);
    const sources = await rewriteBackend.request(`/api/contacts/${contactId}/sources`);
    await deleteDirectionSource(manager, rewriteBackend, (sources.data.sources as Array<{ source_id: string }>)[0].source_id);
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    await expect(helper.getByRole('textbox', { name: '纠正理解', exact: true })).toHaveValue('');
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
    await expect(helper.getByText('合成来源派生隐私标记', { exact: false })).toHaveCount(0);
    const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${first.session_id}`);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.data)).not.toContain('合成来源派生');
    expect(await rewriteBackend.command('reply_privacy_counts')).toEqual({ total: 0, sensitive: 0, failed: 0 });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  });
  process.stdout.write('page_test_scenario: understanding-direction-retained-source-deletion\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { manager, helper, rewriteBackend, replyTransport } = pages;
    const contactId = rewriteBackend.data.contact_ids[0];
    const dependency = await rewriteBackend.command('direction_dependency') as { target_source: string; adjacent_source: string };
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, contactId);
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    for (let page = 0; page < 2; page++) {
      const count = await helper.getByRole('radio').count();
      await helper.getByRole('button', { name: '加载更早消息', exact: true }).click();
      await expect.poll(() => helper.getByRole('radio').count()).toBeGreaterThan(count);
    }
    await helper.getByRole('radio', { name: /合成较早的回应目标/ }).click();
    const direction = '说明合成相邻来源隐私标记所对应的边界。';
    await rewriteBackend.plan({ explore: { direction, question: { text: '本次是否不承诺下一次安排？', impact: 'commitment' } } });
    await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
    await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue(direction);
    await rewriteBackend.command('shift_direction_dependency', { target_source: dependency.target_source });
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('只纠正当前语境，原先明确的意愿仍保留。');
    await rewriteBackend.plan({ explore: {} });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect.poll(() => replyTransport.explorationResults.length).toBe(3);
    const shiftedPayloads = (await rewriteBackend.command('observations')).payloads as Array<{ evidence: Array<{ text: string }> }>;
    expect(shiftedPayloads[1].evidence.map((item) => item.text)).not.toContain('合成相邻来源隐私标记');
    await rewriteBackend.plan({ count: 1, prefix: '合成相邻来源隐私标记的本次候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('合成相邻来源隐私标记的本次候选（说法1）。');
    const generated = replyTransport.explorationResults.at(-1)!;
    const turn = generated.data.turn as { session_id: string; reply_request_id: string };
    const original = replyTransport.explorationRequests.at(-1)!;
    const generationPayloads = (await rewriteBackend.command('observations')).payloads as Array<{ input_mode: string; evidence: Array<{ text: string }> }>;
    const payload = generationPayloads.find((item) => item.input_mode === 'reply_to_message')!;
    expect(payload.evidence.filter((item) => item.text.startsWith('用于分页的合成近期消息')).length).toBeLessThanOrEqual(49);
    expect(payload.evidence.map((item) => item.text)).not.toContain('合成相邻来源隐私标记');
    const evidencePath = `/api/contacts/${contactId}/replies/${turn.reply_request_id}/evidence`;
    expect(JSON.stringify((await rewriteBackend.request(evidencePath)).data)).toContain('合成相邻来源隐私标记');
    await deleteDirectionSource(manager, rewriteBackend, dependency.adjacent_source);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('');
    expect((await rewriteBackend.request(evidencePath)).status).toBe(404);
    expect(await rewriteBackend.command('reply_privacy_counts')).toEqual({ total: 0, sensitive: 0, failed: 0 });
    const url = explorationPath(contactId, { ...generated.data, session_id: turn.session_id }) + '/confirm';
    expect((await rewriteBackend.request(url, original)).status).toBe(409);
    expect(await rewriteBackend.command('reply_privacy_counts')).toEqual({ total: 0, sensitive: 0, failed: 0 });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
  });
  process.stdout.write('page_test_scenario: understanding-direction-original-intent-expiry\n');
  await withRewritePages(browser, origin, async (pages) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    await responseTarget(pages);
    await rewriteBackend.plan({ explore: { question: { text: '本次是否不增加承诺？', impact: 'commitment' } } });
    await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
    await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
    await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('表示愿意等待，但不增加承诺。');
    const selected = replyTransport.explorationResults.at(-1)!.data;
    await rewriteBackend.command('age_exploration', { seconds: 895 });
    await helper.getByRole('textbox', { name: '纠正理解', exact: true }).fill('纠正后仍保留同一个明确意愿。');
    await rewriteBackend.plan({ explore: {} });
    await helper.getByRole('button', { name: '更新理解', exact: true }).click();
    await expect.poll(() => replyTransport.explorationResults.length).toBe(3);
    const corrected = replyTransport.explorationResults.at(-1)!;
    expect(corrected.status).toBe(200);
    expect(corrected.data.input_version_id).not.toBe(selected.input_version_id);
    expect(corrected.data.confirmed_intent).toBe('表示愿意等待，但不增加承诺。');
    await expect(helper.getByRole('textbox', { name: '表达方向', exact: true })).toHaveValue('表示愿意等待，但不增加承诺。');
    await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeEnabled();
    const requests = replyTransport.explorationRequests.length;
    await rewriteBackend.command('age_exploration', { seconds: 6 });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect.poll(() => replyTransport.explorationRequests.length).toBe(requests + 1);
    await expect(helper.getByRole('alert')).toContainText('方向建议暂不可用');
    expect(replyTransport.explorationResults.at(-1)?.status).toBe(409);
    expect(replyTransport.explorationRequests.at(-1)).toMatchObject({ input_version_id: corrected.data.input_version_id });
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
    expect((await rewriteBackend.command('reply_privacy_counts')).sensitive).toBe(0);
  });
}
