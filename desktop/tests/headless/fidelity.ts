import { selectContact } from '../contact-picker-actions.mjs';
import { setWorkspaceContext, fillWorkspaceInstruction } from '../workspace-actions';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

function savedReplyPath(contactId: string, output: Record<string, unknown>) {
  expect(typeof output.session_id).toBe('string');
  return `/api/contacts/${contactId}/assistant-sessions/${output.session_id}/replies`;
}

// 捕获实际模型输入/HTTP结果/计量，期望与判定只在报告侧，不进入模型计划。
export async function fidelityIntent(browser: Browser, origin: string) {
  const rows: object[] = [];
  let modelCalls = 0;
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    const contactId = rewriteBackend.data.contact_ids[0];
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await confirmHelperContact(helper, contactId);
    expect((await rewriteBackend.request('/api/memories/manual-owner', {
      text: '合成旧习惯：用户过去总是赞成这个方案。', category: 'preference',
    })).status).toBe(200);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('我不赞成这个方案。');
    await fillWorkspaceInstruction(helper, '措辞自然，最好改成赞成。');
    await setWorkspaceContext(helper, true);
    for (const [caseId, prefix] of [['rewrite-preserve', '这个方案我不赞成'], ['rewrite-stance-error', '赞成这个方案']] as const) {
      await rewriteBackend.plan({ count: 1, prefix });
      const before = replyTransport.results.length; const start = performance.now();
      await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(`${prefix}（说法1）。`);
      await expect.poll(() => replyTransport.results.length).toBe(before + 1);
      const latencyMs = performance.now() - start;
      const observed = await rewriteBackend.command('observations');
      const payload = (observed.payloads as Record<string, unknown>[]).at(-1)!;
      const callCount = (observed.payloads as unknown[]).length - modelCalls;
      modelCalls += callCount;
      const systemPrompt = (observed.outbound as string[]).find((text) => text.includes('改写附加要求不得偷换原句的立场') && text.includes('## Reply Skills'));
      expect(systemPrompt).toContain('改写附加要求不得偷换原句的立场');
      expect(payload.fidelity_contract).toMatchObject({ version: 'fidelity-v1',
        current_intent: { source: 'draft_text', text: '我不赞成这个方案。' }, instruction_scope: 'expression_only' });
      expect((payload.fidelity_contract as { priority: string[] }).priority[0]).toBe('current_explicit_intent');
      expect((payload.evidence as { kind: string; text: string }[]).some((item) => item.kind === 'owner_memory' && item.text.includes('总是赞成'))).toBe(true);
      const result = replyTransport.results.at(-1)!;
      const persisted = await rewriteBackend.request(`/api/contacts/${contactId}/replies/${result.data.reply_request_id}/evidence`);
      expect(persisted.status).toBe(200);
      const replay = await rewriteBackend.request(savedReplyPath(contactId, result.data), replyTransport.requests.at(-1)!);
      expect(replay.data).toEqual(result.data);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(modelCalls);
      expect(JSON.stringify(payload)).not.toContain('乙的私密合成历史');
      expect(JSON.stringify(payload)).not.toContain('另一用户的私密合成历史');
      rows.push({ case_id: caseId, owner_id: rewriteBackend.data.owner_id, contact_id: contactId,
        payload, system_prompt: systemPrompt, output: result.data, latency_ms: latencyMs, call_count: callCount });
    }
    await setWorkspaceContext(helper, true);
    await helper.getByRole('checkbox', { name: /甲的私密合成历史/ }).check();
    await expect(helper.getByRole('checkbox', { name: /甲的私密合成历史/ })).toBeChecked();
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('本次拒绝参加，不作新的安排。');
    await rewriteBackend.plan({ count: 1, prefix: '这次我不参加' });
    const start = performance.now();
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('这次我不参加（说法1）。');
    const observed = await rewriteBackend.command('observations');
    const payload = (observed.payloads as Record<string, unknown>[]).at(-1)!;
    expect(payload.fidelity_contract).toMatchObject({ current_intent: {
      source: 'draft_text', text: '本次拒绝参加，不作新的安排。',
    } });
    rows.push({ case_id: 'reply-preserve', owner_id: rewriteBackend.data.owner_id, contact_id: contactId,
      payload, system_prompt: (observed.outbound as string[]).find((text) => text.includes('改写附加要求不得偷换原句的立场') && text.includes('## Reply Skills')),
      output: replyTransport.results.at(-1)!.data, latency_ms: performance.now() - start,
      call_count: (observed.payloads as unknown[]).length - modelCalls });
    modelCalls = (observed.payloads as unknown[]).length;
    await setWorkspaceContext(helper, true);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('只问近况，不承诺见面。');
    await rewriteBackend.plan({ count: 1, text: '最近怎么样？', basis: '按本次明确目的关心近况，不增加见面安排。' });
    const proactiveStart = performance.now();
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('最近怎么样？');
    const proactiveLatency = performance.now() - proactiveStart;
    const proactiveObserved = await rewriteBackend.command('observations');
    const proactivePayload = (proactiveObserved.payloads as Record<string, unknown>[]).at(-1)!;
    expect(proactivePayload.fidelity_contract).toMatchObject({ current_intent: {
      source: 'draft_text', text: '只问近况，不承诺见面。',
    } });
    expect(proactivePayload).not.toHaveProperty('current_text');
    expect(proactivePayload).not.toHaveProperty('target_message_id');
    const proactiveOutput = replyTransport.results.at(-1)!.data;
    expect((await rewriteBackend.request(savedReplyPath(contactId, proactiveOutput), replyTransport.requests.at(-1)!)).data).toEqual(proactiveOutput);
    const proactiveCalls = (proactiveObserved.payloads as unknown[]).length - modelCalls;
    expect(proactiveCalls).toBe(1);
    rows.push({ case_id: 'purpose-preserve', owner_id: rewriteBackend.data.owner_id, contact_id: contactId,
      payload: proactivePayload, system_prompt: (proactiveObserved.outbound as string[]).find((text) => text.includes('改写附加要求不得偷换原句的立场') && text.includes('## Reply Skills')),
      output: proactiveOutput, latency_ms: proactiveLatency, call_count: proactiveCalls });
  });
  await writeFile('artifacts/headless-pages/fidelity-intent-current-observations.json', JSON.stringify({
    data_kind: 'synthetic', data_version: 'intent-public-current-v2', entry_point: 'page', rows,
    limits: ['受控模型只证明输入、隔离、持久化及重放契约，不证明真实模型语义质量。'],
  }, null, 2) + '\n', { mode: 0o600 });
}

export async function fidelityContent(browser: Browser, origin: string) {
  const plans = JSON.parse(await readFile('../backend/tests/fixtures/fidelity/content-public-plans.json', 'utf8')) as
    { case_id: string; empty_history: boolean; output: { text: string; basis: string; risk_notes?: string[] } }[];
  const rows: object[] = [];
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await rewriteBackend.command('fidelity_history');
    let selected: string | undefined;
    let modelCalls = 0;
    for (const testCase of plans) {
      const contact = testCase.empty_history ? rewriteBackend.data.empty_contact_id : rewriteBackend.data.contact_ids[0];
      if (contact !== selected) {
        await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: testCase.empty_history ? '无消息的合成联系人' : '合成联系人甲' });
        await confirmHelperContact(helper, contact);
        if (testCase.empty_history) {
          await setWorkspaceContext(helper, true);
          await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今天不参加聚会。');
          await setWorkspaceContext(helper, true);
        } else {
          await setWorkspaceContext(helper, true);
          await helper.getByRole('checkbox', { name: /合成当前邀请/ }).check();
          await expect(helper.getByRole('checkbox', { name: /合成当前邀请/ })).toBeChecked();
          await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今天不参加聚会。');
        }
        selected = contact;
      }
      await rewriteBackend.plan({ count: 1, ...testCase.output });
      const requestCount = replyTransport.results.length; const start = performance.now();
      const next = helper.getByRole('button', { name: '帮我表达', exact: true });
      await (await next.count() ? next : helper.getByRole('button', { name: '帮我表达', exact: true })).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(testCase.output.text);
      await expect.poll(() => replyTransport.results.length).toBe(requestCount + 1);
      const latencyMs = performance.now() - start;
      const observed = await rewriteBackend.command('observations', { latest: true });
      const payload = (observed.payloads as Record<string, unknown>[]).at(-1)!;
      expect(payload.fidelity_contract).toMatchObject({ current_intent: { text: '今天不参加聚会。' },
        content_boundary: { citation_validity: 'does_not_prove_semantic_support' } });
      const evidence = payload.evidence as { kind: string; text: string; factual_role: string }[];
      expect(evidence.every((item) => item.factual_role)).toBe(true);
      expect(evidence.some((item) => item.text.includes('我去年住在台北'))).toBe(!testCase.empty_history);
      expect(JSON.stringify(payload)).not.toContain('乙的私密合成历史');
      expect(JSON.stringify(payload)).not.toContain('另一用户的私密合成历史');
      const output = replyTransport.results.at(-1)!.data;
      expect((await rewriteBackend.request(`/api/contacts/${contact}/replies/${output.reply_request_id}/evidence`)).status).toBe(200);
      expect((await rewriteBackend.request(savedReplyPath(contact, output), replyTransport.requests.at(-1)!)).data).toEqual(output);
      const calls = (observed.model_calls as number) - modelCalls;
      expect(calls).toBe(1); modelCalls += calls;
      expect((await rewriteBackend.command('observations', { latest: true })).model_calls).toBe(modelCalls);
      rows.push({ case_id: testCase.case_id, owner_id: rewriteBackend.data.owner_id, contact_id: contact,
        payload, system_prompt: (observed.outbound as string[]).find((text) => text.includes('条件性建议') && text.includes('## Reply Skills')),
        output, latency_ms: latencyMs, call_count: calls });
    }
  });
  await writeFile('artifacts/headless-pages/fidelity-content-observations.json', JSON.stringify({
    data_kind: 'synthetic', data_version: 'content-public-v1', entry_point: 'page', rows,
  }, null, 2) + '\n', { mode: 0o600 });
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
    await rewriteBackend.command('fidelity_history');
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await setWorkspaceContext(helper, true);
    await helper.getByRole('checkbox', { name: /合成当前邀请/ }).check();
    await expect(helper.getByRole('checkbox', { name: /合成当前邀请/ })).toBeChecked();
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今天不参加聚会。');
    for (const output of [{ text: '' }, { text: '今天不参加聚会。', citation_ids: [crypto.randomUUID()] }]) {
      await rewriteBackend.plan({ count: 1, basis: '合成无效输出。', ...output });
      const count = replyTransport.results.length;
      await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
      await expect.poll(() => replyTransport.results.length).toBe(count + 1);
      await expect(helper.getByRole('alert')).toBeVisible();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      expect(replyTransport.results.at(-1)?.status).not.toBe(200);
    }
    await rewriteBackend.plan({ count: 1, text: '今天不参加聚会。' });
    await rewriteBackend.command('hold');
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    try {
      await expect.poll(async () => (await rewriteBackend.command('observations')).model_entered).toBe(true);
      await rewriteBackend.command('withdraw_target_source');
    } finally { await rewriteBackend.command('release'); }
    await expect.poll(() => replyTransport.results.length).toBe(3);
    await expect(helper.getByRole('alert')).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    expect(replyTransport.results.at(-1)?.status).not.toBe(200);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
  });
}
