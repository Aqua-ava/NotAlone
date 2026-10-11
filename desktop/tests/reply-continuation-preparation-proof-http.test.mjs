import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('B10真实零领取澄清在关闭小窗后仍收口准备身份且不发布迟到界面', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '仅拒绝本次合成邀约。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
  await f.command('plan', { plan: { count: 1, message_groups: [['本次不参加。', '谢谢邀请。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const sessionId = before.savedSession.sessionId;
  const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
  const original = await f.request(path);
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.delivery.after = async (request) => {
    if (request.path === path + '/continue/prepare') { entered(); await gate; }
  };
  const continuing = f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条正式一点' });
  try {
    await reached;
    assert.equal((await f.bridge.getState()).continuation.phase, 'waiting');
    f.replies.notifyHelperLifecycle('closed');
  } finally { release(); await continuing; f.delivery.after = undefined; }
  const after = await f.bridge.getState();
  assert.equal(after.continuation, undefined);
  assert.equal(after.result.replyRequestId, before.result.replyRequestId);
  assert.deepEqual(await f.request(path), original);
  assert.equal((await f.command('metrics')).model_calls, 1);
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  await assert.doesNotReject(f.replies.beginGenerationClosing(async () => {
    throw new Error('实际零领取澄清不得调用中断或制造五字段回执。');
  }));
});

test('B10真实删除来源后的四字段未领取证明收口当前准备且不伪造中断', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
  await f.bridge.loadMessages({ ...scope, older: false });
  await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
  await f.bridge.updateDirection({ ...scope, direction: '只拒绝本次合成邀约。' });
  await f.command('plan', { plan: { count: 1, message_groups: [['删除前的合成说法。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState(), sessionId = before.savedSession.sessionId;
  const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
  const sourceId = (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources[0].source_id;
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
  const originalRequest = f.backend.requestJson;
  let proof, actualRequestKey;
  f.backend.requestJson = async (request) => {
    try { return await originalRequest(request); }
    catch (error) {
      if (request.path === path + '/continue/prepare') {
        proof = error.noGeneration; actualRequestKey = request.body.idempotency_key;
      }
      throw error;
    }
  };
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
  assert.deepEqual(proof, { contactId: scope.contactId, sessionId, requestKey: actualRequestKey, state: 'not_reserved' });
  assert(Object.isFrozen(proof));
  const after = await f.bridge.getState(), saved = await f.request(path);
  assert.equal(after.result, null); assert.equal(after.savedSession.currentInputVersionId, null);
  assert.equal(JSON.stringify(after).includes('删除前的合成说法。'), false);
  assert.equal(saved.current_input_version_id, null); assert.equal(saved.turns.length, 1);
  assert.equal(saved.turns[0].state, 'redacted');
  assert.equal(saved.turns[0].input, null); assert.equal(saved.turns[0].reply, null);
  assert.equal((await f.command('metrics')).model_calls, 1);
  await assert.doesNotReject(f.replies.beginGenerationClosing(async () => {
    throw new Error('可靠未领取证明不得伪造生成中断。');
  }));
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
});
