import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

const exported = await build({ stdin: { contents: `export { interruptAssistantGeneration,
  recoverAssistantGenerationReceipt } from './src/main/reply/assistant-generation-interruption';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const ports = await import(`data:text/javascript;base64,${Buffer.from(exported.outputFiles[0].text).toString('base64')}`);

test('B10实际typed准备回执丢失保留退出身份，显式恢复原键后真实中断且零候选模型', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '只拒绝本次邀约。' });
  await f.command('plan', { plan: { count: 1, message_groups: [['原合成拒绝。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const sessionId = before.savedSession.sessionId;
  let actualBody;
  f.delivery.after = (request) => {
    if (request.path.endsWith('/continue/prepare')) {
      actualBody = request.body;
      throw new f.BackendRequestFailure('connection');
    }
  };
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
  const failed = await f.bridge.getState();
  assert.equal(failed.continuation.phase, 'failed');
  assert.equal(failed.continuation.canRetry, true);
  const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.turns[1].state, 'running');
  assert.equal(saved.turns[1].request_key, actualBody.idempotency_key);
  assert.equal((await f.command('metrics')).model_calls, 1);
  f.delivery.after = undefined;
  const stopped = [], recovered = [];
  const interrupt = async (receipt) => { stopped.push(receipt); await ports.interruptAssistantGeneration(f.backend, receipt); };
  const recover = async (identity) => { recovered.push(identity); return ports.recoverAssistantGenerationReceipt(f.backend, identity); };
  await assert.rejects(f.replies.beginGenerationClosing(interrupt, recover), /身份尚未确认/);
  assert.deepEqual(stopped, []); assert.deepEqual(recovered, []);
  await f.replies.beginGenerationClosing(interrupt, recover);
  assert.equal(recovered.length, 1); assert.equal(stopped.length, 1);
  assert.equal(recovered[0].requestKey, actualBody.idempotency_key);
  assert.equal(stopped[0].turnId, saved.turns[1].turn_id);
  assert.equal(stopped[0].inputVersionId, saved.turns[1].input_version_id);
  const after = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.deepEqual(after.turns[0], saved.turns[0]);
  assert.equal(after.turns[1].state, 'failed');
  assert.equal(after.turns[1].interruption_reason, 'app_quit');
  assert.equal(after.current_input_version_id, saved.current_input_version_id);
  assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
  assert.equal((await f.command('metrics')).model_calls, 1);
});
