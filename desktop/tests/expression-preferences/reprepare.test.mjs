import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { historicalReplyFixture, ports } from '../fixtures/historical-reply-basis.mjs';

// 仅控制传输边界，实际Main/preload/React不使用HTTP、数据库或模型。
async function changingPreference(previous = false) {
  const f = await historicalReplyFixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await f.bridge.readSavedSession(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '用户明确保留的独立草稿。' });
  if (previous) {
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text: '用户已编辑的合法旧候选。' });
  } else Object.assign(f.records.saved, { turns: [], inputs: [], current_input_version_id: null });
  const change = { revision: 1, active: false, sealed: false, removed: false, checks: [], prepares: [], generations: [] };
  const preferenceId = randomUUID(), fallback = f.backend.requestJson;
  f.backend.requestJson = async (request) => {
    if (request.path.endsWith('/preparation-format')) {
      change.checks.push(request.body);
      const turn = f.records.saved.turns.find((item) => item.request_key === request.body.request_key);
      const format = change.active === true ? 'generation_running' : change.active === undefined ? 'generation_unconfirmed' : 'reprepare_required';
      if (format === 'reprepare_required') { change.sealed = true; turn.state = 'failed'; }
      return { generation: 7, data: { session_id: f.sessionId, turn_id: turn.turn_id,
        input_version_id: turn.input_version_id, request_key: turn.request_key, state: turn.state, format_status: format } };
    }
    if (request.path.endsWith('/replies/prepare')) {
      change.prepares.push({ ...structuredClone(request.body), revision: change.revision });
      const turn = { turn_id: randomUUID(), input_version_id: randomUUID(), request_key: request.body.idempotency_key,
        state: 'running', input: { content: request.body.content }, reply: null, placeholder: null, interruption_reason: null };
      f.records.saved.turns.push(turn);
      f.records.saved.inputs.push({ input_version_id: turn.input_version_id, type: 'generation', conversation_binding_id: f.bindingId,
        turn_id: turn.turn_id, state: 'active', content: null, placeholder: null });
      f.records.saved.current_input_version_id = turn.input_version_id;
      return { generation: 7, data: { session_id: f.sessionId, turn_id: turn.turn_id,
        input_version_id: turn.input_version_id, request_key: turn.request_key, state: 'running' } };
    }
    if (request.path.endsWith('/replies')) {
      change.generations.push(structuredClone(request.body));
      const turn = f.records.saved.turns.find((item) => item.request_key === request.body.idempotency_key);
      if (change.generations.length === 1) {
        entered.resolve(); await release.promise;
        turn.state = change.removed ? 'redacted' : 'failed';
        if (change.removed) { turn.input = null; turn.placeholder = '相关来源已删除'; }
        else { turn.requires_reprepare = true; if (change.active !== undefined) turn.generation_active = change.active; }
        throw new ports.BackendRequestFailure('response', 409,
          change.removed ? 'reply_input_invalidated' : 'expression_preferences_changed');
      }
      const candidateId = randomUUID(), requestId = randomUUID(), messageId = randomUUID();
      const candidate = { candidate_id: candidateId, text: '使用新偏好的合成候选。', basis: '本次明确输入。', citation_ids: [], risk_notes: [],
        messages: [{ message_id: messageId, text: '使用新偏好的合成候选。' }] };
      const reply = { reply_request_id: requestId, candidates: [candidate], context_receipt: { evidence_ids: [],
        expression_preference_ids: change.removed ? [] : [preferenceId], expression_preferences: change.removed ? [] : [{
          preference_id: preferenceId, revision: change.revision, text: '明确修改的新合成偏好。', scope: { contact_id: null, reply_mode: null } }] } };
      Object.assign(turn, { state: 'completed', reply });
      f.records.history = { session_id: f.sessionId, turn_id: turn.turn_id, candidate_id: candidateId, candidate_group_id: requestId,
        candidate_number: 1, default_display_version_id: candidateId, selected_version_id: null, versions: [{ version_id: candidateId,
          version_number: 0, parent_version_id: null, text: candidate.text, messages: candidate.messages, requirements: null, created_at: '2026-10-16T01:00:00Z' }] };
      return { generation: 7, data: { ...reply, session_id: f.sessionId, turn_id: turn.turn_id, input_version_id: turn.input_version_id, state: 'completed' } };
    }
    if (request.method === 'GET' && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
      if (change.readFailure) throw new ports.BackendRequestFailure('connection');
      const turn = f.records.saved.turns.at(-1);
      if (turn?.requires_reprepare) { if (change.active === undefined) delete turn.generation_active; else turn.generation_active = change.active; }
      return { generation: 7, data: structuredClone(f.records.saved) };
    }
    return fallback(request);
  };
  const candidates = async () => {
    const before = globalThis.window;
    try {
      globalThis.window = { notalone: { candidateProvenance: {} } };
      return ports.renderToStaticMarkup(ports.createElement(ports.ReplyCandidates, { replies: { state: await f.bridge.getState() } }));
    } finally { globalThis.window = before; }
  };
  return { ...f, change, entered, release, candidates };
}

test('首次无候选偏好变更拒绝旧快照，明确核对封键后新prepare保留草稿并使用新revision', async () => {
  const f = await changingPreference();
  const pending = f.bridge.generate({ ...f.scope, newRequest: false }); await f.entered.promise;
  f.change.revision = 2; f.release.resolve(); await pending;
  const failed = await f.bridge.getState();
  assert.equal(failed.errorCode, 'prepared_context_reprepare_required');
  assert.equal(failed.canRetry, false); assert.equal(failed.result, null);
  assert.match(await f.candidates(), /核对旧准备并重新生成/);
  assert.equal(f.change.prepares.length, 1); assert.equal(f.change.generations.length, 1);
  assert.equal(f.contacts.getState().draft, '用户明确保留的独立草稿。');
  await f.bridge.generate({ ...f.scope, newRequest: false }); assert.equal(f.change.prepares.length, 1);
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.equal(f.change.sealed, true); assert.equal(f.change.checks.length, 1); assert.equal(f.change.prepares.length, 2);
  assert.equal(f.change.prepares[1].revision, 2); assert.notEqual(f.change.prepares[0].idempotency_key, f.change.prepares[1].idempotency_key);
  assert.equal(f.change.prepares[1].expected_input_version_id, f.change.checks[0].input_version_id);
  assert.equal((await f.bridge.getState()).result.expressionPreferences[0].revision, 2);
});

test('偏好变更后的活作业和未知租约不可遗弃，隐藏恢复只读，终态核实后才能新prepare', async () => {
  const f = await changingPreference(); f.change.active = true;
  const pending = f.bridge.generate({ ...f.scope, newRequest: true }); await f.entered.promise;
  f.change.revision = 2; f.release.resolve(); await pending;
  assert.equal((await f.bridge.getState()).errorCode, 'prepared_context_running');
  assert.equal((await f.bridge.getState()).generationJobs.at(-1).phase, 'failed');
  await f.bridge.generate({ ...f.scope, newRequest: true }); assert.equal(f.change.prepares.length, 1); assert.equal(f.change.sealed, false);
  f.change.active = undefined; f.replies.notifyHelperLifecycle('hidden'); f.replies.notifyHelperLifecycle('focused');
  await f.bridge.readSavedSession(f.scope); assert.equal((await f.bridge.getState()).errorCode, 'prepared_context_unconfirmed');
  await f.bridge.generate({ ...f.scope, newRequest: true }); assert.equal(f.change.prepares.length, 1); assert.equal(f.change.sealed, false);
  f.change.active = false; await f.bridge.readSavedSession(f.scope);
  await f.bridge.generate({ ...f.scope, newRequest: true }); assert.equal(f.change.sealed, true); assert.equal(f.change.prepares.length, 2);
});

test('已有候选的偏好变更晚失败与隐藏恢复保留用户编辑和草稿，不自动生成', async () => {
  const f = await changingPreference(true);
  const pending = f.bridge.generate({ ...f.scope, newRequest: true }); await f.entered.promise;
  f.change.revision = 2; f.replies.notifyHelperLifecycle('hidden'); f.release.resolve(); await pending;
  f.replies.notifyHelperLifecycle('focused'); await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState(); assert.equal(state.errorCode, 'prepared_context_reprepare_required');
  assert.equal(state.result.candidates[0].editedText, '用户已编辑的合法旧候选。');
  assert.equal(f.contacts.getState().draft, '用户明确保留的独立草稿。'); assert.equal(f.change.prepares.length, 1);
  await f.bridge.generate({ ...f.scope, newRequest: true }); assert.equal(f.change.prepares.length, 2); assert.equal(f.change.prepares[1].revision, 2);
});

test('首次无候选删除偏好时旧返回不能恢复，结算保留草稿，明确生成采用新key', async () => {
  const f = await changingPreference();
  const pending = f.bridge.generate({ ...f.scope, newRequest: true }); await f.entered.promise;
  f.replies.beginExpressionPreferenceDeletion(); f.change.removed = true; f.release.resolve(); await pending;
  const turn = f.records.saved.turns.at(-1), input = f.records.saved.inputs.find((item) => item.turn_id === turn.turn_id);
  Object.assign(input, { state: 'redacted', placeholder: '相关来源已删除' });
  await f.replies.revalidateExpressionPreferences();
  assert.equal((await f.bridge.getState()).result, null); assert.equal(f.contacts.getState().draft, '用户明确保留的独立草稿。');
  assert.equal(f.change.generations.length, 1);
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.generate({ ...f.scope, newRequest: false }); assert.equal(f.change.prepares.length, 2);
  assert.notEqual(f.change.prepares[0].idempotency_key, f.change.prepares[1].idempotency_key);
  assert.deepEqual((await f.bridge.getState()).result.expressionPreferences, []);
});

test('偏好拒绝后终态读取故障保留作业身份，普通按钮不能绕过，明确核对恢复后才新prepare', async () => {
  const f = await changingPreference();
  const pending = f.bridge.generate({ ...f.scope, newRequest: false }); await f.entered.promise;
  f.change.revision = 2; f.change.readFailure = true; f.release.resolve(); await pending;
  assert.equal((await f.bridge.getState()).errorCode, 'prepared_context_unconfirmed');
  assert.equal((await f.bridge.getState()).canRetry, false);
  assert.equal((await f.bridge.getState()).generationJobs.length, 1);
  await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: false }), /核对当前助手会话/);
  await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true }), /核对当前助手会话/);
  assert.equal(f.change.prepares.length, 1); assert.equal(f.change.sealed, false);
  f.change.readFailure = false;
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.equal(f.change.prepares.length, 2); assert.equal(f.change.sealed, true);
});
