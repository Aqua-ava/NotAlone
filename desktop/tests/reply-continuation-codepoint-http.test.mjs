import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('连续修改公开控件与真实HTTP接受4096码点emoji，不按UTF16截断本次要求或改口', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '只拒绝本次邀约。' });
  await f.command('plan', { plan: { count: 1, message_groups: [['本次先不参加。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const markup = f.renderCandidates(before);
  for (const label of ['继续修改要求', '本次改口']) {
    const element = markup.match(new RegExp(`<textarea[^>]*aria-label="${label}"[^>]*>`))?.[0];
    assert(element);
    assert.doesNotMatch(element, /maxLength="4096"|maxlength="4096"/,
      '原生maxLength计算UTF16，不能截断合法4096码点。');
  }
  const instruction = '😀'.repeat(4096), intentionUpdate = '🙂'.repeat(4096);
  const delivered = [];
  f.delivery.after = (request) => {
    if (request.path.endsWith('/continue/prepare')) delivered.push(request.body);
  };
  await f.bridge.continueSession({ ...scope, sessionId: before.savedSession.sessionId,
    instruction, intentionUpdate });
  const after = await f.bridge.getState();
  assert.equal(after.continuation.phase, 'clarification');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].instruction, instruction);
  assert.equal(delivered[0].intention_update, intentionUpdate);
  assert.equal((await f.command('metrics')).model_calls, 1);
  const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${before.savedSession.sessionId}`);
  assert.equal(saved.current_input_version_id, before.savedSession.currentInputVersionId);
  assert.equal(saved.turns.length, 1);
  await assert.rejects(f.bridge.continueSession({ ...scope, sessionId: before.savedSession.sessionId,
    instruction: instruction + '😀' }));
  assert.equal(delivered.length, 1);
});
