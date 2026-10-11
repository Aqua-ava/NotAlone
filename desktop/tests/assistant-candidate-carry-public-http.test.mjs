import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('A18公开携入只取实际选用的完整编辑版本，零自动生成并保留旧会话', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect();
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '合成目的：只询问当前是否方便。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '仅本轮使用的旧要求' });
  await f.command('plan', { plan: { count: 2, message_groups: [
    ['未选用的第一组。'], ['第二组原第一条。', '第二组原第二条。'],
  ] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
  const history = initial.candidateVersions.items[1].history;
  await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
    parentVersionId: history.versions[0].versionId, editKey: randomUUID(), requirements: '旧版本临时要求',
    messages: history.versions[0].messages.map((message, index) => ({ messageId: message.messageId,
      text: `已明确选用的第二组编辑第${index + 1}条。` })) });
  const versionId = (await f.bridge.getState()).candidateVersions.items[1].displayVersionId;
  await f.bridge.selectCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
    versionId, selectionKey: randomUUID() });
  const selected = (await f.bridge.getState()).explicitCandidateSelection.selection;
  assert(selected);
  const original = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
  const before = (await f.command('metrics')).model_calls;
  await f.bridge.newSavedSessionWithCandidate({ ...scope, sessionId,
    expectedSelectionId: selected.selectionId, candidateId: history.candidateId, versionId });
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  assert.notEqual(state.savedSession.sessionId, sessionId);
  assert.equal(state.savedSession.turns.length, 0);
  assert.equal(state.savedSession.inputs.length, 1);
  const carried = state.savedSession.inputs[0];
  assert.equal(carried.type, 'candidate_carry');
  assert.equal(carried.inputVersionId, state.savedSession.currentInputVersionId);
  assert.deepEqual(carried.content.messages.map((message) => message.text),
    ['已明确选用的第二组编辑第1条。', '已明确选用的第二组编辑第2条。']);
  assert.equal(carried.content.originSessionId, sessionId);
  assert.equal(carried.content.originVersionId, versionId);
  assert.equal(state.requirements, '');
  assert.equal(state.result, null);
  assert.equal((await f.command('metrics')).model_calls, before);
  assert.deepEqual(await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`), original);
  assert.match(f.renderSession(state), /携入的已选版本/);
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '新会话当前合成目的：明确不参与本次活动。' });
  await f.command('plan', { plan: { count: 1, message_groups: [['当前目的的一组新说法。']] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  const generated = await f.command('metrics');
  assert.equal(generated.model_calls, before + 1);
  const items = generated.payloads.at(-1).assistant_discussion.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'candidate_carry');
  assert.equal(items[0].version_id, versionId);
  assert.deepEqual(JSON.parse(items[0].text).messages.map((message) => message.text),
    ['已明确选用的第二组编辑第1条。', '已明确选用的第二组编辑第2条。']);
  assert.equal(JSON.stringify(items).includes('未选用的第一组。'), false);
  assert.equal(JSON.stringify(items).includes('仅本轮使用的旧要求'), false);
  assert.equal(JSON.stringify(items).includes('合成目的：只询问当前是否方便。'), false);
});

async function selectedCandidate(f, scope, text, { history = false } = {}) {
  if (history) {
    await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
    await f.bridge.loadMessages({ ...scope, older: false });
    await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
    await f.bridge.updateDirection({ ...scope, direction: '明确拒绝这次合成邀请。' });
  } else {
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '合成旧目的，不携入新会话。' });
  }
  await f.command('plan', { plan: { count: 1, message_groups: [[text]] } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const state = await f.bridge.getState(), sessionId = state.savedSession.sessionId;
  const historyView = state.candidateVersions.items[0].history;
  await f.bridge.selectCandidateVersion({ ...scope, sessionId, candidateId: historyView.candidateId,
    versionId: historyView.versions[0].versionId, selectionKey: randomUUID() });
  const selected = (await f.bridge.getState()).explicitCandidateSelection.selection;
  return { ...scope, sessionId, expectedSelectionId: selected.selectionId,
    candidateId: selected.candidateId, versionId: selected.versionId };
}

test('A18已满会话仍可公开全新开始或只携已选版本，拒绝旧scope和选择且零自动调用', async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  const command = await selectedCandidate(f, scope, '满会话中唯一明确选用的合成版本。');
  const catalog = `/api/contacts/${scope.contactId}/assistant-sessions`;
  const originalCatalog = await f.request(catalog);
  for (const invalid of [{ ...command, scopeRevision: scope.scopeRevision - 1 },
    { ...command, contactId: f.data.contact_ids[1] }, { ...command, expectedSelectionId: randomUUID() },
    { ...command, versionId: randomUUID() }, { ...command, messages: ['禁止正文注入'] }]) {
    await assert.rejects(f.bridge.newSavedSessionWithCandidate(invalid));
  }
  assert.deepEqual(await f.request(catalog), originalCatalog);
  await f.configure({ capacity: 101 });
  await f.bridge.selectSavedSession({ ...scope, sessionId: command.sessionId });
  await f.bridge.setMode({ ...scope, mode: 'rewrite_draft' });
  f.contacts.setDraft({ ...scope, text: '保留但不携入的合成草稿。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '旧会话临时要求不得搬入。' });
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.equal((await f.bridge.getState()).errorCode, 'input_budget_exceeded');
  assert.equal((await f.command('metrics')).model_calls, 1);
  await f.bridge.newSavedSession(scope);
  const blank = (await f.bridge.getState()).savedSession;
  assert.deepEqual(blank.inputs, []); assert.deepEqual(blank.turns, []);
  assert.equal(blank.currentInputVersionId, null);
  await f.bridge.selectSavedSession({ ...scope, sessionId: command.sessionId });
  await f.bridge.newSavedSessionWithCandidate(command);
  const carried = await f.bridge.getState();
  assert.equal(carried.savedSession.phase, 'ready');
  assert.equal(carried.savedSession.inputs[0].type, 'candidate_carry');
  assert.equal(carried.savedSession.inputs[0].content.messages[0].text, '满会话中唯一明确选用的合成版本。');
  assert.equal(carried.requirements, ''); assert.equal(carried.result, null);
  assert.equal(carried.savedSession.turns.length, 0);
  assert.equal(f.contacts.getState().draft, '');
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('A18公开携入的来源物理删除清除新旧副本并保留独立讨论', async (t) => {
  const f = await budgetPublicFixture(t), scope = await f.connect();
  const text = '携入血缘必须清除的合成候选。';
  const command = await selectedCandidate(f, scope, text, { history: true });
  const path = `/api/contacts/${scope.contactId}/assistant-sessions/${command.sessionId}`;
  await f.bridge.newSavedSessionWithCandidate(command);
  const childId = (await f.bridge.getState()).savedSession.sessionId;
  const childPath = `/api/contacts/${scope.contactId}/assistant-sessions/${childId}`;
  const independent = await f.request(`${path}/inputs`, { content: { type: 'purpose_exploration',
    purpose_hint: '来源之外应保留的独立合成讨论。' } });
  await f.bridge.selectSavedSession({ ...scope, sessionId: command.sessionId });
  const sources = await f.request(`/api/contacts/${scope.contactId}/sources`);
  const sourceId = sources.sources[0].source_id;
  await f.request(`/api/contacts/${scope.contactId}/sources/${sourceId}`, undefined, 'DELETE');
  let deleted = false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const source = (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources.find((item) => item.source_id === sourceId);
    assert.notEqual(source.task_status, 'failed');
    if (source.status === 'deleted' && source.task_status === 'succeeded') { deleted = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(deleted, true);
  await f.bridge.newSavedSessionWithCandidate(command);
  assert.equal(JSON.stringify(await f.bridge.getState()).includes(text), false);
  const old = await f.request(path), child = await f.request(childPath);
  assert.equal(old.current_input_version_id, independent.input_version_id);
  assert.equal(old.inputs.some((input) => input.content?.purpose_hint === '来源之外应保留的独立合成讨论。'), true);
  assert.equal(old.turns[0].state, 'redacted');
  assert.equal(child.current_input_version_id, null);
  assert.equal(child.inputs[0].content, null);
  await f.bridge.selectSavedSession({ ...scope, sessionId: childId });
  const reread = (await f.bridge.getState()).savedSession;
  assert.equal(reread.currentInputVersionId, null); assert.equal(reread.inputs[0].content, null);
  assert.equal((await f.command('metrics')).model_calls, 1);
});
