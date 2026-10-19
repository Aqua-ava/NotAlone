import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

for (const mode of ['reply_to_message', 'initiate_conversation']) {
  test(`统一补充在${mode}中原子替换旧输入并完整进入生成`, async (t) => {
    const f = await budgetPublicFixture(t);
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode });
    if (mode === 'reply_to_message') {
      await f.bridge.loadMessages({ ...scope, older: false });
      await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
      await f.bridge.updateDirection({ ...scope, direction: '普通问候，不增加承诺' });
    } else await f.bridge.updatePurpose({ ...scope, purpose: '普通问候，不增加承诺' });
    await f.bridge.updateCorrection({ ...scope, correction: '旧纠正' });
    await f.bridge.updateRequirements({ ...scope, requirements: '旧要求' });
    const supplement = '只是普通问候，没有约见面。\n简短自然，不提见面。';
    const updated = await f.bridge.updateSupplement({ ...scope, supplement });
    assert.equal(updated.correction, '');
    assert.equal(updated.requirements, supplement);
    assert.equal(updated.supplementInput, true);
    assert.equal(updated[mode === 'reply_to_message' ? 'direction' : 'purpose'], '普通问候，不增加承诺');
    assert.equal((await f.command('metrics')).model_calls, 0);
    await assert.rejects(f.bridge.updateSupplement({ ...scope, supplement: '字'.repeat(4097) }), /4096/);
    await assert.rejects(f.bridge.updateSupplement({ ...scope, scopeRevision: scope.scopeRevision - 1, supplement: '过期写入' }));
    assert.equal((await f.bridge.getState()).requirements, supplement);
    await f.command('plan', { plan: { count: 1, message_groups: [['最近还好吗？']] } });
    await f.bridge.generate({ ...scope, newRequest: true });
    const observed = await f.command('metrics');
    assert.equal(observed.model_calls, 1);
    assert.equal(observed.payloads.at(-1).user_instruction, supplement);
    assert.equal(observed.payloads.at(-1).understanding_correction, null);
    // 多轮继续沿用既有保守澄清：混合背景不被悄悄删除或变成新意愿。
    await f.bridge.readSavedSession(scope);
    const generated = await f.bridge.getState();
    await f.bridge.continueSession({ ...scope, sessionId: generated.savedSession.sessionId, instruction: '自然一点' });
    const continued = await f.bridge.getState();
    assert.equal(continued.continuation.phase, 'clarification');
    assert.equal(continued.continuation.clarification.reason, 'requirements_need_confirmation');
    assert.equal((await f.command('metrics')).model_calls, 1);
    await f.bridge.updateSupplement({ ...scope, supplement: '' });
    const cleared = await f.bridge.getState();
    assert.equal(cleared.requirements, '');
    assert.equal(cleared.correction, '');
  });
}


test('旧双框长输入可以逐字缩短，超限期间不调用模型', async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '普通问候' });
  await f.bridge.updateCorrection({ ...scope, correction: '甲'.repeat(3000) });
  await f.bridge.updateRequirements({ ...scope, requirements: '乙'.repeat(3000) });
  await assert.rejects(f.bridge.explore(scope), /4096/);
  await assert.rejects(f.bridge.generate({ ...scope, newRequest: true }), /4096/);
  const shorter = '甲'.repeat(3000) + '\n' + '乙'.repeat(2999);
  const state = await f.bridge.updateSupplement({ ...scope, supplement: shorter });
  assert.equal(state.requirements, shorter);
  assert.equal(state.correction, '');
  await assert.rejects(f.bridge.explore(scope), /4096/);
  await assert.rejects(f.bridge.generate({ ...scope, newRequest: true }), /4096/);
  assert.equal((await f.command('metrics')).model_calls, 0);
  await f.bridge.updateSupplement({ ...scope, supplement: '简短自然。' });
  assert.equal((await f.bridge.getState()).requirements, '简短自然。');
});
