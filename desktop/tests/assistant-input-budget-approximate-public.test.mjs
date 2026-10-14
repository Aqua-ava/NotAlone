import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

const enabled = process.env.CONDA_DEFAULT_ENV === 'NotAlone';

test('公开估算生成显示完整预算与余量，重建服务后历史回执仍如实显示', { skip: !enabled }, async (t) => {
  const f = await budgetPublicFixture(t);
  const configuration = { approximate: true, safety_margin: 200 };
  await f.configure(configuration);
  const scope = await f.connect(), text = '公开估算回执重读的合成草稿。';
  f.contacts.setDraft({ ...scope, text });
  await f.command('plan', { plan: { text, count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  const ready = await f.bridge.getState(), budget = ready.result.inputBudget;
  assert.equal(ready.phase, 'ready');
  assert.equal(budget.measurementKind, 'approximate');
  assert.equal(budget.safetyMarginTokens, 200);
  assert.equal(budget.totalTokens, budget.inputTokens + budget.outputReserveTokens + 200);
  const html = f.renderCandidates(ready);
  assert.match(html, /输入长度为估算，已预留余量/);
  assert.match(html, /安全余量 200 token/);
  assert.doesNotMatch(html, /精确计量|已核实的保守上界/);
  const sessionId = ready.result.assistantSessionId;
  const persisted = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  assert.equal(persisted.turns[0].reply.input_budget.measurement_kind, 'approximate');
  assert.equal(persisted.turns[0].reply.input_budget.safety_margin_tokens, 200);

  await f.configure(configuration);
  const reconnected = await f.connect(scope.contactId);
  await f.bridge.selectSavedSession({ ...reconnected, sessionId });
  const historical = await f.bridge.getState();
  assert.equal(historical.savedSession.turns[0].reply.inputBudget.measurementKind, 'approximate');
  assert.equal(historical.savedSession.turns[0].reply.inputBudget.safetyMarginTokens, 200);
  assert.equal(historical.savedSession.turns[0].reply.candidates[0].text, text);
  assert.match(f.renderSession(historical), /这轮生成的输入长度为估算，已预留余量/);
  assert.match(f.renderSession(historical), /安全余量 200 token/);
  assert.equal((await f.command('metrics')).model_calls, 1);
});
