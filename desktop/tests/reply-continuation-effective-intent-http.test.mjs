import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

for (const mode of ['reply_to_message', 'initiate_conversation']) {
  test(`B10 ${mode}要求本身明确改口后普通新请求沿实际生效意愿`, async (t) => {
    const f = await budgetPublicFixture(t);
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode });
    if (mode === 'reply_to_message') {
      await f.bridge.loadMessages({ ...scope, older: false });
      await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
      await f.bridge.updateDirection({ ...scope, direction: '拒绝' });
    } else await f.bridge.updatePurpose({ ...scope, purpose: '拒绝' });
    await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
    await f.command('plan', { plan: { count: 1, message_groups: [['这次先不参加。']] } });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
    const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
    await f.command('plan', { plan: { count: 1, message_groups: [['本次答应参加。']] } });
    await f.bridge.continueSession({ ...scope, sessionId, instruction: '还是答应' });
    const typed = await f.bridge.getState(), second = await f.request(path);
    assert.equal(typed.continuation.phase, 'completed');
    assert.equal(second.turns.length, 2);
    const field = mode === 'reply_to_message' ? 'direction' : 'purpose';
    const effectiveIntent = second.turns[1].input.content[field];
    assert.equal(effectiveIntent, '答应');
    assert.equal(second.turns[1].input.continuation.intention_changed, true);
    assert.equal('intention_update' in second.turns[1].input.continuation.submission, false);
    assert.equal(typed.result.input[field], effectiveIntent);
    assert.equal(typed.result.inputVersionId, second.current_input_version_id);
    await f.command('plan', { plan: { count: 1, message_groups: [['继续保留本次答应。']] } });
    await f.bridge.generate({ ...scope, newRequest: true });
    const third = await f.request(path), observed = await f.command('metrics');
    assert.equal(third.turns.length, 3);
    assert.equal(third.turns[2].state, 'completed');
    assert.equal(third.current_input_version_id, third.turns[2].input_version_id);
    assert.equal(observed.model_calls, 3);
    assert.equal(third.turns[2].input.content[field], effectiveIntent);
    assert.equal(typed[field], effectiveIntent);
    assert.equal(observed.payloads.at(-1)[mode === 'reply_to_message' ? 'confirmed_direction' : 'confirmed_purpose'], effectiveIntent);
    assert.equal(third.turns[2].input.content.user_instruction, '自然一点');
  });
}
