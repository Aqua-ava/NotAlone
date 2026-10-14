import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';
import { withoutExternalTracing } from '../scripts/test-environment.mjs';

const enabled = process.env.CONDA_DEFAULT_ENV === 'NotAlone';
const draft = '合成预算讨论：' + '今晚不参加，感谢邀请。'.repeat(60);

for (const kind of ['connection', 'response']) {
  test(`真实预算拒绝后复验GET的${kind}故障可见且同次重试不追加输入`, { skip: !enabled }, async (t) => {
    const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
    const scope = await f.connect(), initial = await f.bridge.getState();
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
    const text = '预算拒绝读取故障仍保留的合成草稿。';
    const options = { tone: 'concise', instruction: '保留本次合成要求。', includeRelationshipContext: false };
    f.contacts.setDraft({ ...scope, text }); await f.bridge.updateOptions({ ...scope, options });
    let rejected = false, interruptedReads = 0;
    f.delivery.after = (request) => {
      if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) rejected = true;
      else if (rejected && request.method === 'GET' && request.path === endpoint) {
        interruptedReads += 1;
        throw new f.BackendRequestFailure(kind, kind === 'response' ? 503 : undefined);
      }
    };
    try { await f.bridge.generate({ ...scope, newRequest: true }); }
    finally { f.delivery.after = undefined; }
    assert.equal(interruptedReads, 1);
    const failed = await f.bridge.getState(), persisted = await f.request(endpoint);
    assert.equal(persisted.turns.length, 1); assert.equal(persisted.turns[0].state, 'failed');
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.errorCode, kind === 'connection' ? 'connection' : 'unavailable');
    assert.equal(failed.canRetry, true); assert.equal(failed.inputBudgetNotice, undefined);
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(failed.options, options);
    assert.equal((await f.command('metrics')).model_calls, 0);

    await f.bridge.generate({ ...scope, newRequest: false });
    const retried = await f.bridge.getState(), after = await f.request(endpoint);
    assert.equal(retried.phase, 'failed'); assert.equal(retried.errorCode, 'input_budget_exceeded');
    assert.equal(retried.canRetry, false); assert.equal(retried.inputBudgetNotice.decision.state, 'exceeded');
    assert.equal(after.turns.length, 1);
    assert.equal(after.turns[0].turn_id, persisted.turns[0].turn_id);
    assert.equal(after.turns[0].request_key, persisted.turns[0].request_key);
    assert.equal(after.current_input_version_id, persisted.current_input_version_id);
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(retried.options, options);
    assert.equal((await f.command('metrics')).model_calls, 0);
  });
}

test('预算拒绝后实际删除会话的复验404仍废弃旧输入和同次重试', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
  const scope = await f.connect(), initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  const text = '会话删除后仍独立保留的合成草稿。'; f.contacts.setDraft({ ...scope, text });
  let deleted = false;
  f.delivery.after = async (request) => {
    if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) {
      const receipt = await f.request(endpoint, { confirmed: true }, 'DELETE');
      assert.equal(receipt.state, 'deleted'); deleted = true;
    }
  };
  try { await f.bridge.generate({ ...scope, newRequest: true }); }
  finally { f.delivery.after = undefined; }
  assert.equal(deleted, true);
  const after = await f.bridge.getState();
  assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
  assert.equal(after.errorCode, undefined); assert.equal(after.inputBudgetNotice, undefined);
  assert.equal(after.result, null); assert.equal(f.contacts.getState().draft, text);
  assert.equal((await f.command('metrics')).model_calls, 0);
});

for (const delayedHistoryRead of [false, true]) {
  test(`预算拒绝复验确认404清除同会话已有候选和保存版本正文${delayedHistoryRead ? '，迟到完整读取不能复活' : ''}`, { skip: !enabled }, async (t) => {
    const f = await limitedFixture(t);
    f.contacts.setDraft({ ...f.scope, text: draft });
    await f.command('plan', { plan: { text: draft, count: 1 } });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    const completed = await f.bridge.getState();
    assert.equal(completed.phase, 'ready'); assert.equal(completed.result.candidates[0].original.text, draft);
    const candidateId = completed.result.candidates[0].original.candidateId;
    const sessionId = completed.savedSession.sessionId;
    const identity = { ...f.scope, sessionId, candidateId };
    const original = completed.candidateVersions.items.find((item) => item.candidateId === candidateId).history.versions[0];
    const edited = '仅为本次删除验证保存的合成编辑版本，不承诺参加。';
    await f.bridge.saveCandidateVersion({ ...identity, editKey: randomUUID(), parentVersionId: original.versionId,
      messages: original.messages.map((message) => ({ ...message, text: edited })), requirements: '不要承诺参加。' });
    const history = (await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === candidateId).history;
    await f.bridge.selectCandidateVersion({ ...identity, versionId: history.versions.at(-1).versionId, selectionKey: randomUUID() });
    const saved = await f.bridge.getState();
    assert.equal(saved.savedSession.turns[0].reply.candidates[0].text, draft);
    assert.equal(saved.candidateVersions.items.find((item) => item.candidateId === candidateId).history.versions.length, 2);
    assert(saved.explicitCandidateSelection.selection);
    const before = await f.command('metrics');
    const next = '会话删除后独立手写的合成草稿。';
    const options = { tone: 'concise', instruction: '当前独立手写要求：简短拒绝。', includeRelationshipContext: false };
    f.contacts.setDraft({ ...f.scope, text: next }); await f.bridge.updateOptions({ ...f.scope, options });
    const endpoint = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    let deleted = false, historyRead, releaseRead;
    let enteredRead;
    const entered = new Promise((resolve) => { enteredRead = resolve; });
    const gate = new Promise((resolve) => { releaseRead = resolve; });
    f.delivery.after = async (request) => {
      if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) {
        assert.equal((await f.command('metrics')).decisions.at(-1).state, 'exceeded');
        if (delayedHistoryRead) {
          historyRead = f.bridge.readSavedSession(f.scope);
          await entered;
        }
        const receipt = await f.request(endpoint, { confirmed: true }, 'DELETE');
        assert.equal(receipt.state, 'deleted'); deleted = true;
      } else if (delayedHistoryRead && !deleted && request.method === 'GET' && request.path === endpoint) {
        enteredRead(); await gate;
      }
    };
    try {
      await f.bridge.generate({ ...f.scope, newRequest: true });
      assert.equal(deleted, true);
      const after = await f.bridge.getState();
      assert.equal(after.result === null, true); assert.equal(after.selectedCandidateId, null);
      assert.equal(after.canRetry, false); assert.equal(after.inputBudgetNotice, undefined); assert.equal(after.errorCode, undefined);
      assert(after.savedSession.turns.every((turn) => turn.input === null && turn.reply === null));
      assert(after.savedSession.inputs.every((input) => input.content === null));
      assert.deepEqual(after.candidateVersions.items, []); assert.equal(after.explicitCandidateSelection.selection, null);
      assert(!JSON.stringify(after).includes(draft)); assert(!JSON.stringify(after).includes(edited));
      assert.equal(f.contacts.getState().draft, next); assert.deepEqual(after.options, options);
      assert.equal((await f.command('metrics')).model_calls, before.model_calls);
      releaseRead(); await historyRead;
      const late = await f.bridge.getState();
      assert.equal(late.result, null); assert.deepEqual(late.candidateVersions.items, []);
      assert(!JSON.stringify(late).includes(draft)); assert(!JSON.stringify(late).includes(edited));
      assert.equal(f.contacts.getState().draft, next); assert.deepEqual(late.options, options);
      await assert.rejects(f.request(endpoint), (error) => error.status === 404);
      await f.bridge.newSavedSession(f.scope);
      const reopened = await f.bridge.getState();
      assert.notEqual(reopened.savedSession.sessionId, sessionId);
      assert.deepEqual(reopened.savedSession.turns, []); assert.deepEqual(reopened.candidateVersions.items, []);
      assert.equal(reopened.result, null); assert.equal((await f.command('metrics')).model_calls, before.model_calls);
    } finally { f.delivery.after = undefined; releaseRead(); await historyRead; }
  });
}

test('预算公开生成不继承父环境的旧版追踪开关与供应商配置', { skip: !enabled }, async (t) => {
  const inherited = process.env;
  let f;
  try {
    // 先剥除宿主配置，再注入合成旧版开关；V2 关闭使旧夹具在创建追踪回调前失败。
    process.env = { ...withoutExternalTracing(inherited), LANGSMITH_TRACING_V2: 'false',
      LANGCHAIN_TRACING: 'true', LANGCHAIN_HANDLER: 'true',
      LANGSMITH_API_KEY: 'synthetic-unused-key', LANGCHAIN_API_KEY: 'synthetic-unused-key',
      LANGSMITH_ENDPOINT: 'http://127.0.0.1:1', LANGCHAIN_ENDPOINT: 'http://127.0.0.1:1',
      LANGSMITH_PROJECT: 'synthetic-budget-isolation', LANGCHAIN_PROJECT: 'synthetic-budget-isolation' };
    f = await budgetPublicFixture(t);
  } finally { process.env = inherited; }
  const scope = await f.connect(), text = '本轮追踪隔离回归的合成草稿。';
  f.contacts.setDraft({ ...scope, text });
  await f.command('plan', { plan: { text, count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  const state = await f.bridge.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.errorCode, undefined);
  assert.equal(state.result.inputBudget.state, 'ready');
  assert.equal(state.result.candidates[0].original.text, text);
  await f.bridge.readSavedSession(scope);
  assert.equal((await f.bridge.getState()).savedSession.turns[0].state, 'completed');
  assert.equal((await f.command('metrics')).model_calls, 1);
});

async function limitedFixture(t) {
  const f = await budgetPublicFixture(t), contactId = f.data.contact_ids[0];
  const base = `/api/contacts/${contactId}/assistant-sessions`;
  const first = await f.request(base, {});
  await f.command('plan', { plan: { text: draft, count: 1 } });
  const baseline = await f.request(`${base}/${first.session_id}/replies`, { contact_id: contactId,
    idempotency_key: randomUUID(), content: { type: 'rewrite_draft', draft_text: draft,
      user_instruction: null, include_relationship_context: false } });
  await f.configure({ capacity: baseline.input_budget.total_tokens + 100 });
  const scope = await f.connect(); await f.bridge.newSavedSession(scope);
  return { ...f, scope, baseline };
}

for (const newRequest of [false, true]) {
  test(newRequest ? '工具后预算拒绝后显式新请求的普通失败重试保留新身份与旧历史'
    : '工具后预算拒绝转普通失败后公开同次重试保持请求键与输入版本', { skip: !enabled }, async (t) => {
    const f = await budgetPublicFixture(t, { toolHistory: true });
    const contactId = f.data.contact_ids[0], base = `/api/contacts/${contactId}/assistant-sessions`;
    const text = '工具预算拒绝后继续本次表达的合成草稿。';
    const options = { tone: 'original', instruction: '只保留本次草稿，不增加承诺。', includeRelationshipContext: true };
    const calibration = await f.request(base, {});
    await f.command('plan', { plan: { probe_history: true, text, count: 1 } });
    const completed = await f.request(`${base}/${calibration.session_id}/replies`, { contact_id: contactId,
      idempotency_key: randomUUID(), content: { type: 'rewrite_draft', draft_text: text,
        user_instruction: options.instruction, include_relationship_context: true } });
    assert.equal(completed.candidates[0].citation_ids.length, 2);
    const calibrated = await f.command('metrics');
    assert.equal(calibrated.model_calls, 2); assert.equal(calibrated.decisions.length, 2);
    const capacity = calibrated.decisions[1].total_tokens - 100;
    assert(capacity > calibrated.decisions[0].total_tokens);
    await f.configure({ capacity });
    const scope = await f.connect(); await f.bridge.newSavedSession(scope);
    f.contacts.setDraft({ ...scope, text }); await f.bridge.updateOptions({ ...scope, options });
    const start = await f.command('metrics');
    // 工具轮被预算守卫拒绝时，现有脚本保留下一轮普通模型失败供公开再生成。
    await f.command('plan', { plan: { probe_history: true, fault: 'model_failed' } });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const budgetFailed = await f.bridge.getState(), toolMetrics = await f.command('metrics');
    assert.equal(budgetFailed.errorCode, 'input_budget_exceeded');
    assert.equal(budgetFailed.canRetry, false);
    assert.equal(budgetFailed.inputBudgetNotice.decision.state, 'exceeded');
    assert.equal(budgetFailed.savedSession.turns.length, 1);
    const first = budgetFailed.savedSession.turns[0];
    assert.equal(first.state, 'failed'); assert.equal(first.input.content.draft_text, text);
    assert.equal(budgetFailed.savedSession.currentInputVersionId, first.inputVersionId);
    assert.equal(toolMetrics.model_calls, start.model_calls + 1);
    assert.deepEqual(toolMetrics.decisions.slice(start.decisions.length).map((decision) => decision.allowed), [true, true, false]);
    process.stdout.write(`budget_retry_counterexample: new_request=${newRequest} initial=${calibrated.decisions[0].total_tokens} tool=${calibrated.decisions[1].total_tokens} capacity=${capacity} rejected_model_calls=${toolMetrics.model_calls - start.model_calls}\n`);
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(budgetFailed.options, options);

    await f.bridge.generate({ ...scope, newRequest });
    await f.bridge.readSavedSession(scope);
    const modelFailed = await f.bridge.getState(), failureMetrics = await f.command('metrics');
    assert.equal(modelFailed.phase, 'failed'); assert.equal(modelFailed.errorCode, 'generation_failed');
    assert.equal(modelFailed.canRetry, true); assert.equal(modelFailed.inputBudgetNotice, undefined);
    const turnCount = newRequest ? 2 : 1, active = modelFailed.savedSession.turns.at(-1);
    assert.equal(modelFailed.savedSession.turns.length, turnCount);
    assert.equal(active.state, 'failed'); assert.equal(active.input.content.draft_text, text);
    if (newRequest) {
      assert.notEqual(active.turnId, first.turnId); assert.notEqual(active.requestKey, first.requestKey);
      assert.notEqual(active.inputVersionId, first.inputVersionId);
      assert.deepEqual(modelFailed.savedSession.turns[0], first);
    } else {
      assert.equal(active.turnId, first.turnId); assert.equal(active.requestKey, first.requestKey);
      assert.equal(active.inputVersionId, first.inputVersionId);
    }
    assert.equal(modelFailed.savedSession.currentInputVersionId, active.inputVersionId);
    assert.equal(failureMetrics.model_calls, toolMetrics.model_calls + 1);
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(modelFailed.options, options);

    await f.command('plan', { plan: { text, count: 1 } });
    await f.bridge.generate({ ...scope, newRequest: false });
    await f.bridge.readSavedSession(scope);
    const retried = await f.bridge.getState();
    const completedTurn = retried.savedSession.turns.at(-1);
    assert.equal(retried.savedSession.turns.length, turnCount);
    assert.equal(completedTurn.turnId, active.turnId); assert.equal(completedTurn.requestKey, active.requestKey);
    assert.equal(completedTurn.inputVersionId, active.inputVersionId);
    assert.equal(retried.savedSession.currentInputVersionId, active.inputVersionId);
    assert.equal(completedTurn.input.content.draft_text, text);
    assert.equal(completedTurn.state, 'completed'); assert.equal(retried.phase, 'ready');
    assert.equal(retried.errorCode, undefined);
    if (newRequest) assert.deepEqual(retried.savedSession.turns[0], first);
    assert.equal(retried.result.candidates[0].original.text, text);
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(retried.options, options);
    assert.equal((await f.command('metrics')).model_calls, failureMetrics.model_calls + 1);
  });
}

test('真实受控配置的累计预算warning经Main/preload公开结果返回，不重算历史', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t);
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const state = await f.bridge.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.result?.inputBudget?.state, 'warning');
  assert.equal(state.inputBudgetNotice?.decision.state, 'warning');
  assert.equal(state.inputBudgetNotice?.sessionId, state.result.assistantSessionId);
  assert.equal(state.inputBudgetNotice?.inputVersionId, state.result.inputVersionId);
  await f.bridge.readSavedSession(f.scope);
  assert.deepEqual((await f.bridge.getState()).savedSession.turns[0].reply.inputBudget, state.result.inputBudget);
});

test('公开预算warning在助手会话显示，并保持已填草稿和独立新开入口', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t);
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const html = f.renderSession(await f.bridge.getState());
  assert.match(html, /当前讨论已接近模型输入上限/);
  assert.match(html, /新开助手会话/);
  assert.equal(f.contacts.getState().draft, draft);
});

test('实际硬限409只透出同一守卫的纯元数据，初次模型调用为0', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
  const contactId = f.data.contact_ids[0], base = `/api/contacts/${contactId}/assistant-sessions`;
  const session = await f.request(base, {}), before = await f.command('metrics');
  let failure;
  try { await f.request(`${base}/${session.session_id}/replies`, { contact_id: contactId,
    idempotency_key: randomUUID(), content: { type: 'rewrite_draft', draft_text: draft,
      user_instruction: null, include_relationship_context: false } }); }
  catch (error) { failure = error; }
  assert.equal(failure?.code, 'input_budget_exceeded');
  assert.equal(failure?.inputBudget?.state, 'exceeded');
  assert.equal(failure?.inputBudget?.allowed, false);
  assert(!JSON.stringify(failure).includes(draft));
  assert.equal((await f.command('metrics')).model_calls, before.model_calls);
});

test('累计硬限在公开状态提示，保留已填草稿与历史并可独立新开空会话', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t);
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const old = await f.bridge.getState(), before = await f.command('metrics');
  const edit = '本次应保留的合成未提交草稿。';
  f.contacts.setDraft({ ...f.scope, text: edit });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const rejected = await f.bridge.getState();
  assert.equal(rejected.errorCode, 'input_budget_exceeded');
  assert.equal(rejected.inputBudgetNotice?.decision.state, 'exceeded');
  assert.equal(rejected.inputBudgetNotice?.sessionId, old.savedSession.sessionId);
  assert.equal(f.contacts.getState().draft, edit);
  assert.equal((await f.command('metrics')).model_calls, before.model_calls);
  assert.match(f.renderSession(rejected), /超限调用已停止/);
  await f.bridge.readSavedSession(f.scope);
  const saved = await f.bridge.getState();
  assert.equal(saved.savedSession.turns[0].input.content.draft_text, draft);
  assert.equal(saved.savedSession.turns[1].input.content.draft_text, edit);
  assert.equal(saved.inputBudgetNotice.inputVersionId, saved.savedSession.turns[1].inputVersionId);
  assert.equal(saved.inputBudgetNotice.requestKey, saved.savedSession.turns[1].requestKey);
  await f.bridge.newSavedSession(f.scope);
  const empty = await f.bridge.getState();
  assert.notEqual(empty.savedSession.sessionId, old.savedSession.sessionId);
  assert.deepEqual(empty.savedSession.turns, []); assert.deepEqual(empty.savedSession.inputs, []);
  assert.equal(empty.inputBudgetNotice, undefined);
  assert.equal((await f.command('metrics')).model_calls, before.model_calls);
  await f.bridge.selectSavedSession({ ...f.scope, sessionId: old.savedSession.sessionId });
  assert.equal((await f.bridge.getState()).savedSession.turns[0].input.content.draft_text, draft);
});

test('计量能力未知保持阻断和无计量值，公开读取与已填写内容仍可用', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t); await f.configure({ unknown: true });
  const scope = await f.connect(), before = await f.command('metrics');
  f.contacts.setDraft({ ...scope, text: '未知计量时应保留的合成草稿。' });
  await f.bridge.generate({ ...scope, newRequest: true });
  const state = await f.bridge.getState();
  assert.equal(state.errorCode, 'input_budget_unavailable');
  assert.equal(state.inputBudgetNotice?.decision.state, 'unavailable');
  assert.equal(state.inputBudgetNotice?.decision.inputTokens, null);
  assert.equal(state.inputBudgetNotice?.decision.totalTokens, null);
  assert.equal(f.contacts.getState().draft, '未知计量时应保留的合成草稿。');
  assert.match(f.renderSession(state), /完整输入计量配置不可用/);
  assert(!f.renderSession(state).includes('/ 0 token'));
  await f.bridge.readSavedSession(scope);
  const saved = (await f.bridge.getState()).savedSession;
  assert.equal(saved.phase, 'ready'); assert.equal(saved.turns.length, 1);
  assert.equal((await f.command('metrics')).model_calls, before.model_calls);
});

test('公开完整重读观察到实际CURRENT变化后不把旧输入预算提示用于新输入', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t);
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const before = await f.bridge.getState();
  assert.equal(before.inputBudgetNotice.decision.state, 'warning');
  const path = `/api/contacts/${f.scope.contactId}/assistant-sessions/${before.savedSession.sessionId}`;
  const input = await f.request(`${path}/inputs`, { expected_input_version_id: before.result.inputVersionId,
    content: { type: 'purpose_exploration', purpose_hint: '另一客户端追加的合成讨论。' } });
  await f.bridge.readSavedSession(f.scope);
  const after = await f.bridge.getState();
  assert.equal(after.savedSession.currentInputVersionId, input.input_version_id);
  assert.equal(after.inputBudgetNotice, undefined);
  assert.equal(after.savedSession.turns[0].reply.inputBudget.state, 'warning');
  assert.equal(f.contacts.getState().draft, draft);
});

test('跨联系人迟到的实际预算拒绝不覆盖新范围，越权和旧scope在公开入口拒绝', { skip: !enabled, timeout: 20000 }, async (t) => {
  const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
  const scope = await f.connect();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = new Promise((resolve) => { entered = resolve; });
  f.delivery.after = async (options) => {
    if (options.path.endsWith('/replies/prepare')) { entered(); await gate; }
  };
  f.contacts.setDraft({ ...scope, text: '甲的迟到预算合成草稿。' });
  const pending = f.bridge.generate({ ...scope, newRequest: true });
  try {
    await delivered;
    f.contacts.selectContact({ contactId: f.data.contact_ids[1], scopeRevision: scope.scopeRevision });
    const next = { contactId: f.data.contact_ids[1], scopeRevision: f.contacts.getState().scopeRevision };
    await f.bridge.readSavedSession(next);
    f.contacts.setDraft({ ...next, text: '乙的新合成草稿。' });
    release(); await pending;
    const state = await f.bridge.getState();
    assert.equal(state.contactId, next.contactId); assert.equal(state.phase, 'idle');
    assert.equal(state.inputBudgetNotice, undefined); assert.equal(f.contacts.getState().draft, '乙的新合成草稿。');
    await assert.rejects(f.bridge.generate({ ...scope, newRequest: true }));
    await assert.rejects(f.bridge.generate({ ...next, contactId: f.data.foreign_contact_id, newRequest: true }));
    await assert.rejects(f.request(`/api/contacts/${f.data.foreign_contact_id}/assistant-session/default`, {}),
      (error) => error.status === 404 && error.inputBudget === undefined);
    assert.equal((await f.command('metrics')).model_calls, 0);
  } finally { release(); await pending; f.delivery.after = undefined; }
});

test('新连接清除旧预算提示和迟到身份，历史回执仍可公开重读', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t);
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.equal((await f.bridge.getState()).inputBudgetNotice.decision.state, 'warning');
  f.disconnect();
  assert.equal((await f.bridge.getState()).inputBudgetNotice, undefined);
  const scope = await f.connect();
  await f.bridge.readSavedSession(scope);
  const state = await f.bridge.getState();
  assert.equal(state.inputBudgetNotice, undefined);
  assert.equal(state.savedSession.turns[0].reply.inputBudget.state, 'warning');
});

test('删除助手会话清除其预算提示与历史回执，独立消息仍可读取', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t);
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const saved = await f.bridge.getState(), before = await f.command('metrics');
  assert.equal(saved.inputBudgetNotice.decision.state, 'warning');
  await f.bridge.deleteSavedSession({ ...f.scope, sessionId: saved.savedSession.sessionId, confirmed: true });
  const state = await f.bridge.getState();
  assert.equal(state.sessionDeletion, 'deleted'); assert.equal(state.inputBudgetNotice, undefined);
  assert.deepEqual(state.savedSession.turns, []);
  await assert.rejects(f.request(`/api/contacts/${f.scope.contactId}/assistant-sessions/${saved.savedSession.sessionId}`),
    (error) => error.status === 404 && error.inputBudget === undefined);
  await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
  assert.equal((await f.bridge.getState()).messages.items.length, 1);
  assert.equal((await f.command('metrics')).model_calls, before.model_calls);
});

for (const failure of [
  { code: 'input_budget_exceeded', configure: { capacity: 101 }, text: /当前讨论超出模型输入预算/ },
  { code: 'input_budget_unavailable', configure: { unknown: true }, text: /当前模型的完整输入预算暂不可核验/ },
]) {
  test(`同会话实际CURRENT更新后清除旧${failure.code}当前错误，历史与草稿不变`, { skip: !enabled }, async (t) => {
    const f = await budgetPublicFixture(t); await f.configure(failure.configure);
    const scope = await f.connect();
    const options = { tone: 'concise', instruction: '本次合成要求保持不变。', includeRelationshipContext: false };
    await f.bridge.updateOptions({ ...scope, options });
    const text = '预算拒绝后仍需保留的合成草稿。';
    f.contacts.setDraft({ ...scope, text });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const before = await f.bridge.getState();
    assert.equal(before.phase, 'failed'); assert.equal(before.errorCode, failure.code);
    assert.equal(before.canRetry, false); assert.match(f.renderCandidates(before), failure.text);
    const oldInput = before.inputBudgetNotice.inputVersionId;
    assert.equal(before.savedSession.currentInputVersionId, oldInput);
    assert.equal(before.savedSession.turns[0].state, 'failed');
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${before.savedSession.sessionId}`;
    const next = await f.request(`${endpoint}/inputs`, { expected_input_version_id: oldInput,
      content: { type: 'purpose_exploration', purpose_hint: '另一客户端添加的未计量合成讨论。' } });
    assert.notEqual(next.input_version_id, oldInput);
    await f.bridge.readSavedSession(scope);
    const after = await f.bridge.getState(), html = f.renderCandidates(after);
    assert.equal(after.savedSession.currentInputVersionId, next.input_version_id);
    assert.equal(after.inputBudgetNotice, undefined);
    assert.equal(after.errorCode, undefined);
    assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
    assert.doesNotMatch(html, /当前讨论超出模型输入预算|当前模型的完整输入预算暂不可核验/);
    assert.match(html, /本轮生成未成功保存/);
    assert.equal(after.savedSession.turns[0].inputVersionId, oldInput);
    assert.equal(after.savedSession.turns[0].state, 'failed');
    assert.equal(after.savedSession.turns[0].input.content.draft_text, text);
    assert.equal(after.savedSession.inputs.find((input) => input.inputVersionId === next.input_version_id).state, 'active');
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(after.options, options);
    // 普通生成按钮不会把旧失败键用于实际新 CURRENT；未知预算仍由同一守卫拒绝。
    await f.bridge.generate({ ...scope, newRequest: false });
    await f.bridge.readSavedSession(scope);
    const attempted = await f.bridge.getState();
    assert.equal(attempted.errorCode, failure.code); assert.equal(attempted.canRetry, false);
    assert.notEqual(attempted.inputBudgetNotice.requestKey, before.inputBudgetNotice.requestKey);
    assert.notEqual(attempted.inputBudgetNotice.inputVersionId, oldInput);
    assert.notEqual(attempted.inputBudgetNotice.inputVersionId, next.input_version_id);
    assert.equal(attempted.savedSession.currentInputVersionId, attempted.inputBudgetNotice.inputVersionId);
    assert.equal(attempted.savedSession.turns.length, 2);
    assert.equal(attempted.savedSession.turns[0].inputVersionId, oldInput);
    assert.equal(attempted.savedSession.turns[0].state, 'failed');
    assert.equal(f.contacts.getState().draft, text); assert.deepEqual(attempted.options, options);
    assert.equal((await f.command('metrics')).model_calls, 0);
    f.disconnect();
    const disconnected = await f.bridge.getState();
    assert.equal(disconnected.inputBudgetNotice, undefined); assert.equal(disconnected.errorCode, undefined);
    assert.equal(disconnected.phase, 'idle'); assert.equal(disconnected.canRetry, false);
    const reconnectedScope = await f.connect();
    const recovered = await f.bridge.getState();
    assert.equal(recovered.errorCode, undefined); assert.equal(recovered.inputBudgetNotice, undefined);
    assert.equal(recovered.savedSession.turns.length, 2);
    assert.equal(recovered.savedSession.turns[0].inputVersionId, oldInput);
    assert.equal(recovered.savedSession.turns[1].inputVersionId, attempted.inputBudgetNotice.inputVersionId);
    assert.doesNotMatch(f.renderCandidates(recovered), failure.text);
    assert.equal(reconnectedScope.contactId, scope.contactId);
    assert.equal((await f.command('metrics')).model_calls, 0);
  });
}

test('实际CURRENT重读只清失去归属的预算错误，不清普通模型失败和同次重试', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  const text = '应保留普通失败状态的合成草稿。';
  f.contacts.setDraft({ ...scope, text });
  await f.command('plan', { plan: { fault: 'model_failed' } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  assert.equal(before.errorCode, 'generation_failed'); assert.equal(before.canRetry, true);
  assert.equal(before.inputBudgetNotice, undefined);
  const oldInput = before.savedSession.currentInputVersionId;
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${before.savedSession.sessionId}`;
  const next = await f.request(`${endpoint}/inputs`, { expected_input_version_id: oldInput,
    content: { type: 'purpose_exploration', purpose_hint: '另一客户端独立修改的合成讨论。' } });
  await f.bridge.readSavedSession(scope);
  const after = await f.bridge.getState();
  assert.equal(after.savedSession.currentInputVersionId, next.input_version_id);
  assert.equal(after.errorCode, 'generation_failed'); assert.equal(after.phase, 'failed');
  assert.equal(after.canRetry, true); assert.equal(after.inputBudgetNotice, undefined);
  assert.match(f.renderCandidates(after), /本次生成失败，请核对本机服务后重试/);
  assert.doesNotMatch(f.renderCandidates(after), /当前讨论超出模型输入预算|当前模型的完整输入预算暂不可核验/);
  assert.equal(after.savedSession.turns[0].state, 'failed');
  assert.equal(after.savedSession.turns[0].input.content.draft_text, text);
  assert.equal(f.contacts.getState().draft, text);
  assert.equal((await f.command('metrics')).model_calls, 1);
});


for (const failure of [
  { code: 'input_budget_exceeded', configure: { capacity: 101 } },
  { code: 'input_budget_unavailable', configure: { unknown: true } },
]) {
  test(`同会话已读新CURRENT后迟到${failure.code}不重新发布旧输入的当前错误`, { skip: !enabled }, async (t) => {
    const f = await budgetPublicFixture(t); await f.configure(failure.configure);
    const scope = await f.connect(), initial = await f.bridge.getState();
    const options = { tone: 'concise', instruction: '迟到失败期间保留的合成要求。', includeRelationshipContext: false };
    await f.bridge.updateOptions({ ...scope, options });
    const text = '迟到预算拒绝期间保留的合成草稿。';
    f.contacts.setDraft({ ...scope, text });
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const delivered = new Promise((resolve) => { entered = resolve; });
    f.delivery.after = async (request) => {
      if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) { entered(); await gate; }
    };
    const pending = f.bridge.generate({ ...scope, newRequest: true });
    try {
      await delivered;
      const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
      const failed = await f.request(endpoint);
      assert.equal(failed.turns.length, 1); assert.equal(failed.turns[0].state, 'failed');
      const oldInput = failed.current_input_version_id, oldKey = failed.turns[0].request_key;
      const next = await f.request(`${endpoint}/inputs`, { expected_input_version_id: oldInput,
        content: { type: 'purpose_exploration', purpose_hint: '错误尚未送达时另一客户端添加的合成讨论。' } });
      await f.bridge.readSavedSession(scope);
      const observed = await f.bridge.getState();
      assert.equal(observed.savedSession.currentInputVersionId, next.input_version_id);
      assert.equal(observed.inputBudgetNotice, undefined); assert.equal(observed.errorCode, undefined);
      release(); await pending; f.delivery.after = undefined;
      const after = await f.bridge.getState();
      assert.equal(after.inputBudgetNotice, undefined);
      assert.equal(after.errorCode, undefined); assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
      assert.equal(after.savedSession.currentInputVersionId, next.input_version_id);
      assert.equal(after.savedSession.turns[0].state, 'failed');
      assert.equal(after.savedSession.turns[0].inputVersionId, oldInput);
      assert.equal(after.savedSession.turns[0].requestKey, oldKey);
      assert.equal(after.savedSession.turns[0].input.content.draft_text, text);
      assert.equal(after.savedSession.inputs.find((input) => input.inputVersionId === next.input_version_id).state, 'active');
      assert.equal(f.contacts.getState().draft, text); assert.deepEqual(after.options, options);
      assert.doesNotMatch(f.renderCandidates(after), /当前讨论超出模型输入预算|当前模型的完整输入预算暂不可核验/);
      assert.match(f.renderCandidates(after), /本轮生成未成功保存/);
      assert.equal((await f.command('metrics')).model_calls, 0);
      // 普通生成沿实际新 CURRENT 签发新身份，不重放迟到的旧失败键。
      await f.bridge.generate({ ...scope, newRequest: false });
      await f.bridge.readSavedSession(scope);
      const attempted = await f.bridge.getState();
      assert.equal(attempted.errorCode, failure.code);
      assert.notEqual(attempted.inputBudgetNotice.requestKey, oldKey);
      assert.notEqual(attempted.inputBudgetNotice.inputVersionId, oldInput);
      assert.notEqual(attempted.inputBudgetNotice.inputVersionId, next.input_version_id);
      assert.equal(attempted.savedSession.currentInputVersionId, attempted.inputBudgetNotice.inputVersionId);
      assert.equal(attempted.savedSession.turns.length, 2);
      assert.equal(attempted.savedSession.turns[0].requestKey, oldKey);
      assert.equal(attempted.savedSession.turns[0].state, 'failed');
      assert.equal(f.contacts.getState().draft, text); assert.deepEqual(attempted.options, options);
      assert.equal((await f.command('metrics')).model_calls, 0);
    } finally { release(); await pending; f.delivery.after = undefined; }
  });
}

for (const failure of [
  { code: 'input_budget_exceeded', configure: { capacity: 101 } },
  { code: 'input_budget_unavailable', configure: { unknown: true } },
]) {
  test(`预算复验GET被公开新CURRENT重读超越后迟到${failure.code}不复活旧错误`, { skip: !enabled }, async (t) => {
    const f = await budgetPublicFixture(t); await f.configure(failure.configure);
    const scope = await f.connect(), initial = await f.bridge.getState();
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
    const options = { tone: 'concise', instruction: '复验迟到期间保留的合成要求。', includeRelationshipContext: false };
    await f.bridge.updateOptions({ ...scope, options });
    const text = '复验迟到期间保留的合成草稿。';
    f.contacts.setDraft({ ...scope, text });
    let release, entered, catchRead = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const delivered = new Promise((resolve) => { entered = resolve; });
    f.delivery.after = async (request) => {
      if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) catchRead = true;
      else if (catchRead && request.method === 'GET' && request.path === endpoint) {
        catchRead = false; entered(); await gate;
      }
    };
    const pending = f.bridge.generate({ ...scope, newRequest: true });
    try {
      await delivered;
      // 已完成的真实复验GET仍持有旧CURRENT；只暂停交付，不替换回执。
      const failed = await f.request(endpoint);
      assert.equal(failed.turns.length, 1); assert.equal(failed.turns[0].state, 'failed');
      const oldInput = failed.current_input_version_id, oldKey = failed.turns[0].request_key;
      assert.equal(failed.inputs.find((input) => input.input_version_id === oldInput).state, 'active');
      const next = await f.request(`${endpoint}/inputs`, { expected_input_version_id: oldInput,
        content: { type: 'purpose_exploration', purpose_hint: '复验GET完成后另一客户端添加的合成讨论。' } });
      await f.bridge.readSavedSession(scope);
      const observed = await f.bridge.getState();
      assert.equal(observed.savedSession.currentInputVersionId, next.input_version_id);
      assert.equal(observed.inputBudgetNotice, undefined); assert.equal(observed.errorCode, undefined);
      release(); await pending; f.delivery.after = undefined;
      const after = await f.bridge.getState();
      assert.equal(after.inputBudgetNotice, undefined);
      assert.equal(after.errorCode, undefined); assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
      assert.equal(after.savedSession.currentInputVersionId, next.input_version_id);
      assert.equal(after.savedSession.turns[0].state, 'failed');
      assert.equal(after.savedSession.turns[0].inputVersionId, oldInput);
      assert.equal(after.savedSession.turns[0].requestKey, oldKey);
      assert.equal(after.savedSession.turns[0].input.content.draft_text, text);
      assert.equal(after.savedSession.inputs.find((input) => input.inputVersionId === next.input_version_id).state, 'active');
      assert.equal(f.contacts.getState().draft, text); assert.deepEqual(after.options, options);
      assert.doesNotMatch(f.renderCandidates(after), /当前讨论超出模型输入预算|当前模型的完整输入预算暂不可核验/);
      assert.equal((await f.command('metrics')).model_calls, 0);
      await f.bridge.generate({ ...scope, newRequest: false });
      await f.bridge.readSavedSession(scope);
      const attempted = await f.bridge.getState();
      assert.equal(attempted.errorCode, failure.code); assert.equal(attempted.canRetry, false);
      assert.notEqual(attempted.inputBudgetNotice.requestKey, oldKey);
      assert.notEqual(attempted.inputBudgetNotice.inputVersionId, oldInput);
      assert.notEqual(attempted.inputBudgetNotice.inputVersionId, next.input_version_id);
      assert.equal(attempted.savedSession.currentInputVersionId, attempted.inputBudgetNotice.inputVersionId);
      assert.equal(attempted.savedSession.turns.length, 2);
      assert.equal(attempted.savedSession.turns[0].requestKey, oldKey);
      assert.equal(attempted.savedSession.turns[0].inputVersionId, oldInput);
      assert.equal(attempted.savedSession.turns[0].state, 'failed');
      assert.equal(attempted.savedSession.turns[0].input.content.draft_text, text);
      assert.equal(f.contacts.getState().draft, text); assert.deepEqual(attempted.options, options);
      assert.equal((await f.command('metrics')).model_calls, 0);
    } finally { release(); await pending; f.delivery.after = undefined; }
  });
}

async function heldBudgetVerification(t) {
  const f = await budgetPublicFixture(t); await f.configure({ capacity: 101 });
  const scope = await f.connect(), initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  const options = { tone: 'concise', instruction: '读取竞态保留的合成要求。', includeRelationshipContext: false };
  await f.bridge.updateOptions({ ...scope, options });
  const text = '读取竞态保留的合成草稿。';
  f.contacts.setDraft({ ...scope, text });
  let release, entered, catchRead = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = new Promise((resolve) => { entered = resolve; });
  f.delivery.after = async (request) => {
    if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) catchRead = true;
    else if (catchRead && request.method === 'GET' && request.path === endpoint) {
      catchRead = false; entered(); await gate;
    }
  };
  const pending = f.bridge.generate({ ...scope, newRequest: true });
  await delivered;
  return { ...f, scope, endpoint, options, text, pending, release, failed: await f.request(endpoint) };
}

test('预算复验GET被同CURRENT的较晚公开ready重读超越仍保留合法预算错误', { skip: !enabled }, async (t) => {
  const f = await heldBudgetVerification(t);
  try {
    assert.equal(f.failed.turns[0].state, 'failed');
    await f.bridge.readSavedSession(f.scope);
    const observed = await f.bridge.getState();
    assert.equal(observed.savedSession.phase, 'ready');
    assert.equal(observed.savedSession.currentInputVersionId, f.failed.current_input_version_id);
    assert.equal(observed.inputBudgetNotice, undefined); assert.equal(observed.errorCode, undefined);
    f.release(); await f.pending;
    const after = await f.bridge.getState();
    assert.equal(after.phase, 'failed'); assert.equal(after.errorCode, 'input_budget_exceeded');
    assert.equal(after.inputBudgetNotice.decision.state, 'exceeded'); assert.equal(after.canRetry, false);
    assert.equal(after.inputBudgetNotice.inputVersionId, f.failed.current_input_version_id);
    assert.equal(after.inputBudgetNotice.requestKey, f.failed.turns[0].request_key);
    assert.equal(after.savedSession.currentInputVersionId, f.failed.current_input_version_id);
    assert.equal(after.savedSession.turns[0].input.content.draft_text, f.text);
    assert.equal(f.contacts.getState().draft, f.text); assert.deepEqual(after.options, f.options);
    assert.equal((await f.command('metrics')).model_calls, 0);
  } finally { f.release(); await f.pending; f.delivery.after = undefined; }
});

test('预算复验GET迟到时较晚公开读取仍在loading则暂不发布旧输入结论', { skip: !enabled }, async (t) => {
  const f = await heldBudgetVerification(t);
  let releaseRead, enteredRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const delivered = new Promise((resolve) => { enteredRead = resolve; });
  let reading;
  try {
    const next = await f.request(`${f.endpoint}/inputs`, { expected_input_version_id: f.failed.current_input_version_id,
      content: { type: 'purpose_exploration', purpose_hint: '较晚读取尚未交付的新合成讨论。' } });
    f.delivery.after = async (request) => {
      if (request.method === 'GET' && request.path === f.endpoint) { enteredRead(); await gate; }
    };
    reading = f.bridge.readSavedSession(f.scope);
    await delivered;
    assert.equal((await f.bridge.getState()).savedSession.phase, 'loading');
    f.release(); await f.pending;
    const waiting = await f.bridge.getState();
    assert.equal(waiting.savedSession.phase, 'loading');
    assert.equal(waiting.inputBudgetNotice, undefined); assert.equal(waiting.errorCode, undefined);
    assert.equal(waiting.phase, 'idle'); assert.equal(waiting.canRetry, false);
    assert.equal(f.contacts.getState().draft, f.text); assert.deepEqual(waiting.options, f.options);
    releaseRead(); await reading; f.delivery.after = undefined;
    const after = await f.bridge.getState();
    assert.equal(after.savedSession.phase, 'ready');
    assert.equal(after.savedSession.currentInputVersionId, next.input_version_id);
    assert.equal(after.inputBudgetNotice, undefined); assert.equal(after.errorCode, undefined);
    assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
    assert.equal(after.savedSession.turns[0].inputVersionId, f.failed.current_input_version_id);
    assert.equal(after.savedSession.turns[0].requestKey, f.failed.turns[0].request_key);
    assert.equal(after.savedSession.turns[0].state, 'failed');
    assert.equal(after.savedSession.turns[0].input.content.draft_text, f.text);
    assert.equal(f.contacts.getState().draft, f.text); assert.deepEqual(after.options, f.options);
    assert.equal((await f.command('metrics')).model_calls, 0);
  } finally { releaseRead(); f.release(); await reading; await f.pending; f.delivery.after = undefined; }
});

test('成功预算复验GET被公开新CURRENT重读超越后保留新视图且不复活旧warning', { skip: !enabled }, async (t) => {
  const f = await limitedFixture(t), initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${f.scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  f.contacts.setDraft({ ...f.scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  let release, entered, verificationRead = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = new Promise((resolve) => { entered = resolve; });
  f.delivery.after = async (request) => {
    if (request.method === 'POST' && request.path.endsWith('/replies')) verificationRead = true;
    else if (verificationRead && request.method === 'GET' && request.path === endpoint) {
      verificationRead = false; entered(); await gate;
    }
  };
  const pending = f.bridge.generate({ ...f.scope, newRequest: true });
  try {
    await delivered;
    // 真实成功复验已读取旧CURRENT，只暂停交付；所有正文与预算回执仍来自HTTP。
    const completed = await f.request(endpoint), turn = completed.turns[0];
    assert.equal(completed.turns.length, 1); assert.equal(turn.state, 'completed');
    assert.equal(completed.current_input_version_id, turn.input_version_id);
    assert.equal(turn.reply.input_budget.state, 'warning');
    const next = await f.request(`${endpoint}/inputs`, { expected_input_version_id: turn.input_version_id,
      content: { type: 'purpose_exploration', purpose_hint: '成功复验GET完成后另一客户端添加的合成讨论。' } });
    assert.notEqual(next.input_version_id, turn.input_version_id);
    await f.bridge.readSavedSession(f.scope);
    const observed = await f.bridge.getState();
    assert.equal(observed.savedSession.phase, 'ready');
    assert.equal(observed.savedSession.currentInputVersionId, next.input_version_id);
    assert.equal(observed.inputBudgetNotice, undefined);
    release(); await pending; f.delivery.after = undefined;
    const after = await f.bridge.getState();
    assert.equal(after.inputBudgetNotice, undefined);
    assert.deepEqual(after.savedSession, observed.savedSession);
    assert.deepEqual(after.candidateVersions, observed.candidateVersions);
    assert.equal(after.result, null); assert.equal(after.selectedCandidateId, null);
    assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false); assert.equal(after.errorCode, undefined);
    assert.equal(after.savedSession.turns[0].inputVersionId, turn.input_version_id);
    assert.equal(after.savedSession.turns[0].requestKey, turn.request_key);
    assert.equal(after.savedSession.turns[0].state, 'completed');
    assert.equal(after.savedSession.turns[0].reply.inputBudget.state, 'warning');
    assert.equal(after.savedSession.turns[0].input.content.draft_text, draft);
    assert.equal(after.savedSession.inputs.find((input) => input.inputVersionId === next.input_version_id).state, 'active');
    assert.equal(f.contacts.getState().draft, draft); assert.deepEqual(after.options, observed.options);
    assert.doesNotMatch(f.renderSession(after), /当前讨论已接近模型输入上限/);
    assert.equal((await f.command('metrics')).model_calls, 2);
  } finally { release(); await pending; f.delivery.after = undefined; }
});

async function heldSuccessfulBudgetVerification(t, warning = true) {
  const f = warning ? await limitedFixture(t) : await budgetPublicFixture(t);
  const scope = f.scope ?? await f.connect(), initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  f.contacts.setDraft({ ...scope, text: draft });
  await f.command('plan', { plan: { text: draft, count: 1 } });
  let release, entered, verificationRead = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const delivered = new Promise((resolve) => { entered = resolve; });
  f.delivery.after = async (request) => {
    if (request.method === 'POST' && request.path.endsWith('/replies')) verificationRead = true;
    else if (verificationRead && request.method === 'GET' && request.path === endpoint) {
      verificationRead = false; entered(); await gate;
    }
  };
  const pending = f.bridge.generate({ ...scope, newRequest: true });
  await delivered;
  return { ...f, scope, endpoint, pending, release, completed: await f.request(endpoint) };
}

test('成功预算复验GET被公开新CURRENT重读超越后ready回执也保持新视图', { skip: !enabled }, async (t) => {
  const f = await heldSuccessfulBudgetVerification(t, false);
  try {
    const turn = f.completed.turns[0];
    assert.equal(turn.state, 'completed'); assert.equal(turn.reply.input_budget.state, 'ready');
    assert.equal(f.completed.current_input_version_id, turn.input_version_id);
    const next = await f.request(`${f.endpoint}/inputs`, { expected_input_version_id: turn.input_version_id,
      content: { type: 'purpose_exploration', purpose_hint: 'ready成功复验后另一客户端添加的合成讨论。' } });
    await f.bridge.readSavedSession(f.scope);
    const observed = await f.bridge.getState();
    assert.equal(observed.savedSession.phase, 'ready');
    assert.equal(observed.savedSession.currentInputVersionId, next.input_version_id);
    f.release(); await f.pending;
    const after = await f.bridge.getState();
    assert.deepEqual(after.savedSession, observed.savedSession);
    assert.deepEqual(after.candidateVersions, observed.candidateVersions);
    assert.equal(after.result, null); assert.equal(after.selectedCandidateId, null);
    assert.equal(after.inputBudgetNotice, undefined); assert.equal(after.errorCode, undefined);
    assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
    assert.equal(after.savedSession.turns[0].reply.inputBudget.state, 'ready');
    assert.equal(f.contacts.getState().draft, draft); assert.deepEqual(after.options, observed.options);
    assert.equal((await f.command('metrics')).model_calls, 1);
  } finally { f.release(); await f.pending; f.delivery.after = undefined; }
});

test('成功预算复验GET被同CURRENT的较晚公开ready重读超越仍发布合法warning并保留完整视图', { skip: !enabled }, async (t) => {
  const f = await heldSuccessfulBudgetVerification(t);
  try {
    const turn = f.completed.turns[0];
    assert.equal(turn.state, 'completed'); assert.equal(turn.reply.input_budget.state, 'warning');
    await f.bridge.readSavedSession(f.scope);
    const observed = await f.bridge.getState();
    assert.equal(observed.savedSession.phase, 'ready');
    assert.equal(observed.savedSession.currentInputVersionId, turn.input_version_id);
    assert.equal(observed.inputBudgetNotice, undefined);
    f.release(); await f.pending;
    const after = await f.bridge.getState();
    assert.equal(after.phase, 'ready'); assert.equal(after.errorCode, undefined);
    assert.deepEqual(after.savedSession, observed.savedSession);
    assert.equal(after.inputBudgetNotice.decision.state, 'warning');
    assert.equal(after.inputBudgetNotice.inputVersionId, turn.input_version_id);
    assert.equal(after.inputBudgetNotice.requestKey, turn.request_key);
    assert.equal(after.result.replyRequestId, turn.reply.reply_request_id);
    assert.equal(after.result.inputVersionId, turn.input_version_id);
    assert.equal(after.result.candidates[0].original.text, draft);
    assert.match(f.renderSession(after), /当前讨论已接近模型输入上限/);
    assert.equal(f.contacts.getState().draft, draft); assert.deepEqual(after.options, observed.options);
    assert.equal((await f.command('metrics')).model_calls, 2);
  } finally { f.release(); await f.pending; f.delivery.after = undefined; }
});

test('成功预算复验GET迟到时较晚公开读取仍在loading则保留读取且暂不发布旧结果', { skip: !enabled }, async (t) => {
  const f = await heldSuccessfulBudgetVerification(t);
  let releaseRead, enteredRead, reading;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const delivered = new Promise((resolve) => { enteredRead = resolve; });
  try {
    const turn = f.completed.turns[0];
    assert.equal(turn.state, 'completed'); assert.equal(turn.reply.input_budget.state, 'warning');
    const next = await f.request(`${f.endpoint}/inputs`, { expected_input_version_id: turn.input_version_id,
      content: { type: 'purpose_exploration', purpose_hint: '成功复验期间尚未交付的新合成讨论。' } });
    f.delivery.after = async (request) => {
      if (request.method === 'GET' && request.path === f.endpoint) { enteredRead(); await gate; }
    };
    reading = f.bridge.readSavedSession(f.scope); await delivered;
    const observed = await f.bridge.getState();
    assert.equal(observed.savedSession.phase, 'loading');
    f.release(); await f.pending;
    const waiting = await f.bridge.getState();
    assert.deepEqual(waiting.savedSession, observed.savedSession);
    assert.equal(waiting.result, null); assert.equal(waiting.inputBudgetNotice, undefined);
    assert.equal(waiting.phase, 'idle'); assert.equal(waiting.canRetry, false); assert.equal(waiting.errorCode, undefined);
    releaseRead(); await reading; f.delivery.after = undefined;
    const after = await f.bridge.getState();
    assert.equal(after.savedSession.phase, 'ready');
    assert.equal(after.savedSession.currentInputVersionId, next.input_version_id);
    assert.equal(after.savedSession.turns[0].inputVersionId, turn.input_version_id);
    assert.equal(after.savedSession.turns[0].requestKey, turn.request_key);
    assert.equal(after.savedSession.turns[0].state, 'completed');
    assert.equal(after.savedSession.turns[0].reply.inputBudget.state, 'warning');
    assert.equal(after.result, null); assert.equal(after.inputBudgetNotice, undefined);
    assert.equal(after.phase, 'idle'); assert.equal(after.canRetry, false);
    assert.equal(f.contacts.getState().draft, draft); assert.deepEqual(after.options, observed.options);
    assert.equal((await f.command('metrics')).model_calls, 2);
  } finally { releaseRead(); f.release(); await reading; await f.pending; f.delivery.after = undefined; }
});
