import { openImportManagement } from '../memory-page-actions';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';
import { PageHost } from './page-host';
import { fillWorkspaceThought, setWorkspaceContext, generateWorkspace } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import type { ReplySessionState } from '../../src/shared/reply-bridge';

// 只记录公开身份与阶段，不输出草稿、候选正文或检索材料。
function generationIdentity(state: ReplySessionState) {
  const saved = state.savedSession;
  const turn = saved?.turns.find(item => item.inputVersionId === saved.currentInputVersionId);
  return { revision: state.revision, phase: state.phase, errorCode: state.errorCode, canRetry: state.canRetry,
    contactId: state.contactId, scopeRevision: state.scopeRevision, generationBlock: state.generationBlock,
    sourceAvailability: state.sourceAvailability, contextEnabled: state.options.includeRelationshipContext,
    exclusions: state.options.excludedMessageIds?.length ?? 0, action: state.options.workspaceAction,
    resultRequestId: state.result?.replyRequestId, resultInputVersionId: state.result?.inputVersionId,
    resultCandidateIds: state.result?.candidates.map(item => item.original.candidateId),
    savedPhase: saved?.phase, sessionId: saved?.sessionId, currentInputVersionId: saved?.currentInputVersionId,
    currentTurn: turn && { turnId: turn.turnId, state: turn.state, requestKey: turn.requestKey,
      inputVersionId: turn.inputVersionId, replyRequestId: turn.reply?.replyRequestId },
    catalog: state.sessionCatalog && { phase: state.sessionCatalog.phase, selectionPending: state.sessionCatalog.selectionPending },
    versionPhase: state.candidateVersions?.phase,
    versions: state.candidateVersions?.items.map(item => ({ candidateId: item.candidateId,
      phase: item.phase, displayVersionId: item.displayVersionId, historyTurnId: item.history?.turnId })),
    jobs: state.generationJobs?.map(job => ({ requestKey: job.requestKey, inputVersionId: job.inputVersionId,
      turnId: job.turnId, phase: job.phase })),
  };
}

async function confirmedTarget(pages: RewritePages) {
  const { helper, replyTransport, rewriteBackend } = pages;
  await prepareReply(pages, '甲', '  ');
  await expect(helper.getByRole('radio')).toHaveCount(0);
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeEnabled();
  expect(replyTransport.requests).toEqual([]);
  await fillWorkspaceThought(helper, '说明今晚晚点回复，不增加承诺。');
  await rewriteBackend.plan({ count: 2, prefix: '我忙完再回复你' });
  await generateWorkspace(helper);
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('我忙完再回复你（说法1）。');
  expect(replyTransport.requests).toHaveLength(1);
  expect(replyTransport.requests[0]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0], content: {
    type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express',
    draft_text: '说明今晚晚点回复，不增加承诺。', include_relationship_context: true,
  } });
  const payload = ((await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>)[0];
  expect(payload).toMatchObject({ workspace_action: 'express',
    fidelity_contract: { current_intent: { text: '说明今晚晚点回复，不增加承诺。' } } });
  expect(JSON.stringify(payload)).not.toContain('乙的私密合成历史');
  expect(JSON.stringify(payload)).not.toContain('另一用户的私密合成历史');
  await editor.fill('我晚上忙完再回复。');
  await editor.blur();
  await expect(helper.getByText('修改版本 1', { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '查看说法1上一版', exact: true }).click();
  await expect(editor).toHaveValue('我忙完再回复你（说法1）。');
  await helper.getByRole('button', { name: '查看说法1下一版', exact: true }).click();
  await expect(editor).toHaveValue('我晚上忙完再回复。');
  const result = await helper.evaluate(() => window.notalone.replies.getState());
  expect(result.result?.input).toMatchObject({ draftText: '说明今晚晚点回复，不增加承诺。' });
  await helper.screenshot({ path: 'artifacts/headless-pages/directed-reply-candidates.png' });
}

async function messagePages(pages: RewritePages) {
  const { helper, replyTransport, rewriteBackend } = pages;
  await rewriteBackend.command('older_messages');
  await prepareReply(pages, '甲', '说明最近的安排。');
  const messages = helper.getByRole('group', { name: '最近聊天材料', exact: true });
  await expect(messages.getByRole('checkbox')).toHaveCount(20);
  await expect(messages.getByRole('checkbox', { checked: true })).toHaveCount(20);
  await expect(messages).not.toContainText('乙的私密合成历史');
  await expect(messages).not.toContainText('另一用户的私密合成历史');
  const path = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/messages?limit=20`;
  const first = await rewriteBackend.request(path);
  const before = first.data.next_cursor as string;
  expect(before).toMatch(/^[a-f0-9-]{36}$/);
  // 工作区不要求挑选一条目标消息；保留公开消息接口的游标分页和排除边界。
  await helper.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.replies.loadMessages({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, older: true });
  });
  await expect(messages.getByRole('checkbox')).toHaveCount(22);
  expect(replyTransport.messageRequests).toContain(`${path}&before=${before}`);
  const last = await rewriteBackend.request(`${path}&before=${before}`);
  const all = [...first.data.messages as Array<{ message_id: string }>, ...last.data.messages as Array<{ message_id: string; text: string }>];
  expect(new Set(all.map(item => item.message_id)).size).toBe(22);
  const excluded = (last.data.messages as Array<{ message_id: string; text: string }>).find(item => item.text === '甲的较早合成消息 21')!;
  expect(excluded).toBeDefined();
  await messages.getByRole('checkbox', { name: /甲的较早合成消息 21/ }).uncheck();
  await rewriteBackend.plan({ count: 1, prefix: '排除较早消息后的表达' });
  await generateWorkspace(helper);
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('排除较早消息后的表达（说法1）。');
  expect(replyTransport.requests[0]).toMatchObject({ content: { excluded_message_ids: [excluded.message_id] } });
  const payload = ((await rewriteBackend.command('observations')).payloads as Array<{ evidence: Array<{ text: string }> }>)[0];
  expect(payload.evidence.map(item => item.text)).not.toContain(excluded.text);
}

async function unavailableTarget(pages: RewritePages) {
  const { manager, helper, replyTransport, rewriteBackend } = pages;
  await prepareReply(pages, '甲', '说明现在的安排。');
  await rewriteBackend.plan({ count: 1, prefix: '来源撤销前的表达' });
  await generateWorkspace(helper);
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('来源撤销前的表达（说法1）。');
  const original = replyTransport.requests[0];
  const result = replyTransport.results[0].data;
  const path = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${result.session_id}/replies`;
  const evidencePath = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/replies/${result.reply_request_id}/evidence`;
  expect((await rewriteBackend.request(evidencePath)).status).toBe(200);
  const sources = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/sources`);
  const sourceId = (sources.data.sources as Array<{ source_id: string }>)[0].source_id;
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${sourceId}"]`);
  await source.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  expect((await rewriteBackend.request(path, original)).status).toBe(409);
  expect((await rewriteBackend.request(evidencePath)).status).toBe(404);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  await helper.getByRole('button', { name: '刷新最近聊天', exact: true }).click();
  await expect(helper.getByText('暂无可用的最近聊天。可以补充上下文，或先写下想法。', { exact: true })).toBeVisible();
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '新开助手会话', exact: true }).click();
  // 点击后仍可能短暂显示旧工作区；必须等新会话的清空和恢复完成再输入。
  await expect.poll(() => helper.evaluate(async previousSessionId => {
    const state = await window.notalone.replies.getState();
    return Boolean(state.savedSession?.sessionId && state.savedSession.sessionId !== previousSessionId
      && state.savedSession.phase === 'ready' && !state.sessionCatalog?.selectionPending
      && state.mode === 'rewrite_draft' && state.options.inputKind === 'workspace');
  }, result.session_id)).toBe(true);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
  await fillWorkspaceThought(helper, '我会稍晚再回复。');
  await setWorkspaceContext(helper, false);
  await rewriteBackend.plan({ count: 1, prefix: '只据本人想法表达' });
  await generateWorkspace(helper);
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('只据本人想法表达（说法1）。');
  expect(replyTransport.requests.at(-1)).toMatchObject({ content: { input_kind: 'workspace', include_relationship_context: false } });
  const payloads = (await rewriteBackend.command('observations')).payloads as unknown[];
  expect(payloads).toHaveLength(2);
  expect(JSON.stringify(payloads.at(-1))).not.toContain('甲的私密合成历史');
}

async function inputIdentity(pages: RewritePages, host: PageHost) {
  const { helper, replyTransport, rewriteBackend } = pages;
  const generateAndWait = async (action: 'express' | 'suggest', retryTimeout = false) => {
    const before = await helper.evaluate(() => window.notalone.replies.getState());
    if (retryTimeout) expect(before).toMatchObject({ phase: 'failed', errorCode: 'timeout', canRetry: true });
    else {
      expect(['idle', 'ready']).toContain(before.phase);
      expect(before.errorCode).toBeUndefined();
    }
    expect(before.savedSession?.phase).toBe('ready');
    const scope = { contactId: before.contactId, scopeRevision: before.scopeRevision,
      sessionId: before.savedSession!.sessionId, previousReplyId: before.result?.replyRequestId ?? null };
    if (retryTimeout) await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
    else await generateWorkspace(helper, action);
    // 先确认生成已启动，再等公开命令；不能只等到前置 updateOptions 完成。
    await expect.poll(() => helper.evaluate(async captured => {
      const state = await window.notalone.replies.getState();
      return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
        && state.savedSession?.sessionId === captured.sessionId
        && state.revision > captured.revision
        && (state.phase === 'waiting' || state.phase === 'failed'
          || Boolean(state.result && state.result.replyRequestId !== captured.previousReplyId));
    }, { ...scope, revision: before.revision })).toBe(true);
    await host.awaitPendingCommands();
    const generated = await helper.evaluate(() => window.notalone.replies.getState());
    expect(generated.phase).toBe('ready');
    expect(generated.errorCode).toBeUndefined();
    expect(generated.result).not.toBeNull();
    expect(generated.result!.replyRequestId).not.toBe(scope.previousReplyId);
    const inputVersionId = generated.result!.inputVersionId;
    const replyRequestId = generated.result!.replyRequestId;
    // 完成后自动重读历史可能仍在途；沿用真实读取预算，再核对同一结果与版本。
    if (generated.savedSession?.phase !== 'ready' || generated.candidateVersions?.phase !== 'ready') {
      await expect.poll(() => helper.evaluate(async captured => {
        const state = await window.notalone.replies.getState();
        return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
          && state.savedSession?.sessionId === captured.sessionId && state.result?.replyRequestId === captured.replyRequestId
          && (state.savedSession.phase === 'loading' || state.savedSession.phase === 'ready'
            && state.savedSession.currentInputVersionId === captured.inputVersionId
            && state.savedSession.turns.some(turn => turn.inputVersionId === captured.inputVersionId
              && turn.reply?.replyRequestId === captured.replyRequestId));
      }, { ...scope, inputVersionId, replyRequestId })).toBe(true);
      await host.awaitPendingCommands();
    }
    const completed = await helper.evaluate(() => window.notalone.replies.getState());
    expect({ contactId: completed.contactId, scopeRevision: completed.scopeRevision, sessionId: completed.savedSession?.sessionId })
      .toEqual({ contactId: scope.contactId, scopeRevision: scope.scopeRevision, sessionId: scope.sessionId });
    expect(completed.phase).toBe('ready');
    expect(completed.result?.replyRequestId).toBe(replyRequestId);
    expect(completed.savedSession).toMatchObject({ phase: 'ready', currentInputVersionId: inputVersionId });
    const turn = completed.savedSession!.turns.find(item => item.inputVersionId === inputVersionId);
    expect(turn).toMatchObject({ state: 'completed', reply: { replyRequestId } });
    expect(completed.generationJobs?.find(job => job.turnId === turn!.turnId)).toMatchObject({
      contactId: scope.contactId, sessionId: scope.sessionId, inputVersionId, requestKey: turn!.requestKey, phase: 'completed' });
    expect(completed.candidateVersions?.phase).toBe('ready');
  };
  await rewriteBackend.command('older_messages');
  await prepareReply(pages, '甲', '第一版明确想法。');
  await rewriteBackend.plan({ count: 1, prefix: '第一版回复' });
  replyTransport.nextReply = 'drop';
  await generateWorkspace(helper);
  await expect(helper.getByRole('alert')).toContainText('未收到生成结果');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('第一版回复（说法1）。');
  const original = replyTransport.requests[0];
  const result = replyTransport.results[0];
  expect(replyTransport.requests[1]).toEqual(original);
  expect(replyTransport.results[1]).toEqual(result);
  await editor.fill('保留我的编辑。');
  await editor.blur();
  await expect(helper.getByText('修改版本 1', { exact: true })).toBeVisible();
  expect(await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${result.data.session_id}/replies`, original)).toEqual(result);
  await expect(editor).toHaveValue('保留我的编辑。');
  let previousKey = original.idempotency_key;
  let capture: ((state: ReplySessionState) => void) | undefined;
  await helper.exposeFunction('recordDirectedState', (state: ReplySessionState) => capture?.(state));
  await helper.evaluate(() => {
    const diagnostic = window as typeof window & {
      recordDirectedState: (state: ReplySessionState) => Promise<void>;
    };
    window.notalone.replies.onStateChanged(state => { void diagnostic.recordDirectedState(state); });
  });
  for (const change of ['想法', '排除', '背景', '建议'] as const) {
    const started = Date.now();
    const trace = [{ elapsedMs: 0, ...generationIdentity(await helper.evaluate(() => window.notalone.replies.getState())) }];
    capture = state => {
      trace.push({ elapsedMs: Date.now() - started, ...generationIdentity(state) });
      if (trace.length > 32) trace.shift();
    };
    try {
      if (change === '想法') await fillWorkspaceThought(helper, '第二版明确想法。');
      if (change === '排除') await helper.getByRole('checkbox', { name: /甲的较早合成消息 01/ }).uncheck();
      if (change === '背景') await setWorkspaceContext(helper, false);
      const prefix = `${change}变更后的候选`;
      await rewriteBackend.plan({ count: 1, prefix });
      await generateAndWait(change === '建议' ? 'suggest' : 'express');
      await expect(editor).toHaveValue(`${prefix}（说法1）。`);
    } catch (error) {
      const state = await helper.evaluate(() => window.notalone.replies.getState());
      const response = replyTransport.results.at(-1);
      process.stdout.write(`page_test_directed_generation: ${JSON.stringify({ change,
        state: generationIdentity(state), trace,
        requestCount: replyTransport.requests.length,
        lastRequestKey: replyTransport.requests.at(-1)?.idempotency_key,
        lastResponse: response && { status: response.status, replyRequestId: response.data.reply_request_id,
          inputVersionId: response.data.input_version_id, turnId: response.data.turn_id,
          sessionId: response.data.session_id, state: response.data.state },
        modelCalls: (await rewriteBackend.command('observations')).model_calls,
      })}\n`);
      throw error;
    } finally { capture = undefined; }
    const current = replyTransport.requests.at(-1)!;
    expect(current.idempotency_key).not.toBe(previousKey);
    expect(current).toMatchObject({ content: { draft_text: '第二版明确想法。',
      workspace_action: change === '建议' ? 'suggest' : 'express' } });
    previousKey = current.idempotency_key;
  }
  const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
  expect(payloads.at(-1)).toMatchObject({ fidelity_contract: { current_intent: null } });
  await rewriteBackend.plan({ fault: 'timeout' });
  const beforeTimeout = await helper.evaluate(() => window.notalone.replies.getState());
  await generateWorkspace(helper, 'suggest');
  // 合成模型直接抛超时，但准备、失败落盘与终态复验仍属于公开生成命令。
  await expect.poll(() => helper.evaluate(async captured => {
    const state = await window.notalone.replies.getState();
    return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
      && state.savedSession?.sessionId === captured.sessionId && state.revision > captured.revision
      && (state.phase === 'waiting' || state.phase === 'failed');
  }, { contactId: beforeTimeout.contactId, scopeRevision: beforeTimeout.scopeRevision,
    sessionId: beforeTimeout.savedSession?.sessionId, revision: beforeTimeout.revision })).toBe(true);
  await host.awaitPendingCommands();
  expect(await helper.evaluate(() => window.notalone.replies.getState()))
    .toMatchObject({ phase: 'failed', errorCode: 'timeout', canRetry: true });
  await expect(helper.getByRole('alert')).toContainText('本次生成超时');
  const timedOut = replyTransport.requests.at(-1)!;
  expect(timedOut.idempotency_key).not.toBe(previousKey);
  expect(replyTransport.results.at(-1)).toEqual({ status: 504, data: { error: 'reply_timeout' } });
  await rewriteBackend.plan({ count: 1, prefix: '同键失败恢复' });
  await generateAndWait('suggest', true);
  await expect(editor).toHaveValue('同键失败恢复（说法1）。');
  expect(replyTransport.requests.at(-1)).toEqual(timedOut);
  expect((await rewriteBackend.command('observations')).payloads).toHaveLength(7);
}

async function emptyAndRejected(pages: RewritePages) {
  const { manager, helper, replyTransport, rewriteBackend } = pages;
  const expectManualInput = async (contactId: string) => {
    // 手动确认 HTTP 尚未收尾时，旧渠道确认按钮可能仍在；等待原操作，不再点击另一确认入口。
    await expect.poll(() => helper.evaluate(async () => {
      const contact = await window.notalone.contacts.getState();
      const foreground = await window.notalone.foreground.getState();
      const reply = await window.notalone.replies.getState();
      return { contactId: contact.selectedContactId, manualInput: foreground.manualInput,
        confirmation: foreground.confirmation, confirmedContactId: foreground.confirmedContactId,
        foregroundBlock: foreground.generationBlock, replyContactId: reply.contactId,
        scopeMatches: contact.scopeRevision === reply.scopeRevision, replyBlock: reply.generationBlock };
    })).toEqual({ contactId, manualInput: true, confirmation: 'manual-confirmed', confirmedContactId: contactId,
      foregroundBlock: null, replyContactId: contactId, scopeMatches: true, replyBlock: null });
  };
  await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '无消息的合成联系人' });
  await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue(rewriteBackend.data.empty_contact_id);
  await helper.getByRole('button', { name: '切换为手动输入', exact: true }).click();
  await expectManualInput(rewriteBackend.data.empty_contact_id);
  await setWorkspaceContext(helper, true);
  await expect(helper.getByText('暂无可用的最近聊天。可以补充上下文，或先写下想法。', { exact: true })).toBeVisible();
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeEnabled();
  expect(replyTransport.requests).toEqual([]);
  await helper.getByRole('button', { name: '恢复微信会话识别', exact: true }).click();
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.foreground.getState()).manualInput)).toBe(false);
  await prepareReply(pages, '甲', '明确说明现在的安排。');
  replyTransport.failMessages = true;
  await helper.getByRole('button', { name: '刷新最近聊天', exact: true }).click();
  await expect(helper.getByText('最近聊天暂时无法读取，可以刷新或补充聊天内容。', { exact: true })).toBeVisible();
  replyTransport.failMessages = false;
  await helper.getByRole('button', { name: '刷新最近聊天', exact: true }).click();
  await expect(helper.getByRole('checkbox', { name: /甲的私密合成历史/ })).toBeChecked();
  await rewriteBackend.command('revoke', { contact_id: rewriteBackend.data.contact_ids[0] });
  // 撤销微信绑定后，无手动联系人确认凭证的 HTTP 请求仍必须拒绝。
  const denied = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-session/default`, {});
  expect(denied).toEqual({ status: 409, data: { error: 'assistant_session_rejected', reason: 'no_active_binding' } });
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
  // 真实桌面显式确认的联系人可独立工作，不把微信绑定当作手动工作区的前提。
  await helper.getByRole('button', { name: '切换为手动输入', exact: true }).click();
  await expectManualInput(rewriteBackend.data.contact_ids[0]);
  await rewriteBackend.plan({ count: 1, prefix: '已手动确认联系人后的表达' });
  await generateWorkspace(helper);
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('已手动确认联系人后的表达（说法1）。');
}

async function prepareReply(pages: RewritePages, contact: '甲' | '乙', thought: string) {
  await pages.manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: `合成联系人${contact}` });
  await confirmHelperContact(pages.helper, pages.rewriteBackend.data.contact_ids[contact === '甲' ? 0 : 1]);
  await fillWorkspaceThought(pages.helper, thought);
  await setWorkspaceContext(pages.helper, true);
  await expect(pages.helper.getByRole('checkbox', { name: new RegExp(`${contact}的私密合成历史`) })).toBeChecked();
}
// 显式等待公开具名操作结束，不用截图时机或测试收尾掩盖迟到回填。
function pendingReply(pages: RewritePages) {
  return pages.helper.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.replies.generate({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, newRequest: true, workspaceAction: 'express' });
    return 'completed';
  });
}
async function staleMessages(pages: RewritePages, connection: boolean) {
  const { helper, manager, replyTransport } = pages;
  for (const failed of [false, true]) {
    await prepareReply(pages, '甲', '甲的旧方向。');
    replyTransport.failMessages = failed;
    replyTransport.nextMessages = 'hold';
    const heldBefore = replyTransport.heldCount;
    const pending = helper.evaluate(async () => {
      const state = await window.notalone.contacts.getState();
      await window.notalone.replies.loadMessages({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, older: false });
      return 'completed';
    });
    await expect(helper.getByRole('status').filter({ hasText: '正在读取最近聊天' })).toBeVisible();
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    replyTransport.failMessages = false;
    if (connection) {
      replyTransport.failRuntime = true;
      await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
      replyTransport.failRuntime = false;
      await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    }
    await prepareReply(pages, '乙', '乙的新方向。');
    replyTransport.release();
    expect(await pending).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('乙的新方向。');
    await expect(helper.getByRole('checkbox', { name: /乙的私密合成历史/ })).toBeChecked();
    await expect(helper.getByText('甲的私密合成历史：今晚我会晚一点回复你。', { exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
  }
}
async function staleGenerated(pages: RewritePages, connection: boolean) {
  const { helper, manager, replyTransport, rewriteBackend } = pages;
  for (const fault of [undefined, 'failure'] as const) {
    await prepareReply(pages, '甲', '甲的旧方向。');
    await rewriteBackend.plan({ count: 1, fault, prefix: '迟到的旧回复' });
    replyTransport.nextReply = 'hold';
    const heldBefore = replyTransport.heldCount;
    const pending = pendingReply(pages);
    await expect.poll(() => replyTransport.heldCount).toBe(heldBefore + 1);
    expect(replyTransport.results.at(-1)?.status).toBe(fault ? 500 : 200);
    if (connection) {
      replyTransport.failRuntime = true;
      await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
      replyTransport.failRuntime = false;
      await manager.getByRole('button', { name: '重试连接', exact: true }).click();
    }
    await prepareReply(pages, '乙', '乙的新方向。');
    replyTransport.release();
    expect(await pending).toBe('completed');
    await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('乙的新方向。');
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    await expect(helper.getByRole('alert')).toHaveCount(0);
    await expect(helper.getByText('迟到的旧回复（说法1）。', { exact: true })).toHaveCount(0);
  }
}

async function parameterGuards(pages: RewritePages) {
  const { helper, manager, rewriteBackend, replyTransport } = pages;
  await prepareReply(pages, '甲', '安全检查方向。');
  const otherMessages = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[1]}/messages`);
  const otherMessageId = (otherMessages.data.messages as Array<{ message_id: string }>)[0].message_id;
  const denied = await helper.evaluate(async ({ outside, other, otherMessageId }) => {
    const state = await window.notalone.contacts.getState();
    const scope = { contactId: state.selectedContactId!, scopeRevision: state.scopeRevision };
    const options = { tone: 'original', instruction: '', includeRelationshipContext: true, inputKind: 'workspace' };
    const invalid: Array<[string, 'enterWorkspace' | 'loadMessages' | 'updateOptions' | 'generate', unknown[]]> = [
      ['outside contact', 'enterWorkspace', [{ ...scope, contactId: other }]],
      ['outside owner', 'loadMessages', [{ ...scope, contactId: outside, older: false }]],
      ['stale scope', 'enterWorkspace', [{ ...scope, scopeRevision: scope.scopeRevision - 1 }]],
      ['owner field', 'loadMessages', [{ ...scope, ownerId: 'not-authorized', older: false }]],
      ['url field', 'loadMessages', [{ ...scope, url: 'https://invalid.example', older: false }]],
      ['cursor field', 'loadMessages', [{ ...scope, before: otherMessageId, older: true }]],
      ['invalid boolean', 'loadMessages', [{ ...scope, older: 'true' }]],
      ['invalid action', 'generate', [{ ...scope, newRequest: true, workspaceAction: 'send' }]],
      ['invalid exclusion', 'updateOptions', [{ ...scope, options: { ...options, excludedMessageIds: ['https://invalid.example'] } }]],
      ['oversized context', 'updateOptions', [{ ...scope, options: { ...options, contextText: 'x'.repeat(65537) } }]],
      ['oversized instruction', 'updateOptions', [{ ...scope, options: { ...options, instruction: 'x'.repeat(4097) } }]],
      ['extra argument', 'enterWorkspace', [scope, { ownerId: 'not-authorized' }]],
    ];
    const result: Record<string, boolean> = {};
    for (const [name, operation, args] of invalid) {
      try { await Reflect.apply(window.notalone.replies[operation], window.notalone.replies, args); result[name] = false; }
      catch { result[name] = true; }
    }
    return result;
  }, { outside: rewriteBackend.data.other_contact_id, other: rewriteBackend.data.contact_ids[1], otherMessageId });
  for (const [name, rejected] of Object.entries(denied)) expect(rejected, name).toBe(true);
  const selection = await helper.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    return { contactId: state.selectedContactId!, scopeRevision: state.scopeRevision };
  });
  expect(await manager.evaluate(async (scope) => {
    const operations = [() => window.notalone.replies.enterWorkspace(scope),
      () => window.notalone.replies.loadMessages({ ...scope, older: false }),
      () => window.notalone.replies.generate({ ...scope, newRequest: true, workspaceAction: 'suggest' })];
    return Promise.all(operations.map(async (operation) => { try { await operation(); return false; } catch { return true; } }));
  }, selection)).toEqual([true, true, true]);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('安全检查方向。');
  expect(replyTransport.requests).toEqual([]);
  expect((await rewriteBackend.command('observations')).payloads).toEqual([]);
}

async function newReplySession(pages: RewritePages, host: PageHost, userData: string, browser: Browser, origin: string) {
  const { helper, rewriteBackend } = pages;
  await prepareReply(pages, '甲', '已保存的合成回应方向。');
  await rewriteBackend.plan({ count: 1, prefix: '本次临时回复' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await editor.fill('重启后恢复已保存的编辑。');
  await editor.blur();
  await expect(helper.getByText('修改版本 1', { exact: true })).toBeVisible();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('未提交的合成回应方向。');
  await host.close();
  await rewriteBackend.command('restart');
  const restarted = new PageHost(await browser.newContext(), origin, userData);
  try {
    await restarted.backend.connect();
    const manager = await restarted.open('manager');
    const nextHelper = await restarted.open('helper');
    await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true })).toHaveValue('');
    await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption({ label: '合成联系人甲' });
    await confirmHelperContact(nextHelper, rewriteBackend.data.contact_ids[0]);
    await expect(nextHelper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    await setWorkspaceContext(nextHelper, true);
    await expect(nextHelper.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue('重启后恢复已保存的编辑。');
    await expandSavedDiscussion(nextHelper);
    await expect(nextHelper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
    const discussion = nextHelper.getByRole('region', { name: '已保存的讨论', exact: true });
    await expect(discussion.getByText('已保存的合成回应方向。', { exact: true })).toBeVisible();
    await expect(discussion.getByText('本次临时回复（说法1）。', { exact: true })).toBeVisible();
    await expect(nextHelper.getByText('未提交的合成回应方向。', { exact: true })).toHaveCount(0);
    await expect(nextHelper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
    await expect(nextHelper.getByRole('checkbox', { name: /甲的私密合成历史/ })).toBeChecked();
    await expect(nextHelper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  } finally { await restarted.close(); }
}

export async function directedReply(browser: Browser, origin: string) {
  const scenarios: Array<[string, (pages: RewritePages, host: PageHost, userData: string) => Promise<void>]> = [
    ['确认联系人、空表达门禁、真实请求与候选版本', confirmedTarget],
    ['当前联系人消息分页与逐条排除', messagePages],
    ['来源删除后拒绝旧快照并可新开表达', unavailableTarget],
    ['同键恢复和编辑保留、想法背景排除动作变更使用新键', inputIdentity],
    ['无消息、读取失败重试、撤销绑定与手动确认边界', emptyAndRejected],
    ['联系人切换后迟到列表成功和失败失效', (pages) => staleMessages(pages, false)],
    ['断线重连后迟到列表成功和失败失效', (pages) => staleMessages(pages, true)],
    ['联系人切换后迟到生成成功和失败失效', (pages: RewritePages) => staleGenerated(pages, false)],
    ['断线重连后迟到生成成功和失败失效', (pages: RewritePages) => staleGenerated(pages, true)],
    ['具名参数、排除标识、角色和范围拒绝', parameterGuards],
    ['重启恢复讨论与已存候选版本，不恢复未提交想法', (pages, host, userData) => newReplySession(pages, host, userData, browser, origin)],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withRewritePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
