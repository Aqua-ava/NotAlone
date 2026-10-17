import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

for (const laterRead of ['same-current', 'new-current', 'loading']) {
  test(`持续修改完成复验迟到时接纳较晚${laterRead}会话读取`, { timeout: 20_000 }, async (t) => {
    const f = await budgetPublicFixture(t), scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '只拒绝本次邀约。' });
    await f.command('plan', { plan: { count: 1, message_groups: [['这次先不参加。', '只说明本次。']] } });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
    let releaseCompletion, enterCompletion, releaseRead, enterRead;
    const completionGate = new Promise(resolve => { releaseCompletion = resolve; });
    const completionEntered = new Promise(resolve => { enterCompletion = resolve; });
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const readEntered = new Promise(resolve => { enterRead = resolve; });
    let awaitingCompletionRead = false, heldCompletion = false, heldLaterRead = false;
    f.delivery.after = async request => {
      if (request.method === 'POST' && request.path.endsWith('/continue')) awaitingCompletionRead = true;
      else if (request.method === 'GET' && request.path === endpoint) {
        if (awaitingCompletionRead && !heldCompletion) {
          heldCompletion = true; enterCompletion(); await completionGate;
        } else if (heldCompletion && laterRead === 'loading' && !heldLaterRead) {
          heldLaterRead = true; enterRead(); await readGate;
        }
      }
    };
    await f.command('plan', { plan: { count: 1, message_groups: [['本次不参加。', '只说明本次。']] } });
    const continuing = f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
    let reading;
    try {
      await completionEntered;
      const completed = await f.request(endpoint), turn = completed.turns.at(-1);
      assert.equal(turn.state, 'completed');
      let nextInput;
      if (laterRead !== 'same-current') {
        nextInput = await f.request(`${endpoint}/inputs`, {
          expected_input_version_id: turn.input_version_id,
          content: { type: 'purpose_exploration', purpose_hint: '另一客户端已推进的新讨论。' },
        });
      }
      reading = f.bridge.readSavedSession(scope);
      if (laterRead === 'loading') await readEntered;
      else await reading;
      const observed = await f.bridge.getState();
      assert.equal(observed.savedSession.phase, laterRead === 'loading' ? 'loading' : 'ready');
      releaseCompletion(); await continuing;
      const after = await f.bridge.getState();
      assert.deepEqual(after.savedSession, observed.savedSession, '迟到完成结论须保留较晚读取的完整展示状态。');
      if (laterRead === 'same-current') {
        assert.equal(after.continuation.phase, 'completed');
        assert.equal(after.result.replyRequestId, turn.reply.reply_request_id);
        assert.equal(after.result.inputVersionId, turn.input_version_id);
      } else {
        assert.notEqual(after.result?.replyRequestId, turn.reply.reply_request_id);
        assert.notEqual(after.continuation?.phase, 'completed');
        if (laterRead === 'new-current') assert.equal(after.savedSession.currentInputVersionId, nextInput.input_version_id);
      }
      releaseRead(); await reading;
      const final = await f.bridge.getState();
      assert.equal(final.savedSession.phase, 'ready');
      if (nextInput) assert.equal(final.savedSession.currentInputVersionId, nextInput.input_version_id);
      assert.equal((await f.command('metrics')).model_calls, 2, '交错读取不能追加生成或重放持续修改。');
    } finally {
      releaseCompletion(); releaseRead();
      await Promise.allSettled([continuing, reading]);
      f.delivery.after = undefined;
    }
  });
}

test('持续修改的完成复验接管较早读取，旧running快照不能挡住当前完成', { timeout: 20_000 }, async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '只拒绝本次邀约。' });
  await f.command('plan', { plan: { count: 1, message_groups: [['这次先不参加。', '只说明本次。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
  let releaseOld, enterOld, releaseCompletion, enterCompletion;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const oldEntered = new Promise(resolve => { enterOld = resolve; });
  const completionGate = new Promise(resolve => { releaseCompletion = resolve; });
  const completionEntered = new Promise(resolve => { enterCompletion = resolve; });
  let reads = 0;
  f.delivery.after = async request => {
    if (request.method === 'GET' && request.path === endpoint) {
      if (++reads === 1) { enterOld(); await oldGate; }
      else if (reads === 2) { enterCompletion(); await completionGate; }
    }
  };
  await f.command('plan', { plan: { count: 1, message_groups: [['本次不参加。', '只说明本次。']] } });
  await f.command('hold');
  const continuing = f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
  let reading;
  try {
    let entered = false;
    for (let count = 0; count < 100 && !entered; count++) {
      entered = (await f.command('metrics')).model_entered;
      if (!entered) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(entered, true, '持续修改须实际进入本轮模型。');
    reading = f.bridge.readSavedSession(scope); await oldEntered;
    assert.equal((await f.request(endpoint)).turns.at(-1).state, 'running');
    await f.command('release'); await completionEntered;
    const completed = await f.request(endpoint), turn = completed.turns.at(-1);
    assert.equal(turn.state, 'completed');
    releaseOld(); await reading;
    releaseCompletion(); await continuing;
    const final = await f.bridge.getState();
    assert.equal(final.continuation?.phase, 'completed');
    assert.equal(final.savedSession.turns.at(-1).state, 'completed');
    assert.equal(final.result.replyRequestId, turn.reply.reply_request_id);
    assert.equal(final.result.inputVersionId, turn.input_version_id);
    assert.equal((await f.command('metrics')).model_calls, 2);
  } finally {
    releaseOld(); releaseCompletion(); await f.command('release');
    await Promise.allSettled([continuing, reading]); f.delivery.after = undefined;
  }
});
