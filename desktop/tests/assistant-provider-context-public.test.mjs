import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

// 自有测试库的创建、归属和回收由 budgetPublicFixture 核验，端口不是隔离凭据。
const enabled = process.env.CONDA_DEFAULT_ENV === 'NotAlone';
const notice = /模型提示这次内容过长，请新开助手会话。/;

test('服务实际限长通过公开生成呈现独立错误，保留草稿讨论且不伪造预算', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  const initial = await f.bridge.getState();
  const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${initial.savedSession.sessionId}`;
  const text = '服务实际限长后保留的合成草稿。';
  f.contacts.setDraft({ ...scope, text });
  await f.command('plan', { plan: { provider_context_limit: true } });
  await f.bridge.generate({ ...scope, newRequest: true });
  const failed = await f.bridge.getState(), saved = await f.request(endpoint);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.errorCode, 'provider_context_limit');
  assert.equal(failed.canRetry, false);
  assert.equal(failed.inputBudgetNotice, undefined);
  assert.equal(f.contacts.getState().draft, text);
  assert.equal(saved.turns.length, 1);
  assert.equal(saved.turns[0].state, 'failed');
  assert.equal(saved.turns[0].input.content.draft_text, text);
  assert.match(f.renderCandidates(failed), notice);
  assert.doesNotMatch(f.renderCandidates(failed), /模型输入预算|精确计量|已核实的保守上界/);
  assert.equal((await f.command('metrics')).model_calls, 1);
  await f.bridge.readSavedSession(scope);
  assert.equal((await f.bridge.getState()).savedSession.turns[0].input.content.draft_text, text);
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('公开继续生成遭服务限长保留原候选和两轮讨论，不提供同次重试', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  const text = '继续前已保存的合成原候选。';
  f.contacts.setDraft({ ...scope, text });
  await f.command('plan', { plan: { text, count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState(), sessionId = before.savedSession.sessionId;
  await f.command('plan', { plan: { provider_context_limit: true } });
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
  const failed = await f.bridge.getState();
  assert.equal(failed.continuation.phase, 'failed');
  assert.equal(failed.continuation.canRetry, false);
  assert.match(failed.continuation.message, notice);
  assert.equal(failed.result.candidates[0].original.text, text);
  assert.equal(failed.inputBudgetNotice, undefined);
  assert.match(f.renderCandidates(failed), notice);
  const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.turns[0].state, 'completed');
  assert.equal(saved.turns[0].reply.candidates[0].text, text);
  assert.equal(saved.turns[1].state, 'failed');
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('公开方向探索遭服务限长保留已填目的，停止旧策略重试并提示新开', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  const purpose = '方向探索限长后仍保留的合成问候目的。';
  await f.bridge.updatePurpose({ ...scope, purpose });
  const before = await f.bridge.getState(), sessionId = before.savedSession.sessionId;
  await f.command('plan', { plan: { provider_context_limit: true } });
  await f.bridge.explore(scope);
  const failed = await f.bridge.getState();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.errorCode, 'provider_context_limit');
  assert.equal(failed.exploration.phase, 'failed');
  assert.equal(failed.exploration.canRetry, false);
  assert.equal(failed.purpose, purpose);
  assert.equal(failed.inputBudgetNotice, undefined);
  const html = f.renderCandidates(failed);
  assert.match(html, notice);
  assert.doesNotMatch(f.renderStrategy(failed), /方向建议暂不可用，请核对输入或更新策略后明确重试|重试策略操作/);
  assert.doesNotMatch(f.renderStrategy({ ...failed,
    exploration: { ...failed.exploration, automaticUpdatesPaused: true } }), /本次自动更新已暂停，请点/);
  const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(saved.inputs[0].content.purpose_hint, purpose);
  assert.equal((await f.command('metrics')).model_calls, 1);
  await f.bridge.retryExploration(scope);
  assert.equal((await f.command('metrics')).model_calls, 1);
});
