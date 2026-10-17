import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

for (const mode of ['reply_to_message', 'rewrite_draft']) test(`公开身份恢复${mode}完整编号版本与累计要求，只提交三UUID并保留未保存编辑`, (t) => exercise(mode, t));
test('恢复映射消息分页晚回时保留较晚完整读取的CURRENT，旧恢复不得覆盖新输入', (t) => exercise('reply_to_message', t, true));

async function exercise(mode, t, lateRead = false) {
  let release, arrived;
  const mappingRelease = new Promise((resolve) => { release = resolve; });
  const mappingArrived = new Promise((resolve) => { arrived = resolve; });
  t.after(() => release());
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  const intent = '本次不参加，不增加任何未来约定。';
  await f.bridge.setMode({ ...scope, mode });
  let target;
  if (mode === 'reply_to_message') {
    await f.bridge.loadMessages({ ...scope, older: false });
    target = (await f.bridge.getState()).messages.items[0];
    await f.bridge.selectMessage({ ...scope, messageId: target.messageId });
    await f.bridge.updateDirection({ ...scope, direction: intent });
    await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
    await f.bridge.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
  } else {
    f.contacts.setDraft({ ...scope, text: intent });
    await f.bridge.updateOptions({ ...scope, options: { tone: 'original', instruction: '自然一点', includeRelationshipContext: true } });
  }
  await f.command('plan', { plan: { count: 1, message_groups: [['旧合成第一条。', '旧合成第二条。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const first = await f.bridge.getState();
  assert.equal(first.phase, 'ready');
  const sessionId = first.savedSession.sessionId;
  const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
  const history = first.candidateVersions.items[0].history;
  const version = history.versions[0];
  const messages = version.messages.map((message, index) => ({ messageId: message.messageId, text: `已编辑完整组第${index + 1}条。` }));
  const selectedRequirement = mode === 'reply_to_message' ? '甲'.repeat(4096) : '不要承诺';
  await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
    parentVersionId: version.versionId, editKey: randomUUID(), messages, requirements: selectedRequirement });
  const selectedVersionId = (await f.bridge.getState()).candidateVersions.items[0].displayVersionId;
  const command = { idempotency_key: randomUUID(), expected_input_version_id: first.savedSession.currentInputVersionId,
    instruction: '第一条简短一点', displayed_group: { session_id: sessionId, candidate_group_id: history.candidateGroupId,
      candidates: [{ number: history.candidateNumber, candidate_id: history.candidateId, version_id: selectedVersionId }] },
    requirement_changes: [{ action: 'keep', previous: selectedRequirement }] };
  const prepared = await f.request(path + '/continue/prepare', command);
  // 改写带显式要求时另有一次保真审校；准备本身不调用模型。
  const initialModelCalls = mode === 'rewrite_draft' ? 2 : 1;
  assert.equal((await f.command('metrics')).model_calls, initialModelCalls);
  const stopped = await f.request(path + '/interrupt', { request_key: prepared.request_key, input_version_id: prepared.input_version_id });
  assert.equal(stopped.interruption_reason, 'app_quit');
  const before = await f.request(path);
  const original = before.turns.find((turn) => turn.turn_id === prepared.turn_id);
  const requirements = ['自然一点', selectedRequirement, '简短一点'];
  assert.equal(original.input.content.user_instruction, requirements.join('；'));
  assert.equal(original.input.continued_from_candidate_id, history.candidateId);
  if (mode === 'reply_to_message') {
    assert.equal(Array.from(original.input.content.user_instruction).length, 4106);
    await assert.rejects(f.request(path + '/replies/prepare', { contact_id: scope.contactId, idempotency_key: randomUUID(),
      content: original.input.content }), (error) => error instanceof f.BackendRequestFailure && error.status === 400);
  }
  await f.bridge.readSavedSession(scope);
  f.contacts.setDraft({ ...scope, text: '当前未保存草稿保持原样。' });
  await f.bridge.updateOptions({ ...scope, options: { tone: 'warm', instruction: '当前未保存选项。', includeRelationshipContext: false } });
  const editing = await f.bridge.getState();
  const submitted = []; let lost = false, recoveryExecuted = false, mappingHeld = false;
  f.delivery.after = async (options) => {
    if (lateRead && recoveryExecuted && options.path.startsWith(`/api/contacts/${scope.contactId}/messages`) && !mappingHeld) {
      mappingHeld = true; arrived(); await mappingRelease;
    }
    if (!options.path.startsWith(path + '/retry-interrupted')) return;
    submitted.push({ path: options.path, body: structuredClone(options.body) });
    if (options.path === path + '/retry-interrupted') recoveryExecuted = true;
    if (mode === 'rewrite_draft' && options.path === path + '/retry-interrupted' && !lost) {
      lost = true; throw new f.BackendRequestFailure('connection');
    }
  };
  await f.command('plan', { plan: { count: 1, message_groups: [['本次不参加。', '谢谢邀请。']] } });
  const retrying = f.bridge.retryInterruptedGeneration({ ...scope, sessionId, turnId: prepared.turn_id, inputVersionId: prepared.input_version_id });
  if (lateRead) {
    await mappingArrived;
    const restoredSnapshot = await f.request(path);
    const oldRecovered = restoredSnapshot.turns.at(-1);
    assert.equal(oldRecovered.state, 'completed');
    await f.command('plan', { plan: { count: 1, message_groups: [['较晚新输入的合成完成。']] } });
    const fresh = await f.request(path + '/replies', { contact_id: scope.contactId, idempotency_key: randomUUID(), skill_disabled: true,
      content: { type: 'reply_to_message', target_message_id: target.messageId, direction: '保持较晚新输入的本次拒绝。' } });
    await f.bridge.readSavedSession(scope);
    const accepted = (await f.bridge.getState()).savedSession;
    assert.equal(accepted.currentInputVersionId, fresh.input_version_id);
    release(); await retrying;
    const after = await f.bridge.getState();
    assert.equal(after.savedSession.phase, 'ready');
    assert.deepEqual(after.savedSession, accepted, '已接受的新CURRENT与完整turn快照必须保留。');
    assert.notEqual(after.result?.replyRequestId, oldRecovered.reply.reply_request_id, '迟到旧恢复不能成为当前候选。');
    assert.deepEqual(after.options, editing.options);
    assert.equal(f.contacts.getState().draft, '当前未保存草稿保持原样。');
    assert.equal((await f.command('metrics')).model_calls, 3);
    return;
  }
  await retrying;
  if (mode === 'rewrite_draft') {
    const failed = await f.bridge.getState();
    assert.equal(failed.phase, 'failed'); assert.equal(failed.canRetry, true);
    assert.equal((await f.command('metrics')).model_calls, 4);
    await f.bridge.generate({ ...scope, newRequest: false });
  }
  const after = await f.bridge.getState();
  assert.equal(after.phase, 'ready');
  assert.equal(after.result.input.mode, mode);
  assert.equal(after.result.input.userInstruction, requirements.join('；'));
  assert.equal(mode === 'rewrite_draft' ? after.result.input.draftText : after.result.input.direction, intent);
  assert.deepEqual(after.options, editing.options);
  assert.equal(f.contacts.getState().draft, '当前未保存草稿保持原样。');
  assert.equal(submitted.length, mode === 'rewrite_draft' ? 4 : 2);
  assert.equal(new Set(submitted.map((item) => JSON.stringify(item.body))).size, 1);
  for (const item of submitted) {
    assert.deepEqual(Object.keys(item.body).sort(), ['original_input_version_id', 'original_turn_id', 'request_key']);
    assert.equal(item.body.original_turn_id, prepared.turn_id);
    assert.equal(item.body.original_input_version_id, prepared.input_version_id);
    assert.notEqual(item.body.request_key, prepared.request_key);
  }
  const completed = await f.request(path);
  const restored = completed.turns.find((turn) => turn.input_version_id === after.result.inputVersionId);
  assert.equal(restored.state, 'completed');
  assert.equal(completed.turns.length, 3);
  assert.deepEqual(restored.input, { ...original.input, continuation: { ...original.input.continuation,
    recovery: { original_turn_id: original.turn_id, original_input_version_id: original.input_version_id } } });
  assert.deepEqual(completed.turns.find((turn) => turn.turn_id === original.turn_id), original);
  assert.equal(completed.current_input_version_id, restored.input_version_id);
  const payload = (await f.command('model-inputs')).at(-1);
  assert.equal(payload.fidelity_contract.current_intent.text, intent);
  assert.equal(payload.user_instruction, requirements.join('；'));
  assert.equal(payload.continuation_reference.version_id, selectedVersionId);
  assert.equal(payload.continuation_reference.weight, 'low');
  assert.equal(payload.continuation_reference.is_current_draft, false);
  assert.deepEqual(payload.continuation_reference.messages.map((message) => message.text), messages.map((message) => message.text));
  const metrics = await f.command('metrics');
  assert.equal(metrics.payloads.length, 2, '同键重放不得重复执行候选生成。');
  assert.equal(metrics.model_calls, mode === 'rewrite_draft' ? 4 : 2);
}
