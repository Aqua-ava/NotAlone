import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, withMessageOptInFixture } from './fixtures/reply-message-opt-in-public.mjs';

test('同键恢复完成后的版本读取仍在等待时，新生成不替换已完成任务', { timeout: 15_000 }, async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    f.contacts.setDraft({ ...scope, text: '合成草稿：稍后回复。' });
    await f.fixture.plan({ fault: 'timeout' });
    await f.bridge.generate({ ...scope, newRequest: true });
    assert.equal((await f.bridge.getState()).errorCode, 'timeout');

    let held = false;
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    f.delivery.after = async (request) => {
      if (!held && request.method === 'GET' && /\/candidates\/[a-f0-9-]+\/versions/.test(request.path)) {
        held = true;
        await released;
      }
    };
    let recovering;
    try {
      await f.fixture.plan({ count: 1, text: '同键恢复后的合成候选。' });
      recovering = f.bridge.generate({ ...scope, newRequest: false });
      await eventually(() => f.bridge.getState(), (state) => state.phase === 'ready' && held,
        '恢复后的实际候选须已可见，版本读取仍由接缝持有。');
      const before = f.requests.length;
      await f.fixture.plan({ count: 1, text: '新的合成候选。' });
      await f.bridge.generate({ ...scope, newRequest: true });
      const requests = f.requests.slice(before);
      assert(!requests.some((request) => request.path.endsWith('/replace/prepare')),
        '已经可靠完成的旧生成不能被当作在途替换目标。');
      assert(requests.some((request) => request.path.endsWith('/replies/prepare') && !request.failure));
      const ready = await f.bridge.getState();
      assert.equal(ready.phase, 'ready');
      assert.equal(ready.result.candidates[0].editedText, '新的合成候选。');
      assert.equal((await f.fixture.command('observations')).model_calls, 3);
    } finally {
      release();
      await recovering;
    }
  });
});

async function stopFailedIdentity(f, scope, sessionId, failed, currentInputVersionId) {
  const pending = f.replies.pendingGenerationReceipts();
  assert.equal(pending.length, 1, '失败响应不得丢失原认证停止身份。');
  assert.equal(pending[0].requestKey, failed.request_key);
  assert.equal(pending[0].inputVersionId, failed.input_version_id);
  await f.replies.beginGenerationClosing(async (receipt) => {
    const actual = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}/interrupt`,
      { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId });
    assert.deepEqual(actual, { session_id: sessionId, turn_id: failed.turn_id, request_key: failed.request_key,
      input_version_id: failed.input_version_id, state: 'failed', interruption_reason: null });
  });
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  const kept = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(kept.current_input_version_id, currentInputVersionId);
  assert.equal(kept.turns.find((turn) => turn.turn_id === failed.turn_id).state, 'failed');
}

test('B10实际持续修改失败后显式新请求不替换已失败执行，原停止身份仍由实际interrupt收口', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '只拒绝本次邀约。' });
    await f.fixture.plan({ count: 1, message_groups: [['本次先不参加。', '没有未来约定。']] });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const sessionId = (await f.bridge.getState()).savedSession.sessionId;
    await f.fixture.plan({ fault: 'failure' });
    await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
    const failedState = await f.bridge.getState();
    assert.equal(failedState.continuation.phase, 'failed');
    const failed = (await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`)).turns.at(-1);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(f.requests.filter((request) => request.path.endsWith('/continue')).map((request) => request.failure),
      [{ kind: 'response', code: 'internal_error', reason: undefined, status: 500 }]);
    const beforeNew = f.requests.length;
    await f.fixture.plan({ count: 1, message_groups: [['新的本次拒绝。', '仅说明本次。']] });
    await f.bridge.generate({ ...scope, newRequest: true });
    const next = await f.bridge.getState();
    assert.equal(next.phase, 'ready', '实际失败后显式新请求应沿普通prepare完成。');
    const requests = f.requests.slice(beforeNew);
    assert(!requests.some((request) => request.path.endsWith('/replace/prepare')),
      '已收到业务失败的原任务不能冒充可替换的在途租约。');
    assert(requests.some((request) => request.path.endsWith('/replies/prepare') && !request.failure));
    const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
    assert.equal(saved.turns.length, 3);
    assert.equal(saved.turns[1].state, 'failed');
    assert.equal(saved.turns[2].state, 'completed');
    assert.notEqual(saved.turns[2].request_key, failed.request_key);
    assert.equal(saved.current_input_version_id, saved.turns[2].input_version_id);
    await stopFailedIdentity(f, scope, sessionId, failed, saved.current_input_version_id);
    assert.equal((await f.fixture.command('observations')).model_calls, 3);
  });
});

test('B09已确认候选实际失败后明确结合新消息创建独立请求，旧任务不能冒充A15替换目标', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '表示愿意等待，但不增加承诺。' });
    await f.fixture.plan({ explore: { question: null } });
    await f.bridge.explore(scope);
    const explored = (await f.bridge.getState()).exploration.result;
    assert(explored);
    await f.fixture.plan({ fault: 'failure' });
    await f.bridge.selectDirection({ ...scope, suggestionId: explored.directions[0].suggestionId,
      inputVersion: explored.inputVersion });
    const failedState = await f.bridge.getState();
    assert.equal(failedState.exploration.phase, 'failed');
    assert.notEqual(failedState.phase, 'waiting');
    const sessionId = explored.sessionId;
    const failed = (await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`)).turns[0];
    assert.equal(failed.state, 'failed');
    assert(f.requests.some((request) => request.path.endsWith('/confirm') && request.failure));
    await f.bridge.readSavedSession(scope);
    await f.fixture.command('append_message');
    await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed,
      '失败后的真实本联系人SSE仍只提醒，不自动重试。');
    assert.equal((await f.fixture.command('observations')).model_calls, 2);
    const beforeNew = f.requests.length;
    await f.fixture.plan({ count: 1, message_groups: [['结合新近况说明等待。', '不增加承诺。']] });
    await f.bridge.combineNewMessages(scope);
    const next = await f.bridge.getState();
    assert.equal(next.phase, 'ready', '明确结合新消息须使用新请求而不是替换历史failed任务。');
    assert.equal(next.result.input.purpose, '表示愿意等待，但不增加承诺。');
    assert.equal(next.messageNotice.changed, false);
    const requests = f.requests.slice(beforeNew);
    assert(!requests.some((request) => request.path.endsWith('/replace/prepare')));
    assert(requests.some((request) => request.path.endsWith('/replies/prepare') && !request.failure));
    const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
    assert.equal(saved.turns.length, 2);
    assert.equal(saved.turns[0].state, 'failed');
    assert.equal(saved.turns[1].state, 'completed');
    assert.notEqual(saved.turns[1].request_key, failed.request_key);
    assert.equal(saved.current_input_version_id, saved.turns[1].input_version_id);
    await stopFailedIdentity(f, scope, sessionId, failed, saved.current_input_version_id);
    const observations = await f.fixture.command('observations');
    assert.equal(observations.model_calls, 3);
    assert.match(JSON.stringify(observations.payloads.at(-1)), /甲的新合成消息：时间安排更新。/);
  });
});
