import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

// 方向选择已退役：直接给建议，用户也可自行提出想法后表达。
export async function replyStrategyOptions(browser: Browser, origin: string) {
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }, host) => {
    process.stdout.write('page_test_scenario: 工作区空输入建议、换组与自行表达\n');
    const contactId = rewriteBackend.data.contact_ids[0];
    await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
    await confirmHelperContact(helper, contactId);
    const idea = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
    // 再次生成可能经已保存讨论恢复候选；消息组身份不依赖即时/恢复状态的编辑框名称。
    const candidate = (number: number) => helper.getByRole('group', { name: `说法${number}消息组`, exact: true }).getByRole('textbox');
    const verifyGeneration = async (check: () => Promise<void>) => {
      try { await check(); }
      catch (error) {
        // 先保留公开请求与页面阶段，再由夹具清理；区分尚未完成、请求失败和渲染问题。
        const state = await helper.evaluate(() => window.notalone.replies.getState());
        const observation = await rewriteBackend.command('observations');
        const payloads = observation.payloads as Array<Record<string, unknown>>;
        process.stderr.write(`page_test_generation_state: ${JSON.stringify({ phase: state.phase,
          error: state.errorCode, saved: state.savedSession?.phase, catalog: state.sessionCatalog?.phase,
          selectionPending: state.sessionCatalog?.selectionPending, source: state.sourceAvailability,
          candidates: state.result?.candidates.length ?? 0, versions: state.candidateVersions?.phase,
          candidateVersions: state.candidateVersions?.items.map(item => ({ phase: item.phase,
            versionCount: item.history?.versions.length ?? 0 })),
          requests: replyTransport.requests.map(item => {
            const content = item.content as Record<string, unknown>;
            return { inputKind: content.input_kind, action: content.workspace_action };
          }),
          preparations: replyTransport.replyPreparations,
          responses: replyTransport.results.map(item => ({ status: item.status, error: item.data.error,
            reason: item.data.reason, candidates: Array.isArray(item.data.candidates) ? item.data.candidates.length : 0 })),
          modelCalls: payloads.length, inputModes: payloads.map(item => item.input_mode) })}\n`);
        throw error;
      }
    };
    const generateAndWait = async (action: '帮我想想' | '帮我表达', check: () => Promise<void>) => {
      await verifyGeneration(async () => {
        const before = await helper.evaluate(() => window.notalone.replies.getState());
        expect(['idle', 'ready']).toContain(before.phase);
        expect(before.errorCode).toBeUndefined();
        expect(before.savedSession?.phase).toBe('ready');
        const scope = { contactId, scopeRevision: before.scopeRevision, sessionId: before.savedSession!.sessionId,
          previousReplyId: before.result?.replyRequestId ?? null };
        await helper.getByRole('button', { name: action, exact: true }).click();
        // 先确认本次生成已启动，避免只等到工作区前置的 updateOptions 命令。
        await expect.poll(() => helper.evaluate(async captured => {
          const state = await window.notalone.replies.getState();
          return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
            && state.savedSession?.sessionId === captured.sessionId
            && (state.phase === 'waiting' || state.phase === 'failed'
              || Boolean(state.result && state.result.replyRequestId !== captured.previousReplyId));
        }, scope)).toBe(true);
        await host.awaitPendingCommands();
        const generated = await helper.evaluate(() => window.notalone.replies.getState());
        expect(generated.phase).toBe('ready');
        expect(generated.errorCode).toBeUndefined();
        expect(generated.result).not.toBeNull();
        expect(generated.result!.replyRequestId).not.toBe(scope.previousReplyId);
        const inputVersionId = generated.result!.inputVersionId;
        const replyRequestId = generated.result!.replyRequestId;
        // generate 已含当前候选版本恢复；若自动读取完整讨论仍在进行，再等该公开命令收尾。
        if (generated.savedSession?.phase !== 'ready' || generated.candidateVersions?.phase !== 'ready') {
          await expect.poll(() => helper.evaluate(async captured => {
            const state = await window.notalone.replies.getState();
            return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
              && state.savedSession?.sessionId === captured.sessionId
              && state.result?.replyRequestId === captured.replyRequestId
              && (state.savedSession.phase === 'loading' || state.savedSession.phase === 'ready'
                && state.savedSession.currentInputVersionId === captured.inputVersionId
                && state.savedSession.turns.some(turn => turn.inputVersionId === captured.inputVersionId
                  && turn.reply?.replyRequestId === captured.replyRequestId));
          }, { ...scope, inputVersionId, replyRequestId })).toBe(true);
          await host.awaitPendingCommands();
        }
        const completed = await helper.evaluate(() => window.notalone.replies.getState());
        expect({ contactId: completed.contactId, scopeRevision: completed.scopeRevision,
          sessionId: completed.savedSession?.sessionId }).toEqual({ contactId, scopeRevision: scope.scopeRevision,
          sessionId: scope.sessionId });
        expect(completed.phase).toBe('ready');
        expect(completed.result?.replyRequestId).toBe(generated.result!.replyRequestId);
        expect(completed.savedSession).toMatchObject({ phase: 'ready', currentInputVersionId: inputVersionId });
        const turn = completed.savedSession!.turns.find(item => item.inputVersionId === inputVersionId);
        expect(turn).toMatchObject({ state: 'completed', reply: { replyRequestId } });
        expect(completed.generationJobs?.find(job => job.turnId === turn!.turnId)).toMatchObject({
          contactId, sessionId: scope.sessionId, inputVersionId, requestKey: turn!.requestKey, phase: 'completed' });
        expect(completed.candidateVersions?.phase).toBe('ready');
        await check();
      });
    };
    await expect(idea).toHaveValue('');
    await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    await rewriteBackend.plan({ count: 3, prefix: '尚未采纳的合成思路', basis: '根据最近聊天提出可选说法，尚未代表用户立场。' });
    await generateAndWait('帮我想想', () => expect(candidate(3)).toHaveValue('尚未采纳的合成思路（说法3）。'));
    await expect(helper.getByText('根据最近聊天提出可选说法，尚未代表用户立场。', { exact: true })).toHaveCount(3);
    await expect(helper.getByText('根据最近聊天提出可选说法，尚未代表用户立场。', { exact: true }).first()).toBeVisible();
    await expect(idea).toHaveValue('');
    expect(replyTransport.explorationRequests).toHaveLength(0);
    const first = replyTransport.requests[0];
    expect(first).toMatchObject({ content: { input_kind: 'workspace', workspace_action: 'suggest', draft_text: '' } });
    const firstPayloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(firstPayloads).toHaveLength(1);
    expect(firstPayloads[0]).toMatchObject({ input_mode: 'workspace', fidelity_contract: { current_intent: null } });
    await rewriteBackend.plan({ count: 2, prefix: '另一组可选说法' });
    await generateAndWait('帮我想想', async () => {
      await expect.poll(() => replyTransport.results.length).toBe(2);
      expect(replyTransport.results[1].status).toBe(200);
      await expect(candidate(2)).toHaveValue('另一组可选说法（说法2）。');
    });
    await expect(helper.getByRole('group', { name: '说法3消息组', exact: true })).toHaveCount(0);
    expect(replyTransport.requests.at(-1)?.idempotency_key).not.toBe(first.idempotency_key);
    // 不选择候选也能自行表达；建议不能自动填入本人想法。
    await expect(idea).toHaveValue('');
    await idea.fill('只说明本次收到了消息，不安排后续。');
    await rewriteBackend.plan({ count: 1, prefix: '我已收到，先到这里' });
    await generateAndWait('帮我表达', () => expect(candidate(1)).toHaveValue('我已收到，先到这里（说法1）。'));
    expect(replyTransport.requests.at(-1)).toMatchObject({ content: { input_kind: 'workspace', workspace_action: 'express',
      draft_text: '只说明本次收到了消息，不安排后续。' } });
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
    for (const name of ['回应消息', '主动聊聊', '帮我理清方向', '生成候选']) {
      await expect(helper.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
  });
}
