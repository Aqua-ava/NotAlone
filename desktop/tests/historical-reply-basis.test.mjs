import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { historicalReplyFixture, ports, renderSession } from './fixtures/historical-reply-basis.mjs';

test('回看依据已修正的合法旧候选，保留正文并提示且不自动继续', async () => {
  const f = await historicalReplyFixture();
  const change = { evidence_id: f.memoryId, kind: 'confirmed_memory', reason: 'memory_revised' };
  f.records.saved.turns[0].basis_changes = [change];
  f.records.saved.inputs[0].basis_changes = [change];
  f.records.history.basis_changes = [change];
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '合成旧候选：先确认见面时间。');
  assert.equal(state.candidateVersions.items[0].phase, 'ready');
  const html = renderSession(state);
  assert.match(html, /合成旧候选：先确认见面时间。/);
  assert.match(html, /依据已变化/);
  assert.match(html, /记忆已修正、否决或替代/);
  assert(f.calls.every((request) => request.method === 'GET' || request.path.endsWith('/assistant-session/default')));
});

test('错误或原因不明的旧依据只供回看并提示重新生成', async () => {
  const f = await historicalReplyFixture();
  const change = { evidence_id: f.memoryId, kind: 'confirmed_memory', reason: 'memory_generation_forbidden' };
  f.records.saved.turns[0].basis_changes = [change];
  f.records.saved.inputs[0].basis_changes = [change];
  f.records.history.basis_changes = [change];
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  const html = renderSession(state);
  assert.match(html, /合成旧候选：先确认见面时间。/);
  assert.match(html, /依据已纠错或失效原因不明，仅可回看，请重新生成/);
  assert.doesNotMatch(html, /明确继续时将重新核验当前依据/);
});

test('已确认source_deleted的旧生成重试立即清缓存，读取失败也不恢复应删候选', async () => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '独立合成意图仍保留。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  f.records.failure = (request) => request.path.endsWith('/replies/prepare')
    ? new ports.BackendRequestFailure('response', 409, 'assistant_session_rejected', 'source_deleted')
    : request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? new ports.BackendRequestFailure('connection') : undefined;
  await f.bridge.generate({ ...f.scope, newRequest: false });
  const state = await f.bridge.getState();
  assert.equal(state.result, null);
  assert(!JSON.stringify(state.candidateVersions).includes('合成旧候选：先确认见面时间。'));
  assert.equal(f.contacts.getState().draft, '独立合成意图仍保留。');
});

test('明确继续确认来源删除时先撤下被引用旧候选，普通故障仍保留编辑', async () => {
  for (const failure of [new ports.BackendRequestFailure('response', 409, 'assistant_session_rejected', 'source_deleted'),
    new ports.BackendRequestFailure('response', 503, 'reply_unavailable', 'source_deleted'),
    new ports.BackendRequestFailure('response', 404, 'route_not_found')]) {
    const f = await historicalReplyFixture();
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '继续故障后独立保留的合成草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
      text: '继续故障前的合成候选编辑。' });
    f.records.failure = (request) => request.path.endsWith('/continue/prepare') ? failure
      : request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? new ports.BackendRequestFailure('connection') : undefined;
    await f.bridge.continueSession({ ...f.scope, sessionId: f.sessionId,
      instruction: '只缩短这次表达。', intentionUpdate: '当前意图仍然不作承诺。' });
    const state = await f.bridge.getState();
    if (failure.status === 409) {
      assert.equal(state.result, null);
      assert(!JSON.stringify(state.candidateVersions).includes('合成旧候选：先确认见面时间。'));
      assert(state.savedSession.turns.every((turn) => turn.input === null && turn.reply === null));
    } else assert.equal(state.result.candidates[0].editedText, '继续故障前的合成候选编辑。');
    assert.equal(f.contacts.getState().draft, '继续故障后独立保留的合成草稿。');
  }
});

test('迟到的明确删除响应仍撤下同来源候选，后续用户编辑不能复活已删正文', async () => {
  for (const operation of ['continue', 'retry']) {
    const f = await historicalReplyFixture();
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '迟到删除后独立保留的合成草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    let release, reached;
    const held = new Promise((resolve) => { reached = resolve; });
    const endpoint = operation === 'continue' ? '/continue/prepare' : '/replies/prepare';
    f.records.failure = (request) => request.path.endsWith(endpoint)
      ? new ports.BackendRequestFailure('response', 409, 'assistant_session_rejected', 'source_deleted')
      : request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? new ports.BackendRequestFailure('connection') : undefined;
    f.records.beforeFailure = (request) => request.path.endsWith(endpoint)
      ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
    const rejected = operation === 'continue'
      ? f.bridge.continueSession({ ...f.scope, sessionId: f.sessionId, instruction: '简短说明这次意图。' })
      : f.bridge.generate({ ...f.scope, newRequest: false });
    await held;
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
      text: '响应途中仍在修改的合成旧候选。' });
    release(); await rejected;
    const state = await f.bridge.getState();
    assert.equal(state.result, null);
    assert(!JSON.stringify(state.candidateVersions).includes('合成旧候选：先确认见面时间。'));
    assert.equal(f.contacts.getState().draft, '迟到删除后独立保留的合成草稿。');
  }
});

test('迟到的旧引用删除不能撤下新输入生成的独立候选及后续编辑', async () => {
  for (const operation of ['continue', 'retry']) {
    const f = await historicalReplyFixture();
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '旧轮合成草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    const oldKey = f.records.saved.turns[0].request_key;
    let release, reached;
    const held = new Promise((resolve) => { reached = resolve; });
    const oldRequest = (request) => operation === 'continue' ? request.path.endsWith('/continue/prepare')
      : request.path.endsWith('/replies/prepare') && request.body.idempotency_key === oldKey;
    f.records.failure = (request) => oldRequest(request)
      ? new ports.BackendRequestFailure('response', 409, 'assistant_session_rejected', 'source_deleted') : undefined;
    f.records.beforeFailure = (request) => oldRequest(request)
      ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
    const older = operation === 'continue'
      ? f.bridge.continueSession({ ...f.scope, sessionId: f.sessionId, instruction: '旧轮只缩短。' })
      : f.bridge.generate({ ...f.scope, newRequest: false });
    await held;
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
      text: '旧轮响应途中暂改的合成正文。' });
    const newRequestId = randomUUID(), newCandidateId = randomUUID(), newTurnId = randomUUID(), newInputId = randomUUID();
    f.records.saved.turns.push({ turn_id: newTurnId, input_version_id: newInputId, request_key: randomUUID(),
      state: 'completed', interruption_reason: null, placeholder: null, basis_changes: [],
      input: { content: { type: 'rewrite_draft', draft_text: '新轮独立手写的合成草稿。' } },
      reply: { reply_request_id: newRequestId, context_receipt: { evidence_ids: [] }, candidates: [{
        candidate_id: newCandidateId, text: '新输入的独立合成候选。', basis: '只参考新草稿。', citation_ids: [], risk_notes: [],
        messages: [{ message_id: randomUUID(), text: '新输入的独立合成候选。' }],
      }] } });
    f.records.saved.inputs.push({ ...f.records.saved.inputs[0], input_version_id: newInputId, turn_id: newTurnId });
    f.records.saved.current_input_version_id = newInputId;
    f.records.history = { ...f.records.history, turn_id: newTurnId, candidate_id: newCandidateId,
      candidate_group_id: newRequestId, default_display_version_id: newCandidateId, selected_version_id: null,
      versions: [{ version_id: newCandidateId, version_number: 0, parent_version_id: null, text: '新输入的独立合成候选。',
        messages: f.records.saved.turns.at(-1).reply.candidates[0].messages, requirements: null, created_at: '2026-10-14T02:00:00+00:00' }] };
    f.contacts.setDraft({ ...f.scope, text: '新轮独立手写的合成草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: newRequestId, candidateId: newCandidateId,
      text: '新候选的合成用户编辑仍保留。' });
    Object.assign(f.records.saved.turns[0], { state: 'redacted', input: null, reply: null,
      basis_changes: [], placeholder: '相关来源已删除' });
    Object.assign(f.records.saved.inputs[0], { state: 'redacted', content: null, basis_changes: [], placeholder: '相关来源已删除' });
    release(); await older;
    const state = await f.bridge.getState();
    assert.equal(state.result.replyRequestId, newRequestId);
    assert.equal(state.result.candidates[0].editedText, '新候选的合成用户编辑仍保留。');
    assert.equal(state.savedSession.currentInputVersionId, newInputId);
    assert(!JSON.stringify(state).includes('合成旧候选：先确认见面时间。'));
    assert.equal(f.contacts.getState().draft, '新轮独立手写的合成草稿。');
  }
});

test('预算拒绝的503和未知404复读只报告读取故障，不抹去合法旧候选与编辑', async () => {
  for (const readFailure of [new ports.BackendRequestFailure('response', 503, 'reply_unavailable', 'source_unavailable'),
    new ports.BackendRequestFailure('response', 404, 'route_not_found')]) {
    const f = await historicalReplyFixture();
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '预算复读故障后独立保留的合成草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
      text: '预算复读故障后保留的合成候选编辑。' });
    let budgetRejected = false;
    f.records.failure = (request) => {
      if (request.path.endsWith('/replies')) {
        budgetRejected = true;
        return new ports.BackendRequestFailure('response', 409, 'input_budget_exceeded', undefined, {
          state: 'exceeded', allowed: false, modelId: 'synthetic-basis-budget-v1', contextWindowTokens: 1000,
          inputTokens: 900, outputReserveTokens: 100, safetyMarginTokens: 100, totalTokens: 1100,
          measurementKind: 'approximate', measurementId: 'synthetic-basis-budget-counter-v1', reason: 'context_window_exceeded',
        });
      }
      return budgetRejected && request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? readFailure : undefined;
    };
    await f.bridge.generate({ ...f.scope, newRequest: true });
    const state = await f.bridge.getState();
    assert.equal(state.phase, 'failed');
    assert.equal(state.errorCode, 'unavailable');
    assert.equal(state.canRetry, true);
    assert.equal(state.result.candidates[0].editedText, '预算复读故障后保留的合成候选编辑。');
    assert(state.candidateVersions.items[0].history.versions.some((version) => version.text === '合成旧候选：先确认见面时间。'));
    assert.equal(f.contacts.getState().draft, '预算复读故障后独立保留的合成草稿。');
  }
});

test('已登记的历史依据页面入口先执行环境门禁，未激活Conda时不启动页面', () => {
  const environment = { ...process.env };
  delete environment.CONDA_DEFAULT_ENV; delete environment.CONDA_PREFIX;
  const result = spawnSync(process.execPath, ['scripts/test-pages.mjs', '--case', 'historical-reply-basis', '--timeout-seconds', '1'],
    { env: environment, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /page_test_environment/);
  assert(!result.stderr.includes('page_test_arguments'));
});

test('真实传输保留已确认source_deleted分类，撤下旧候选及恢复版本', async (t) => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '删除后仍保留的独立合成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const server = createServer((request, response) => {
    request.resume(); response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'assistant_session_rejected', reason: 'source_deleted' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new ports.JsonClient({ address: `127.0.0.1:${port}`, port, pid: process.pid, token: 'synthetic-basis-token' });
  t.after(async () => { client.cancelPending(); await new Promise((resolve) => server.close(resolve)); });
  let failure;
  try { await client.perform({ method: 'GET', path: `/api/contacts/${f.scope.contactId}/assistant-sessions/${f.sessionId}` }); }
  catch (error) { failure = error; }
  assert(failure instanceof ports.BackendRequestFailure);
  f.records.failure = (request) => request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? failure : undefined;
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.result, null);
  assert.deepEqual(state.candidateVersions.items, []);
  assert.equal(f.contacts.getState().draft, '删除后仍保留的独立合成草稿。');
});

test('携入的合法旧版本保留表达正文与时效提醒，读取不会自动生成', async () => {
  const f = await historicalReplyFixture();
  const carryId = randomUUID();
  f.records.saved.current_input_version_id = carryId;
  f.records.saved.inputs.push({ input_version_id: carryId, type: 'candidate_carry',
    conversation_binding_id: f.bindingId, turn_id: null, state: 'active', placeholder: null,
    basis_changes: [{ evidence_id: f.memoryId, kind: 'owner_memory', reason: 'memory_expired' }],
    content: { type: 'candidate_carry', metadata_version: 1, origin_owner_id: randomUUID(),
      origin_contact_id: f.scope.contactId, origin_binding_id: f.bindingId, origin_session_id: randomUUID(),
      origin_input_version_id: f.inputVersionId, origin_turn_id: f.turnId, origin_reply_request_id: f.requestId,
      origin_candidate_id: f.candidateId, origin_version_id: f.candidateId, origin_selection_id: randomUUID(),
      payload_sha256: 'a'.repeat(64), style_sample_ids: [],
      messages: [{ message_id: f.messageId, text: '合成携入旧编辑，仅作表达参考。' }] } });
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  const html = renderSession(state);
  assert.match(html, /合成携入旧编辑，仅作表达参考。/);
  assert.match(html, /本人资料：记忆有效期已结束/);
  assert(f.calls.every((request) => request.method === 'GET' || request.path.endsWith('/assistant-session/default')));
});

test('变化投影结构畸形时只报读取错误，保留合法当前编辑且不假装来源删除', async () => {
  for (const path of ['turn', 'input', 'reply', 'history', 'evidence']) {
    for (const malformed of [null, {}, [{ evidence_id: randomUUID(), kind: 'message', reason: 'memory_revised' }],
      [{ evidence_id: 'unknown', kind: 'confirmed_memory', reason: 'memory_expired' }],
      [{ evidence_id: randomUUID(), kind: 'confirmed_memory', reason: 'source_deleted' }],
      [{ evidence_id: randomUUID(), kind: 'confirmed_memory', reason: 'memory_time_changed', text: '不接收正文。' }]]) {
      const f = await historicalReplyFixture();
      await f.bridge.readSavedSession(f.scope);
      f.contacts.setDraft({ ...f.scope, text: '结构错误后保留的合成草稿。' });
      await f.bridge.generate({ ...f.scope, newRequest: true });
      await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
        text: '结构错误后保留的合成编辑。' });
      if (path === 'turn') f.records.saved.turns[0].basis_changes = malformed;
      if (path === 'input') f.records.saved.inputs[0].basis_changes = malformed;
      if (path === 'reply') f.records.saved.turns[0].reply.basis_changes = malformed;
      if (path === 'history') {
        f.records.history.basis_changes = malformed;
        await assert.rejects(f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId }));
      } else if (path === 'evidence') {
        f.records.evidence.basis_changes = malformed;
        await f.bridge.loadEvidence({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId });
        assert.equal((await f.bridge.getEvidenceState()).phase, 'failed');
      } else {
        await f.bridge.readSavedSession(f.scope);
        assert.equal((await f.bridge.getState()).savedSession.phase, 'failed');
      }
      assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '结构错误后保留的合成编辑。');
      assert.equal(f.contacts.getState().draft, '结构错误后保留的合成草稿。');
    }
  }
});

test('确认来源删除后，迟到依据读取和旧恢复缓存不能复活已删正文', async () => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '独立合成草稿仍保留。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  f.records.saved.turns[0].basis_changes = [{ evidence_id: f.memoryId, kind: 'confirmed_memory', reason: 'memory_revised' }];
  let release, reached;
  const held = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => request.path.endsWith('/evidence')
    ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
  const validating = f.replies.revalidateDeletedSource(f.scope.contactId);
  await held;
  Object.assign(f.records.saved.turns[0], { state: 'redacted', input: null, reply: null,
    basis_changes: [], placeholder: '相关来源已删除' });
  Object.assign(f.records.saved.inputs[0], { state: 'redacted', content: null, basis_changes: [], placeholder: '相关来源已删除' });
  f.records.saved.current_input_version_id = null;
  await f.bridge.readSavedSession(f.scope);
  release(); await validating;
  const state = await f.bridge.getState();
  assert.equal(state.result, null);
  assert.deepEqual(state.candidateVersions.items, []);
  assert.equal(f.contacts.getState().draft, '独立合成草稿仍保留。');
  assert(!JSON.stringify(state).includes('合成旧候选：先确认见面时间。'));
  const html = renderSession(state);
  assert.match(html, /相关来源已删除/);
  assert(!html.includes('依据已变化'));
});

test('明确继续的结果迟到时，不能覆盖随后修改的当前候选', async () => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '合成原生成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  let release, reached;
  const held = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => request.path.endsWith('/continue')
    ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
  const generating = f.bridge.continueSession({ ...f.scope, sessionId: f.sessionId,
    instruction: '第一条简短一点', intentionUpdate: '本次希望轻松说明，不作承诺。' });
  await held;
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
    text: '明确继续之后用户又写的合成编辑。' });
  release(); await generating;
  const state = await f.bridge.getState();
  assert.equal(state.result.replyRequestId, f.requestId);
  assert.equal(state.result.candidates[0].editedText, '明确继续之后用户又写的合成编辑。');
  assert.equal(state.continuation, undefined);
});

test('普通503、连接故障和未知404读取不能冒充来源删除或抹去当前编辑', async () => {
  for (const failure of [new ports.BackendRequestFailure('response', 503, 'assistant_session_read_failed', 'source_unavailable'),
    new ports.BackendRequestFailure('connection'), new ports.BackendRequestFailure('response', 404, 'route_not_found')]) {
    const f = await historicalReplyFixture();
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '合成生成草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId,
      text: '普通失败后保留的合成编辑。' });
    f.records.failure = (request) => request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? failure : undefined;
    await f.bridge.readSavedSession(f.scope);
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.phase, 'failed');
    assert.equal(state.result?.candidates[0].editedText, '普通失败后保留的合成编辑。');
    assert.equal(state.candidateVersions.items[0].history.versions[0].text, '合成旧候选：先确认见面时间。');
    assert.equal(f.contacts.getState().draft, '合成生成草稿。');
  }
});

test('较晚的依据变化读取更新提醒，保留当前草稿、要求和候选编辑', async () => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '合成原生成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const change = { evidence_id: f.memoryId, kind: 'confirmed_memory', reason: 'memory_expired' };
  f.records.saved.turns[0].basis_changes = [change];
  f.records.history.basis_changes = [change];
  let release, reached;
  const held = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => request.path.endsWith(`/assistant-sessions/${f.sessionId}`)
    ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
  const reading = f.bridge.readSavedSession(f.scope);
  await held;
  f.contacts.setDraft({ ...f.scope, text: '用户正在写的新合成草稿。' });
  await f.bridge.updateOptions({ ...f.scope, options: { tone: 'concise', instruction: '保留本次合成意图。', includeRelationshipContext: false } });
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text: '用户正在编辑的合成候选。' });
  release(); await reading;
  const state = await f.bridge.getState();
  assert.equal(state.result.candidates[0].editedText, '用户正在编辑的合成候选。');
  assert.equal(f.contacts.getState().draft, '用户正在写的新合成草稿。');
  assert.equal(state.options.instruction, '保留本次合成意图。');
  assert.deepEqual(state.result.basisChanges, [{ evidenceId: f.memoryId, kind: 'confirmed_memory', reason: 'memory_expired' }]);
});

test('当前候选和实际依据显示变化原因，生成时正文及时间仍是原快照', async () => {
  const f = await historicalReplyFixture();
  await f.bridge.readSavedSession(f.scope);
  const changes = ['memory_revised', 'memory_expired', 'memory_not_yet_valid', 'memory_time_changed']
    .map((reason) => ({ evidence_id: f.memoryId, kind: 'confirmed_memory', reason }));
  f.records.saved.turns[0].reply.basis_changes = changes;
  f.records.evidence.basis_changes = changes;
  f.contacts.setDraft({ ...f.scope, text: '合成当前草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  const state = await f.bridge.getState();
  assert.equal(state.phase, 'ready');
  assert.deepEqual(state.result.basisChanges.map((change) => change.reason),
    ['memory_revised', 'memory_expired', 'memory_not_yet_valid', 'memory_time_changed']);
  const selection = { ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId };
  await f.bridge.loadEvidence(selection);
  const evidence = await f.bridge.getEvidenceState();
  assert.equal(evidence.phase, 'ready');
  assert.equal(evidence.items[0].text, '合成当时资料：周末有空。');
  assert.equal(evidence.items[0].timing.recordedAt, null);
  const html = ports.renderToStaticMarkup(ports.createElement(ports.ReplyEvidence, {
    evidence: { state: evidence, error: '' }, selection, candidate: state.result.candidates[0].original,
    number: 1, waiting: false,
  }));
  for (const phrase of ['依据已变化', '记忆已修正、否决或替代', '记忆有效期已结束', '记忆当前尚未生效', '记忆时间信息已变化',
    '合成当时资料：周末有空。']) assert(html.includes(phrase), phrase);
});
