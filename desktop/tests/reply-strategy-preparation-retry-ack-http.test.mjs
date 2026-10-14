import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

const scenarios = [
  { action: 'confirm', outcome: 'receipt', calls: 2 },
  { action: 'answer', outcome: 'receipt', calls: 3 },
  { action: 'confirm', outcome: 'proof', calls: 1 },
];
for (const { action, outcome, calls } of scenarios) {
  test(`B09 ${action}实际${outcome}准备ACK丢失后同命令重试排空原准备`, async (t) => {
    const f = await budgetPublicFixture(t), scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '合成目的：了解近况，不增加其他承诺。' });
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
      await f.command('plan', { plan: { explore: { question: null } } });
      await f.bridge.answerClarification({ ...scope, answer: '不增加其他承诺。',
        questionId: explored.question.questionId, inputVersion: explored.inputVersion });
      explored = (await f.bridge.getState()).exploration.result;
    }
    if (outcome === 'proof') await f.command('invalidate_exploration', {
      contact_id: scope.contactId, task_id: explored.taskId,
    });
    else await f.command('plan', { plan: { count: 1, message_groups: [['只了解本次合成近况。']] } });
    const sessionPath = `/api/contacts/${scope.contactId}/assistant-sessions/${explored.sessionId}`;
    const initial = await f.request(sessionPath), originalRequest = f.backend.requestJson;
    const commands = [], receipts = [], proofs = [];
    let dropped = false;
    f.backend.requestJson = async (request) => {
      const preparing = request.path.endsWith("/prepare-confirm");
      if (preparing) commands.push({ path: request.path, body: structuredClone(request.body),
        bodyHash: createHash('sha256').update(JSON.stringify(request.body)).digest('hex') });
      let response;
      try { response = await originalRequest(request); }
      catch (error) {
        if (preparing && error instanceof f.BackendRequestFailure && error.noGeneration) {
          proofs.push(error.noGeneration);
          if (!dropped) { dropped = true; throw new f.BackendRequestFailure('connection'); }
        }
        throw error;
      }
      if (preparing) {
        receipts.push(structuredClone(response.data));
        if (!dropped) { dropped = true; throw new f.BackendRequestFailure('connection'); }
      }
      return response;
    };
    await f.bridge.generate({ ...scope, newRequest: true });
    assert.equal(dropped, true, '只在真实provider准备完成后丢一次ACK。');
    assert.equal(commands.length, 1);
    const failed = await f.bridge.getState(), prepared = await f.request(sessionPath);
    assert.equal(failed.exploration.phase, 'failed'); assert.equal(failed.exploration.canRetry, true);
    assert.equal(failed.result, null);
    if (outcome === 'receipt') {
      assert.equal(receipts.length, 1); assert.equal(receipts[0].kind, 'prepared');
      assert.equal(prepared.turns.length, 1); assert.equal(prepared.turns[0].state, 'running');
      const actual = receipts[0].generation;
      assert.equal(actual.turn_id, prepared.turns[0].turn_id);
      assert.equal(actual.input_version_id, prepared.turns[0].input_version_id);
      assert.equal(actual.request_key, prepared.turns[0].request_key);
      assert.equal(actual.session_id, explored.sessionId);
      assert.equal(prepared.current_input_version_id, actual.input_version_id);
    } else {
      assert.equal(proofs.length, 1); assert.equal(proofs[0].state, 'not_reserved');
      assert.equal(proofs[0].contactId, scope.contactId); assert.equal(proofs[0].sessionId, explored.sessionId);
      assert.deepEqual(prepared, initial);
    }
    assert.equal((await f.command('metrics')).model_calls, calls - (outcome === 'receipt' ? 1 : 0));
    await f.bridge.retryExploration(scope);
    const retried = await f.bridge.getState(), completed = await f.request(sessionPath);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1], commands[0], '显式重试冻结原task、input、action、suggestion或answer operation及全文body。');
    if (outcome === 'receipt') {
      assert.equal(receipts.length, 2); assert.deepEqual(receipts[1], receipts[0]);
      assert.equal(completed.turns.length, 1); assert.equal(completed.turns[0].state, 'completed');
      assert.equal(completed.turns[0].turn_id, prepared.turns[0].turn_id);
      assert.equal(completed.current_input_version_id, prepared.current_input_version_id);
      assert.equal(retried.phase, 'ready');
      assert.equal(retried.result.replyRequestId, completed.turns[0].reply.reply_request_id);
      assert.equal(retried.result.inputVersionId, completed.current_input_version_id);
    } else {
      assert.equal(proofs.length, 2); assert.deepEqual(proofs[1], proofs[0]);
      assert.equal(retried.exploration.phase, 'failed'); assert.equal(retried.result, null);
      assert.deepEqual(completed, initial);
    }
    const metrics = await f.command('metrics');
    assert.equal(metrics.model_calls, calls);
    const capture = { data_kind: 'synthetic', action, outcome, commands, receipts, proofs,
      before_retry: prepared, after_retry: completed, actual_model_calls: metrics.model_calls,
      actual_model_inputs: metrics.payloads, closing_completed: false, native_acceptance: false };
    const target = `/private/tmp/notalone-b-confirmed-${action}-${outcome}-retry-ack-capture.json`;
    await writeFile(target, JSON.stringify(capture, null, 2) + '\n');
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    await assert.doesNotReject(f.replies.beginGenerationClosing(async () => {
      throw new Error('同命令可靠completed或零领取proof不应制造中断。');
    }));
    capture.closing_completed = true;
    await writeFile(target, JSON.stringify(capture, null, 2) + '\n');
    assert.deepEqual(await f.request(sessionPath), completed);
    assert.equal((await f.command('metrics')).model_calls, calls);
    assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  });
}
