import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

for (const clarification of [false, true]) {
test(`确认方向${clarification ? '并回答澄清' : ''}只更新输入，明确生成才创建候选任务`, async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect(f.data.contact_ids[0]);
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '合成联系目的' });
  await f.command('plan', { plan: { explore: { understanding: '只确认当前合成意愿。', question: clarification ? { text: '本次只问近况吗？', impact: 'ambiguity' } : null } } });
  await f.bridge.explore(scope);
  const exploration = (await f.bridge.getState()).exploration.result;
  assert.ok(exploration);
  await f.bridge.selectDirection({ ...scope, suggestionId: exploration.directions[0].suggestionId, inputVersion: exploration.inputVersion });
  if (clarification) {
    const current = (await f.bridge.getState()).exploration.result;
    await f.command('plan', { plan: { explore: { question: null } } });
    await f.bridge.answerClarification({ ...scope, questionId: current.question.questionId, inputVersion: current.inputVersion, answer: '只问近况。' });
  }
  await f.bridge.readSavedSession(scope);
  assert.equal((await f.command('metrics')).model_calls, clarification ? 2 : 1);
  const confirmed = await f.bridge.getState();
  assert.equal(confirmed.savedSession.turns.length, 0);
  assert.ok(confirmed.purpose);
  await f.command('plan', { plan: { text: '合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  assert.equal((await f.bridge.getState()).savedSession.turns.filter(turn => turn.state === 'completed').length, 1);
});
}

test('准备后补入的消息不进入原上下文，显式新生成才使用', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect(f.data.contact_ids[0]);
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '原始合成目的' });
  await f.command('plan', { plan: { text: '合成候选。', count: 1 } });
  let inserted = false;
  f.delivery.after = async (options) => {
    if (options.path.endsWith('/prepare') && !inserted) {
      inserted = true;
      await f.command('older_messages', { contact_id: scope.contactId });
    }
  };
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.ok(inserted);
  let metrics = await f.command('metrics');
  assert.equal(metrics.model_calls, 1);
  assert.doesNotMatch(JSON.stringify(metrics.payloads), /甲的较早合成消息|后来编辑的目的/);
  await f.bridge.readSavedSession(scope);
  await f.bridge.updatePurpose({ ...scope, purpose: '下一次合成目的' });
  await f.command('plan', { plan: { text: '新的合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  metrics = await f.command('metrics');
  assert.equal(metrics.model_calls, 2);
  assert.match(JSON.stringify(metrics.payloads), /甲的较早合成消息/);
});

test('准备后的只读补查也排除后来入库的消息', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect(f.data.contact_ids[0]);
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '合成联系目的' });
  await f.command('plan', { plan: { text: '合成候选。', count: 1, probe_history: true, probe_query: '甲的较早合成消息' } });
  f.delivery.after = async (o) => { if (o.path.endsWith('/prepare')) await f.command('older_messages', { contact_id: scope.contactId }); };
  await f.bridge.generate({ ...scope, newRequest: true });
  const state = await f.bridge.getState();
  assert.ok(state.result);
  const inputs = await f.command('model-wire-inputs');
  assert.doesNotMatch(JSON.stringify(inputs), /甲的较早合成消息 01/);
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('固定请求同键重放不再调用模型，同键不同输入冲突', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect(f.data.contact_ids[0]);
  f.contacts.setDraft({ ...scope, text: '固定的合成草稿' });
  await f.command('plan', { plan: { text: '合成候选。', count: 1 } });
  let execution;
  f.delivery.after = async (o) => { if (o.path.endsWith('/replies')) execution = { path: o.path, body: structuredClone(o.body) }; };
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.ok(execution);
  const first = (await f.bridge.getState()).result;
  assert.ok(first);
  const replay = await f.request(execution.path, execution.body);
  assert.equal(replay.reply_request_id, first.replyRequestId);
  await assert.rejects(f.request(execution.path, { ...execution.body, content: { ...execution.body.content, draft_text: '另一份合成草稿' } }), error => error.status === 409);
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('准备尚未执行时删除旧讨论来源，独立改写也不能恢复固定副本', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect(f.data.contact_ids[0]);
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '依赖原来源的合成目的' });
  await f.command('plan', { plan: { text: '依赖旧来源的合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const sid = (await f.bridge.getState()).savedSession.sessionId;
  await f.bridge.setMode({ ...scope, mode: 'rewrite_draft' });
  f.contacts.setDraft({ ...scope, text: '这次独立合成草稿' });
  let removed = false;
  f.delivery.after = async (o) => {
    if (!o.path.endsWith('/prepare')) return;
    const sources = await f.request(`/api/contacts/${scope.contactId}/sources`);
    const id = sources.sources[0].source_id;
    await f.request(`/api/contacts/${scope.contactId}/sources/${id}`, undefined, 'DELETE');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const source = (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources.find(item => item.source_id === id);
      assert.notEqual(source.task_status, 'failed');
      if (source.status === 'deleted' && source.task_status === 'succeeded') { removed = true; return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('合成来源删除未完成');
  };
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.ok(removed);
  const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sid}`);
  assert.equal(saved.turns.length, 2);
  assert.ok(saved.turns.every(turn => turn.state === 'redacted' && turn.input === null));
  assert.equal((await f.command('metrics')).model_calls, 1);
  assert.doesNotMatch(JSON.stringify(saved), /依赖旧来源的合成候选/);
});

test('准备后停用所选 Skill，固定材料不能绕过执行复验', async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  const skill = (await f.command('strategy_skills')).skills[0];
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '核验失效策略的合成目的' });
  await f.bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: skill.version_id } });
  let disabled = false;
  f.delivery.after = async (request) => {
    if (request.path.endsWith('/prepare')) {
      await f.request(`/api/skills/${skill.skill_id}/disable`, {});
      disabled = true;
    }
  };
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.ok(disabled);
  assert.equal((await f.command('metrics')).model_calls, 0);
  assert.equal((await f.bridge.getState()).result, null);
  await f.bridge.readSavedSession(scope);
  const saved = (await f.bridge.getState()).savedSession;
  assert.equal(saved.turns.length, 1);
  assert.notEqual(saved.turns[0].state, 'completed');
});

test('首次预算预检失败后同键重试仍须先固定上下文', async (t) => {
  const f = await budgetPublicFixture(t);
  await f.configure({ capacity: 101 });
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '预算恢复后沿用的合成目的' });
  let command;
  f.delivery.after = async (request) => {
    if (request.path.endsWith('/replies/prepare')) command = { path: request.path, body: structuredClone(request.body) };
  };
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.equal((await f.bridge.getState()).errorCode, 'input_budget_exceeded');
  assert.ok(command);
  assert.equal((await f.command('metrics')).model_calls, 0);
  await f.configure({ capacity: 100000 });
  const prepared = await f.request(command.path, command.body);
  assert.equal(prepared.request_key, command.body.idempotency_key);
  await f.command('older_messages', { contact_id: scope.contactId });
  await f.command('plan', { plan: { text: '预算恢复后的合成候选。', count: 1 } });
  await f.request(command.path.replace(/\/prepare$/, ''), command.body);
  const metrics = await f.command('metrics');
  assert.equal(metrics.model_calls, 1);
  assert.doesNotMatch(JSON.stringify(metrics.payloads), /甲的较早合成消息/);
});
