import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('B10回应消息连续修改捕获当前显示的第二组编辑版本，保留原要求与整组身份', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
  await f.bridge.loadMessages({ ...scope, older: false });
  const message = (await f.bridge.getState()).messages.items[0];
  await f.bridge.selectMessage({ ...scope, messageId: message.messageId });
  await f.bridge.updateDirection({ ...scope, direction: '拒绝本次邀约。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
  await f.command('plan', { plan: { count: 2, message_groups: [
    ['第一组只说明本次立场。'], ['第二组第一条合成说法。', '第二组第二条合成说法。'],
  ] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const initial = await f.bridge.getState();
  const sessionId = initial.savedSession.sessionId;
  const second = initial.candidateVersions.items[1].history;
  assert(second);
  const parent = second.versions[0];
  await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: second.candidateId,
    parentVersionId: parent.versionId, editKey: randomUUID(),
    messages: parent.messages.map((message, index) => ({ messageId: message.messageId,
      text: `第二组编辑版第${index + 1}条。` })), requirements: '不要承诺' });
  const edited = (await f.bridge.getState()).candidateVersions.items[1];
  const displayed = edited.displayVersionId;
  assert.notEqual(displayed, parent.versionId);
  await f.command('plan', { plan: { count: 1, message_groups: [['继续后保留拒绝。', '不增加承诺。']] } });
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第二条简短一点' });
  const after = await f.bridge.getState();
  assert.equal(after.continuation.phase, 'completed');
  assert.deepEqual(after.continuation.effectiveRequirements, ['自然一点', '不要承诺', '简短一点']);
  const persisted = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(persisted.turns.length, 2);
  const continued = persisted.turns[1];
  assert.equal(continued.state, 'completed');
  assert.equal(continued.input.continuation.candidate_id, second.candidateId);
  assert.equal(continued.input.continuation.version_id, displayed);
  assert.equal(continued.input.continuation.candidate_group_id, second.candidateGroupId);
  assert.equal(continued.input.content.type, 'reply_to_message');
  assert.equal(continued.input.content.direction, '拒绝本次邀约。');
  assert.equal(continued.input.content.target_message_id, message.messageId);
  assert.equal('draft_text' in continued.input.content, false);
  const payload = (await f.command('metrics')).payloads.at(-1);
  assert.equal(payload.confirmed_direction, '拒绝本次邀约。');
  assert.deepEqual(payload.continuation_reference.messages.map((item) => item.text),
    ['第二组编辑版第1条。', '第二组编辑版第2条。']);
  assert.equal(payload.continuation_reference.version_id, displayed);
  assert.equal(payload.continuation_reference.is_current_draft, false);
  assert.equal(continued.input.content.user_instruction, '自然一点；不要承诺；简短一点');
  assert.equal(persisted.current_input_version_id, continued.input_version_id);
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('B10主动路径的冲突先澄清且零候选调用，明确替换后仍显示完整消息组', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '拒绝本次邀约。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '自然一点；不要承诺' });
  await f.command('plan', { plan: { count: 1, message_groups: [['这次先不参加。', '只说明本次的立场。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const initial = await f.bridge.getState();
  const sessionId = initial.savedSession.sessionId;
  const expectedInputVersionId = initial.savedSession.currentInputVersionId;
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条正式一点' });
  const clarification = (await f.bridge.getState()).continuation;
  assert.equal(clarification.phase, 'clarification');
  assert.equal(clarification.clarification.reason, 'requirements_conflict');
  assert.deepEqual(clarification.clarification.requirement_options, [
    { requirement: '自然一点', origin: 'existing', actions: ['keep', 'replace', 'remove'] },
  ]);
  const unchanged = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(unchanged.current_input_version_id, expectedInputVersionId);
  assert.equal(unchanged.turns.length, 1);
  assert.equal((await f.command('metrics')).model_calls, 1);
  await f.command('plan', { plan: { count: 1, message_groups: [['本次无法参加。', '没有未来承诺。']] } });
  await f.bridge.confirmContinuation({ ...scope, sessionId, expectedInputVersionId,
    requirementChanges: [{ action: 'replace', previous: '自然一点', replacement: '正式一点' }] });
  const after = await f.bridge.getState();
  assert.equal(after.continuation.phase, 'completed');
  assert.deepEqual(after.continuation.effectiveRequirements, ['正式一点', '不要承诺']);
  assert.equal(after.mode, 'initiate_conversation');
  assert.equal(after.purpose, '拒绝本次邀约。');
  assert.equal(after.candidateVersions.items.at(-1).history.versions[0].messages.length, 2);
  const markup = f.renderCandidates(after);
  assert.match(markup, /本组版本/);
  assert.match(markup, /原始版本/);
  assert.doesNotMatch(markup, /正在读取本组版本/);
  assert.match(markup, /本次无法参加。/);
  assert.match(markup, /没有未来承诺。/);
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('B10同一命令多步澄清保留已确认要求，并按来源覆盖本次选择', async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '拒绝本次邀约。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '自然一点；不要承诺；保留称呼' });
  await f.command('plan', { plan: { count: 1, message_groups: [['这次先不参加。', '只说明本次立场。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
  const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
  const saved = await f.request(path), expectedInputVersionId = saved.current_input_version_id;
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条正式一点',
    requirementChanges: [{ action: 'keep', previous: ' \u0085 自然一点 \u0085 ' }] });
  let clarification = (await f.bridge.getState()).continuation;
  assert.equal(clarification.phase, 'clarification');
  assert.deepEqual(clarification.clarification.requirement_options.map(item => item.requirement), ['保留称呼']);
  await f.bridge.confirmContinuation({ ...scope, sessionId, expectedInputVersionId,
    requirementChanges: [{ action: 'keep', previous: '保留称呼' }] });
  clarification = (await f.bridge.getState()).continuation;
  assert.equal(clarification.phase, 'clarification');
  assert.equal(clarification.clarification.reason, 'requirements_conflict');
  assert.deepEqual(clarification.clarification.requirement_options.map(item => item.requirement), ['自然一点']);
  assert.deepEqual(await f.request(path), saved, '澄清不能领取新一轮或修改当前输入。');
  assert.equal((await f.command('metrics')).model_calls, 1);
  await f.command('plan', { plan: { count: 1, message_groups: [['本次无法参加。', '感谢这次邀请。']] } });
  await f.bridge.confirmContinuation({ ...scope, sessionId, expectedInputVersionId,
    requirementChanges: [{ action: 'replace', previous: '自然一点', replacement: '正式一点' }] });
  const after = await f.bridge.getState(), persisted = await f.request(path);
  assert.equal(after.continuation.phase, 'completed');
  assert.deepEqual(after.continuation.effectiveRequirements, ['正式一点', '不要承诺', '保留称呼']);
  assert.deepEqual(persisted.turns[1].input.continuation.submission.requirement_changes, [
    { action: 'replace', previous: '自然一点', replacement: '正式一点' },
    { action: 'keep', previous: '保留称呼' },
  ]);
  assert.equal(persisted.turns.length, 2);
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('B10持续修改真实完成响应丢失后用原键原正文重试，不产生第三次模型', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '拒绝本次邀约。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
  await f.command('plan', { plan: { count: 1, message_groups: [['初次合成立场。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  const bodies = [];
  let lost = false;
  f.delivery.after = (options) => {
    if (options.path.endsWith('/continue') || options.path.endsWith('/continue/prepare')) bodies.push(JSON.stringify(options.body));
    if (options.path.endsWith('/continue') && !lost) { lost = true; throw new f.BackendRequestFailure('connection'); }
  };
  await f.command('plan', { plan: { count: 1, message_groups: [['短一些的合成立场。', '只说明本次。']] } });
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
  const failed = await f.bridge.getState();
  assert.equal(failed.continuation.phase, 'failed');
  assert.equal(failed.continuation.canRetry, true);
  const completed = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(completed.turns.at(-1).state, 'completed');
  assert.equal((await f.command('metrics')).model_calls, 2);
  await f.bridge.retryContinuation({ ...scope, sessionId });
  const retried = await f.bridge.getState();
  assert.equal(retried.continuation.phase, 'completed');
  assert.equal(retried.result.replyRequestId, completed.turns.at(-1).reply.reply_request_id);
  assert.equal(retried.result.inputVersionId, completed.current_input_version_id);
  assert.equal((await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`)).turns.length, 2);
  assert.equal(bodies.length, 4);
  assert.equal(new Set(bodies).size, 1);
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('B10公开候选区提供继续和改口控件，新要求澄清必须显式选择且零领取可退出', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '合成本次目的。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
  await f.command('plan', { plan: { count: 1, message_groups: [['不添加事实的合成表达。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const initial = await f.bridge.getState();
  const markup = f.renderCandidates(initial);
  assert.match(markup, /继续修改要求/);
  assert.match(markup, /本次改口/);
  await f.bridge.continueSession({ ...scope, sessionId: initial.savedSession.sessionId, instruction: '第一条合成未知表达要求' });
  const clarified = await f.bridge.getState();
  assert.equal(clarified.continuation.phase, 'clarification');
  assert.deepEqual(clarified.continuation.clarification.requirement_options, [
    { requirement: '合成未知表达要求', origin: 'new', actions: ['add'] },
  ]);
  const pendingMarkup = f.renderCandidates(clarified);
  assert.match(pendingMarkup, /请选择处理方式/);
  assert.match(pendingMarkup, /<button[^>]*disabled[^>]*>确认本次要求<\/button>/);
  assert.equal((await f.command('metrics')).model_calls, 1);
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  await f.replies.beginGenerationClosing(async () => { throw new Error('正式零领取澄清不得伪造中断身份。'); });
});

test('B10来源已实际删除后提交旧展示组，拒绝且立即重新读取无正文投影', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
  await f.bridge.loadMessages({ ...scope, older: false });
  await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
  await f.bridge.updateDirection({ ...scope, direction: '拒绝本次邀约。' });
  await f.command('plan', { plan: { count: 1, message_groups: [['即将删除来源的合成候选。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const sources = await f.request(`/api/contacts/${scope.contactId}/sources`);
  const sourceId = sources.sources[0].source_id;
  await f.request(`/api/contacts/${scope.contactId}/sources/${sourceId}`, undefined, 'DELETE');
  const deadline = Date.now() + 10000;
  let deleted = false;
  while (Date.now() < deadline) {
    const source = (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources.find((item) => item.source_id === sourceId);
    assert.notEqual(source.task_status, 'failed');
    if (source.status === 'deleted' && source.task_status === 'succeeded') { deleted = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(deleted, true);
  await f.bridge.continueSession({ ...scope, sessionId: before.savedSession.sessionId, instruction: '第一条自然一点' });
  const after = await f.bridge.getState();
  assert.equal(after.result, null);
  assert.equal(after.continuation, undefined);
  assert.equal(after.savedSession.currentInputVersionId, null);
  assert.equal(after.savedSession.turns[0].state, 'redacted');
  assert.equal(after.savedSession.turns[0].input, null);
  assert.equal(after.savedSession.turns[0].reply, null);
  assert.equal(JSON.stringify(after).includes('即将删除来源的合成候选。'), false);
  assert.equal((await f.command('metrics')).model_calls, 1);
});
