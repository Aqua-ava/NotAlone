import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { historicalReplyFixture, ports, renderSession } from './fixtures/historical-reply-basis.mjs';

function addExecutionView(f) {
  const versionId = randomUUID(), methodId = randomUUID();
  f.records.saved.turns[0].input.scene = '甲的精确场景';
  f.records.saved.turns[0].input.content.include_relationship_context = false;
  f.records.saved.turns[0].reply.used_skill = { skill_id: randomUUID(), version_id: versionId,
    name: '合成受范围约束策略', load_state: 'loaded', execution_view: {
      policy_revision: 3, method_ids: [methodId], sha256: 'a'.repeat(64) } };
  return { versionId, methodId };
}

test('保存讨论显示后端实际执行视图，政策变化只提示重新生成并保留历史正文', async () => {
  const f = await historicalReplyFixture();
  addExecutionView(f);
  const change = { evidence_id: f.records.saved.turns[0].reply.used_skill.version_id,
    kind: 'reply_skill', reason: 'skill_policy_changed' };
  f.records.saved.turns[0].basis_changes = [change];
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  const html = renderSession(state);
  for (const phrase of ['合成受范围约束策略', '允许1种做法', '用户已调整本范围的方法使用决定',
    '请先保留当前编辑并重新生成', '合成旧候选：先确认见面时间。']) assert(html.includes(phrase), phrase);
  assert.equal(f.calls.filter(request => request.method === 'POST' && !request.path.endsWith('/assistant-session/default')).length, 0);
});

test('隐藏联系人恢复重新读取政策提醒与实际视图，同时保留原场景、独立输入和用户候选编辑', async () => {
  const f = await historicalReplyFixture();
  const { versionId, methodId } = addExecutionView(f);
  const other = randomUUID();
  f.records.directory.push({ contactId: other, displayName: '合成反馈乙联系人', messageCount: 0, sourceCount: 0 });
  await f.contacts.refreshContacts();
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.updateScene({ ...f.scope, scene: '甲的精确场景' });
  f.contacts.setDraft({ ...f.scope, text: '甲独立草稿' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.equal((await f.bridge.getState()).phase, 'ready');
  assert.equal((await f.bridge.getState()).scene, '甲的精确场景');
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text: '甲在停用前编辑的候选' });
  f.contacts.selectContact({ contactId: other, scopeRevision: f.contacts.getState().scopeRevision });
  const otherScope = { contactId: other, scopeRevision: f.contacts.getState().scopeRevision };
  await f.bridge.updateScene({ ...otherScope, scene: '乙的独立场景' });
  f.contacts.setDraft({ ...otherScope, text: '乙独立草稿' });
  const change = { evidence_id: versionId, kind: 'reply_skill', reason: 'skill_policy_changed' };
  f.records.saved.turns[0].basis_changes = [change];
  f.records.history.basis_changes = [change];
  f.contacts.selectContact({ contactId: f.scope.contactId, scopeRevision: f.contacts.getState().scopeRevision });
  const returned = { contactId: f.scope.contactId, scopeRevision: f.contacts.getState().scopeRevision };
  await f.bridge.readSavedSession(returned);
  const state = await f.bridge.getState();
  assert.equal(state.scene, '甲的精确场景');
  assert.equal(f.contacts.getState().draft, '甲独立草稿');
  assert.equal(state.result.candidates[0].editedText, '甲在停用前编辑的候选');
  assert.deepEqual(state.result.usedSkill.executionView, { policyRevision: 3, methodIds: [methodId], sha256: 'a'.repeat(64) });
  assert.deepEqual(state.result.basisChanges, [{ evidenceId: versionId, kind: 'reply_skill', reason: 'skill_policy_changed' }]);
  const previousWindow = globalThis.window;
  globalThis.window = { notalone: { styleSamples: {}, expressionPreferences: {} } };
  try {
    const html = ports.renderToStaticMarkup(ports.createElement(ports.ReplyCandidates, { replies: { state, error: '' } }));
    assert.match(html, /甲在停用前编辑的候选/);
    assert.match(html, /已排除本范围停用方法/);
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
  assert.equal(f.calls.filter(request => request.method === 'POST' && request.path.endsWith('/replies')).length, 1);
});

test('停用后的原次重试保留请求键和用户编辑，明确重新生成才取得新的执行视图', async () => {
  const f = await historicalReplyFixture();
  const { versionId, methodId } = addExecutionView(f);
  f.contacts.setDraft({ ...f.scope, text: '当前独立草稿。' });
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.editCandidate({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text: '用户保留的候选编辑。' });
  const originalKey = f.records.saved.turns[0].request_key;
  const fallback = f.backend.requestJson, preparations = [], dispatches = [];
  f.backend.requestJson = async request => {
    if (request.path.endsWith('/replies/prepare')) {
      preparations.push(structuredClone(request.body));
      if (request.body.idempotency_key === originalKey) {
        throw new ports.BackendRequestFailure('response', 409, 'assistant_session_rejected', 'skill_policy_changed');
      }
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
      dispatches.push(structuredClone(request.body));
      const turn = f.records.saved.turns.at(-1);
      const reply = structuredClone(f.records.saved.turns[0].reply);
      reply.reply_request_id = randomUUID();
      reply.candidates[0].candidate_id = randomUUID();
      reply.used_skill.execution_view = { policy_revision: 4, method_ids: [methodId], sha256: 'b'.repeat(64) };
      Object.assign(turn, { state: 'completed', reply });
      Object.assign(f.records.history, { turn_id: turn.turn_id, candidate_id: reply.candidates[0].candidate_id,
        candidate_group_id: reply.reply_request_id, default_display_version_id: reply.candidates[0].candidate_id,
        versions: [{ ...f.records.history.versions[0], version_id: reply.candidates[0].candidate_id }] });
      return { generation: 7, data: { ...reply, session_id: f.sessionId, turn_id: turn.turn_id,
        input_version_id: turn.input_version_id, state: 'completed' } };
    }
    return fallback(request);
  };
  await f.bridge.generate({ ...f.scope, newRequest: false });
  assert.equal(preparations[0].idempotency_key, originalKey);
  assert.equal(dispatches.length, 0);
  assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '用户保留的候选编辑。');
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.notEqual(preparations[1].idempotency_key, originalKey);
  assert.equal(dispatches.length, 1);
  assert.deepEqual((await f.bridge.getState()).result.usedSkill, { name: '合成受范围约束策略', versionId,
    loadState: 'loaded', executionView: { policyRevision: 4, methodIds: [methodId], sha256: 'b'.repeat(64) } });
});
