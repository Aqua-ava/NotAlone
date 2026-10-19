import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { fillWorkspaceThought, setWorkspaceContext, fillWorkspaceInstruction, generateWorkspace } from '../workspace-actions';
import { withRewritePages } from './rewrite-acceptance';
import { PageHost } from './page-host';
import type { RewriteFixture } from '../rewrite-backend-fixture';
import type { RewritePages } from '../rewrite-page-scenarios';

async function openWorkspace({ manager, helper, rewriteBackend }: RewritePages) {
  const contactId = rewriteBackend.data.contact_ids[0];
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, contactId);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toBeEditable();
  return contactId;
}
async function deleteContextSource(manager: Page, fixture: RewriteFixture, sourceId: string) {
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
    .find(item => item.source_id === sourceId)!;
  expect(deleted.status).toBe('deleted');
  expect((await fixture.request(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`)).data.status).toBe('succeeded');
}

// 先探索确认及探索TTL已经退役；仍覆盖幂等、重启、隔离、迟到结果和来源删除的真实公开链路。
export async function understandingDirection(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: workspace-input-continuity-and-replay\n');
  await withRewritePages(browser, origin, async (pages, host, userData) => {
    const { helper, rewriteBackend, replyTransport } = pages;
    const contactId = await openWorkspace(pages);
    await setWorkspaceContext(helper, true);
    await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true }).fill('对方：今晚会晚一点回复，不是在邀请见面。');
    await fillWorkspaceInstruction(helper, '只提供思路，不增加承诺。');
    await rewriteBackend.plan({ count: 1, prefix: '尚未采纳的等待建议' });
    replyTransport.nextReply = 'drop';
    await generateWorkspace(helper, 'suggest');
    await expect(helper.getByRole('button', { name: '重试同一次生成', exact: true })).toBeEnabled();
    const original = replyTransport.requests.at(-1)!;
    const generated = replyTransport.results.at(-1)!;
    expect(generated.status).toBe(200);
    await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('尚未采纳的等待建议（说法1）。');
    expect(replyTransport.requests.at(-1)).toEqual(original);
    expect(replyTransport.results.at(-1)).toEqual(generated);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    const turn = generated.data;
    const path = `/api/contacts/${contactId}/assistant-sessions/${turn.session_id}/replies`;
    const evidence = await rewriteBackend.request(`/api/contacts/${contactId}/replies/${turn.reply_request_id}/evidence`);
    expect(evidence.status).toBe(200);
    expect(JSON.stringify(evidence.data)).not.toContain('乙的私密合成历史');
    expect(JSON.stringify(evidence.data)).not.toContain('另一用户的私密合成历史');
    const history = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${turn.session_id}`);
    expect(history.status).toBe(200);
    const recorded = (history.data.turns as Array<{ turn_id: string; state: string; request_key: string;
      input: { content: Record<string, unknown> } }>).find(item => item.turn_id === turn.turn_id)!;
    expect(recorded).toMatchObject({ state: 'completed', request_key: original.idempotency_key,
      input: { content: { input_kind: 'workspace', workspace_action: 'suggest', draft_text: '',
        context_text: '对方：今晚会晚一点回复，不是在邀请见面。' } } });
    const replay = await rewriteBackend.request(path, original);
    expect(replay).toEqual(generated);
    expect((await rewriteBackend.request(path, { ...original,
      content: { ...(original.content as object), context_text: '同一键不能改成另一份背景。' } })).status).toBe(409);
    await fillWorkspaceThought(helper, '我想直接说明今晚不再等了。');
    await fillWorkspaceInstruction(helper, '只说明本次决定，不安排后续。');
    await rewriteBackend.plan({ count: 1, prefix: '新的本人明确意愿' });
    await generateWorkspace(helper);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('新的本人明确意愿（说法1）。');
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ fidelity_contract: { current_intent: null } });
    expect(payloads[1]).toMatchObject({ fidelity_contract: { current_intent: { text: '我想直接说明今晚不再等了。' } } });
    expect(replyTransport.explorationRequests).toHaveLength(0);
    // 新输入不改变旧完成结果的幂等身份，后端重启后仍可恢复。
    expect(await rewriteBackend.request(path, original)).toEqual(replay);
    await host.close();
    await rewriteBackend.command('restart');
    const restarted = new PageHost(await browser.newContext(), origin, userData);
    try {
      await restarted.backend.connect();
      expect(await rewriteBackend.request(path, original)).toEqual(replay);
    } finally { await restarted.close(); }
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  });

  process.stdout.write('page_test_scenario: workspace-scope-and-unconfirmed-material\n');
  await withRewritePages(browser, origin, async pages => {
    const { helper, rewriteBackend, replyTransport } = pages;
    const pending = await rewriteBackend.command('strategy_pending');
    const contactId = await openWorkspace(pages);
    // 待确认资料仍需达到正式相关性阈值；本场用相关困惑触发检索，不要求无关资料无条件入选。
    await fillWorkspaceThought(helper, '对方可能正在忙，我该怎么关心近况？');
    await rewriteBackend.plan({ count: 1, prefix: '仅供选择的思路', cite_pending: true,
      basis: '未确认近况仅作参考，不当成当前事实。' });
    await generateWorkspace(helper, 'suggest');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('仅供选择的思路（说法1）。');
    const generated = replyTransport.results.at(-1)!.data;
    const evidence = await rewriteBackend.request(`/api/contacts/${contactId}/replies/${generated.reply_request_id}/evidence`);
    expect(evidence.status).toBe(200);
    expect(evidence.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
      evidence_id: pending.candidate_id, kind: 'pending_candidate', snapshot_status: 'pending' })]));
    for (const wrongContact of [rewriteBackend.data.contact_ids[1], rewriteBackend.data.other_contact_id]) {
      const wrongEvidence = await rewriteBackend.request(`/api/contacts/${wrongContact}/replies/${generated.reply_request_id}/evidence`);
      expect(wrongEvidence.status).toBe(404);
      const wrongGeneration = await rewriteBackend.request(`/api/contacts/${wrongContact}/assistant-sessions/${generated.session_id}/replies`,
        { ...replyTransport.requests.at(-1), contact_id: wrongContact, idempotency_key: randomUUID() });
      expect(wrongGeneration.status).toBeGreaterThanOrEqual(400);
      expect(wrongGeneration.status).toBeLessThan(500);
    }
    const invalid = await rewriteBackend.request('/api/reply/generate', { contact_id: contactId, idempotency_key: randomUUID(),
      content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express', draft_text: '', include_relationship_context: true } });
    expect(invalid.status).toBe(400);
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ input_mode: 'workspace', workspace_action: 'suggest',
      fidelity_contract: { current_intent: null } });
    const ledger = await rewriteBackend.request('/api/ledger/summary');
    expect(ledger.status).toBe(200);
    expect(JSON.stringify(ledger.data)).not.toContain('甲的私密合成历史');
  });

  process.stdout.write('page_test_scenario: workspace-late-result-contact-isolation\n');
  await withRewritePages(browser, origin, async pages => {
    const { manager, helper, rewriteBackend, replyTransport } = pages;
    await openWorkspace(pages);
    await rewriteBackend.plan({ count: 1, prefix: '甲的迟到建议' });
    replyTransport.nextReply = 'hold';
    await generateWorkspace(helper, 'suggest');
    await expect.poll(() => replyTransport.heldCount).toBe(1);
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[1]);
    try {
      await fillWorkspaceThought(helper, '乙的独立想法。');
    } catch (error) {
      const state = await helper.evaluate(async () => {
        const reply = await window.notalone.replies.getState();
        const contacts = await window.notalone.contacts.getState();
        return { contactMatchesSelection: reply.contactId === contacts.selectedContactId,
          phase: reply.phase, savedPhase: reply.savedSession?.phase, mode: reply.mode,
          inputKind: reply.options.inputKind, generationBlock: reply.generationBlock,
          sourceAvailability: reply.sourceAvailability ?? null, sessionDeletion: reply.sessionDeletion ?? null,
          catalogPhase: reply.sessionCatalog?.phase, selectionPending: reply.sessionCatalog?.selectionPending,
          jobs: reply.generationJobs?.map(job => ({ phase: job.phase, belongsToCurrentContact: job.contactId === reply.contactId })) };
      });
      process.stderr.write(`page_test_workspace_late_result_input: ${JSON.stringify({ ...state,
        heldResponses: replyTransport.heldCount })}\n`);
      throw error;
    }
    const requestKey = replyTransport.requests[0].idempotency_key as string;
    replyTransport.release();
    await expect.poll(() => helper.evaluate(async key => (await window.notalone.replies.getState()).generationJobs
      ?.find(job => job.requestKey === key)?.phase, requestKey)).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('乙的独立想法。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByText('甲的迟到建议（说法1）。', { exact: true })).toHaveCount(0);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  });

  process.stdout.write('page_test_scenario: workspace-invalid-candidate-and-failure\n');
  for (const plan of [{ count: 1, citation_ids: [randomUUID()] }, { count: 0 }, { fault: 'failure' as const }]) {
    await withRewritePages(browser, origin, async pages => {
      const { helper, rewriteBackend, replyTransport } = pages;
      await openWorkspace(pages);
      await rewriteBackend.plan(plan);
      await generateWorkspace(helper, 'suggest');
      await expect.poll(() => replyTransport.results.length).toBe(1);
      expect(replyTransport.results[0].status).toBeGreaterThanOrEqual(400);
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      await expect(helper.getByRole('alert').filter({ hasText: /生成|候选/ }).first()).toBeVisible();
      expect(replyTransport.explorationRequests).toHaveLength(0);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
    });
  }

  process.stdout.write('page_test_scenario: workspace-continuation-source-deletion\n');
  await withRewritePages(browser, origin, async pages => {
    const { manager, helper, rewriteBackend, replyTransport } = pages;
    const contactId = await openWorkspace(pages);
    await fillWorkspaceInstruction(helper, '简短一点');
    await rewriteBackend.plan({ count: 1, prefix: '合成来源派生隐私标记' });
    await generateWorkspace(helper, 'suggest');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('合成来源派生隐私标记（说法1）。');
    const generated = replyTransport.results.at(-1)!.data;
    const evidencePath = `/api/contacts/${contactId}/replies/${generated.reply_request_id}/evidence`;
    const evidence = await rewriteBackend.request(evidencePath);
    expect(evidence.status).toBe(200);
    expect(evidence.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message', text: expect.stringContaining('甲的私密合成历史') })]));
    // 此独立夹具的甲只有一条来源；从正式来源列表取得删除身份。
    const sources = await rewriteBackend.request(`/api/contacts/${contactId}/sources`);
    expect(sources.status).toBe(200);
    expect(sources.data.sources).toHaveLength(1);
    const sourceId = (sources.data.sources as Array<{ source_id: string }>)[0].source_id;
    const continuation = helper.getByRole('region', { name: '连续修改', exact: true });
    await expect(continuation).toBeVisible();
    await continuation.getByRole('textbox', { name: '继续修改要求', exact: true }).fill('第一条简短一点');
    await rewriteBackend.plan({ count: 1, prefix: '合成来源派生隐私标记的继续修改' });
    await continuation.getByRole('button', { name: '继续修改', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('合成来源派生隐私标记的继续修改（说法1）。');
    await deleteContextSource(manager, rewriteBackend, sourceId);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByText('合成来源派生隐私标记', { exact: false })).toHaveCount(0);
    expect((await rewriteBackend.request(evidencePath)).status).toBe(404);
    const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}`);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.data)).not.toContain('合成来源派生隐私标记');
    const replay = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}/replies`, replyTransport.requests[0]);
    expect(replay.status).toBe(409);
    expect(await rewriteBackend.command('reply_privacy_counts')).toEqual({ total: 0, sensitive: 0, failed: 0 });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
  });

  process.stdout.write('page_test_scenario: workspace-retained-history-dependency-deletion\n');
  await withRewritePages(browser, origin, async pages => {
    const { manager, helper, rewriteBackend, replyTransport } = pages;
    const dependency = await rewriteBackend.command('direction_dependency');
    const contactId = await openWorkspace(pages);
    await fillWorkspaceInstruction(helper, '简短一点');
    // 从近期窗口以外检索并引用独立来源，后续不再次检索仍须保留删除依赖。
    await rewriteBackend.command('plan', { plan: { count: 1, prefix: '参考历史后的合成建议',
      probe_history: true, probe_query: '合成相邻来源隐私标记' } });
    await generateWorkspace(helper, 'suggest');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('参考历史后的合成建议（说法1）。');
    const generated = replyTransport.results.at(-1)!.data;
    const evidencePath = `/api/contacts/${contactId}/replies/${generated.reply_request_id}/evidence`;
    const evidence = await rewriteBackend.request(evidencePath);
    expect(evidence.status).toBe(200);
    expect(JSON.stringify(evidence.data)).toContain('合成相邻来源隐私标记');
    await rewriteBackend.command('shift_direction_dependency', { target_source: dependency.target_source });
    const continuation = helper.getByRole('region', { name: '连续修改', exact: true });
    await continuation.getByRole('textbox', { name: '继续修改要求', exact: true }).fill('第一条简短一点');
    await rewriteBackend.plan({ count: 1, prefix: '继续修改保留历史依赖' });
    await continuation.getByRole('button', { name: '继续修改', exact: true }).click();
    try {
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('继续修改保留历史依赖（说法1）。');
    } catch (error) {
      const diagnostics = await Promise.allSettled([
        helper.evaluate(async () => {
          const state = await window.notalone.replies.getState();
          return { phase: state.phase, errorCode: state.errorCode ?? null,
            continuationPhase: state.continuation?.phase ?? null,
            clarificationReason: state.continuation?.clarification?.reason ?? null,
            sourceAvailability: state.sourceAvailability ?? null, savedPhase: state.savedSession?.phase,
            candidateVersionPhase: state.candidateVersions?.phase,
            jobs: state.generationJobs?.map(job => job.phase) };
        }),
        rewriteBackend.command('observations').then(value => ({ modelCalls: value.model_calls,
          payloadCount: Array.isArray(value.payloads) ? value.payloads.length : null })),
        rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}`)
          .then(value => ({ status: value.status, turns: Array.isArray(value.data.turns)
            ? value.data.turns.map(turn => ({ state: turn.state, hasReply: Boolean(turn.reply) })) : null })),
      ]);
      process.stderr.write(`page_test_retained_history_continuation: ${JSON.stringify(diagnostics.map((item, index) =>
        item.status === 'fulfilled' ? { source: ['ui', 'model', 'saved'][index], value: item.value }
          : { source: ['ui', 'model', 'saved'][index], unavailable: true }))}\n`);
      throw error;
    }
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<{ evidence: Array<{ kind: string; text: string }> }>;
    expect(payloads).toHaveLength(3);
    expect(payloads.at(-1)!.evidence.filter(item => item.kind === 'message').map(item => item.text))
      .not.toContain('合成相邻来源隐私标记');
    await deleteContextSource(manager, rewriteBackend, dependency.adjacent_source as string);
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    expect((await rewriteBackend.request(evidencePath)).status).toBe(404);
    const saved = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}`);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.data)).not.toContain('继续修改保留历史依赖');
    expect((await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${generated.session_id}/replies`, replyTransport.requests[0])).status).toBe(409);
    expect(await rewriteBackend.command('reply_privacy_counts')).toEqual({ total: 0, sensitive: 0, failed: 0 });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
  });

}
