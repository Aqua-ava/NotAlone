import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

for (const action of ['confirm', 'answer']) {
  test(`B09 ${action}实际准备拒绝证明只排空当前未知键准备`, async (t) => {
    const f = await budgetPublicFixture(t), scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '合成目的：只了解近况，不增加其他承诺。' });
    await f.command('plan', { plan: { explore: { question: action === 'answer'
      ? { text: '本次是否不增加其他承诺？', impact: 'commitment' } : null } } });
    await f.bridge.explore(scope);
    let explored = (await f.bridge.getState()).exploration.result;
    assert(explored);
    await f.bridge.selectDirection({ ...scope, suggestionId: explored.directions[0].suggestionId,
      inputVersion: explored.inputVersion });
    explored = (await f.bridge.getState()).exploration.result;
    if (action === 'answer') {
      assert(explored?.confirmedIntent); assert(explored.question);
      assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
      await f.command('plan', { plan: { explore: { question: null } } });
      await f.bridge.answerClarification({ ...scope, answer: '不增加其他承诺。',
        questionId: explored.question.questionId, inputVersion: explored.inputVersion });
      explored = (await f.bridge.getState()).exploration.result;
    }
    await f.command('invalidate_exploration', { contact_id: scope.contactId, task_id: explored.taskId });
    const sessionPath = `/api/contacts/${scope.contactId}/assistant-sessions/${explored.sessionId}`;
    const before = await f.request(sessionPath), originalRequest = f.backend.requestJson;
    let actualCommand;
    f.backend.requestJson = async (request) => {
      if (request.path.endsWith("/prepare-confirm")) {
        actualCommand = { path: request.path, body: structuredClone(request.body) };

      }
      return originalRequest(request);
    };
    await f.bridge.generate({ ...scope, newRequest: true });
    assert(actualCommand);
    const failed = await f.bridge.getState(), saved = await f.request(sessionPath);
    assert.equal(failed.exploration.phase, 'failed');
    assert.equal(failed.exploration.canRetry, true);
    assert.equal(failed.result, null);
    assert.deepEqual(saved, before);
    if (action === 'answer') assert.equal(before.inputs.at(-1).content.answer, '不增加其他承诺。');
    assert.equal(saved.turns.length, 0);
    let actualProof;
    await assert.rejects(f.backend.requestJson({ method: 'POST', ...actualCommand,
      acceptAssistantNoGenerationProof: true }), (error) => {
      assert(error instanceof f.BackendRequestFailure);
      assert.equal(error.kind, 'response'); assert.equal(error.code, 'assistant_session_rejected');
      actualProof = error.noGeneration;
      assert.deepEqual(Object.keys(actualProof).sort(), ['contactId', 'requestKey', 'sessionId', 'state']);
      assert.equal(actualProof.contactId, scope.contactId); assert.equal(actualProof.sessionId, explored.sessionId);
      assert.equal(actualProof.state, 'not_reserved');
      assert.match(actualProof.requestKey, /^[0-9a-f-]{36}$/);
      assert.notEqual(actualProof.requestKey, actualCommand.body.operation_key);
      return true;
    });
    assert.equal((await f.command('metrics')).model_calls, action === 'answer' ? 2 : 1);
    assert.deepEqual(await f.request(sessionPath), saved);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    await assert.doesNotReject(f.replies.beginGenerationClosing(async () => {
      throw new Error('已证明未领取的当前准备不能制造interrupt。');
    }));
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    assert.deepEqual(await f.request(sessionPath), saved);
    assert.equal((await f.command('metrics')).model_calls, action === 'answer' ? 2 : 1);
  });
}
