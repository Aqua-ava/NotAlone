import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('联系人 A → B → A 保留草稿，重复选择不改变内容或生成', async (t) => {
  const f = await budgetPublicFixture(t);
  const [a, b] = f.data.contact_ids;
  const first = await f.connect(a);
  f.contacts.setDraft({ ...first, text: '甲尚未提交的草稿。' });
  const second = await f.connect(b);
  assert.equal(f.contacts.getState().draft, '');
  f.contacts.setDraft({ ...second, text: '乙独立的草稿。' });
  const returned = await f.connect(a);
  assert.equal(f.contacts.getState().draft, '甲尚未提交的草稿。');
  const revision = f.contacts.getState().scopeRevision;
  f.contacts.selectContact(returned);
  assert.equal(f.contacts.getState().scopeRevision, revision);
  assert.equal(f.contacts.getState().draft, '甲尚未提交的草稿。');
  assert.equal((await f.command('metrics')).model_calls, 0);
});

test('切回联系人恢复输入模式、方向与要求，并回到此前选定的助手会话', async (t) => {
  const f = await budgetPublicFixture(t);
  const [a, b] = f.data.contact_ids;
  const first = await f.connect(a);
  await f.bridge.newSavedSession(first);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  await f.bridge.setMode({ ...first, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...first, purpose: '甲的联系目的' });
  await f.bridge.updateCorrection({ ...first, correction: '甲的纠正' });
  await f.bridge.updateRequirements({ ...first, requirements: '甲的临时要求' });
  await f.bridge.updateSkill({ ...first, skill: { mode: 'disabled', versionId: null } });
  await f.bridge.updateOptions({ ...first, options: { tone: 'warm', instruction: '甲的语气要求', includeRelationshipContext: true } });
  await f.connect(b);
  assert.equal((await f.bridge.getState()).purpose, '');
  await f.connect(a);
  const restored = await f.bridge.getState();
  assert.equal(restored.savedSession.sessionId, sessionId);
  assert.equal(restored.mode, 'initiate_conversation');
  assert.equal(restored.purpose, '甲的联系目的');
  assert.equal(restored.correction, '甲的纠正');
  assert.equal(restored.requirements, '甲的临时要求');
  assert.deepEqual(restored.skillChoice, { mode: 'disabled', versionId: null });
  assert.deepEqual(restored.options, { tone: 'warm', instruction: '甲的语气要求', includeRelationshipContext: true });
  assert.equal((await f.command('metrics')).model_calls, 0);
});

test('切回联系人复验已保存候选并恢复未保存的分组编辑，不新增版本或生成', async (t) => {
  const f = await budgetPublicFixture(t);
  const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '合成草稿。' });
  await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...scope, purpose: '合成联系目的。' });
  await f.command('plan', { plan: { text: '合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const view = before.candidateVersions.items[0];
  const version = view.history.versions[0];
  const identity = { ...scope, sessionId: before.savedSession.sessionId, candidateId: view.candidateId, versionId: version.versionId };
  const messages = version.messages.map((message) => ({ ...message, text: '尚未保存的合成编辑。' }));
  await f.bridge.updateCandidateVersionDraft({ ...identity, messages, requirements: '本组临时要求' });
  await f.connect(b);
  assert.deepEqual((await f.bridge.getState()).candidateDrafts ?? [], []);
  const displayed = [];
  const unsubscribe = f.bridge.onStateChanged((state) => {
    if (state.contactId === a && state.candidateVersions?.items.some((item) => item.history)) displayed.push(state);
  });
  await f.connect(a); unsubscribe();
  assert.ok(displayed.length);
  for (const state of displayed) {
    assert.deepEqual(state.candidateDrafts[0]?.messages, messages, '版本首次可见时编辑必须已同步恢复');
    assert.match(f.renderCandidates(state), /尚未保存的合成编辑/);
  }
  const after = await f.bridge.getState();
  assert.deepEqual(after.candidateDrafts, [{ candidateId: view.candidateId, versionId: version.versionId, messages, requirements: '本组临时要求' }]);
  assert.equal(after.candidateVersions.items[0].history.versions.length, 1);
  assert.equal(after.savedSession.turns.length, 1);
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('待回复对象从当前联系人重新读取，失效 Skill 不从旧选择恢复', async (t) => {
  const f = await budgetPublicFixture(t);
  const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
  await f.bridge.loadMessages({ ...scope, older: false });
  const target = (await f.bridge.getState()).messages.items.find((message) => message.speaker === 'contact');
  assert.ok(target);
  await f.bridge.selectMessage({ ...scope, messageId: target.messageId });
  await f.bridge.updateDirection({ ...scope, direction: '合成回复方向' });
  await f.bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: '11111111-1111-4111-8111-111111111111' } });
  await f.connect(b);
  await f.connect(a);
  const after = await f.bridge.getState();
  assert.equal(after.targetMessageId, target.messageId);
  assert.deepEqual(after.messages.items.find((message) => message.messageId === target.messageId), target);
  assert.equal(after.direction, '合成回复方向');
  assert.deepEqual(after.skillChoice, { mode: 'auto', versionId: null });
  assert.equal((await f.command('metrics')).model_calls, 0);
});

test('当前候选选择和编辑随原生成恢复，保留服务端原文与生成身份', async (t) => {
  const f = await budgetPublicFixture(t);
  const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '原始合成输入。' });
  await f.command('plan', { plan: { text: '原始合成候选。', count: 2 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const candidate = before.result.candidates[1];
  const selection = { ...scope, replyRequestId: before.result.replyRequestId, candidateId: candidate.original.candidateId };
  await f.bridge.selectCandidate(selection);
  await f.bridge.editCandidate({ ...selection, text: '本地尚未保存的合成编辑。' });
  await f.connect(b);
  await f.connect(a);
  const restored = await f.bridge.getState();
  assert.equal(restored.result?.replyRequestId, before.result.replyRequestId);
  assert.equal(restored.selectedCandidateId, candidate.original.candidateId);
  assert.equal(restored.result.candidates[1].editedText, '本地尚未保存的合成编辑。');
  assert.deepEqual(restored.result.candidates[1].original, candidate.original);
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('新建和删除助手会话清空本范围输入，连接变化清除所有恢复副本', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  let scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '甲旧会话草稿。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '甲旧要求' });
  await f.connect(b); scope = await f.connect(a);
  await f.bridge.newSavedSession(scope);
  const fresh = (await f.bridge.getState()).savedSession.sessionId;
  assert.equal(f.contacts.getState().draft, '');
  assert.equal((await f.bridge.getState()).requirements, '');
  f.contacts.setDraft({ ...scope, text: '新会话草稿。' });
  await f.connect(b); scope = await f.connect(a);
  assert.equal((await f.bridge.getState()).savedSession.sessionId, fresh);
  assert.equal(f.contacts.getState().draft, '新会话草稿。');
  await f.bridge.deleteSavedSession({ ...scope, sessionId: fresh, confirmed: true });
  await f.connect(b); scope = await f.connect(a);
  assert.notEqual((await f.bridge.getState()).savedSession.sessionId, fresh);
  assert.equal(f.contacts.getState().draft, '');
  f.contacts.setDraft({ ...scope, text: '连接变化前草稿。' });
  await f.connect(b);
  await f.configure({});
  await f.connect(a);
  assert.equal(f.contacts.getState().draft, '');
  assert.equal((await f.bridge.getState()).requirements, '');
  assert.equal((await f.command('metrics')).model_calls, 0);
});

test('恢复读取失败可见且重试保留原输入，迟到的甲读取不能覆盖乙', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  const path = `/api/contacts/${a}/assistant-sessions/${sessionId}`;
  f.contacts.setDraft({ ...scope, text: '等待复验的甲草稿。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '甲要求' });
  await f.connect(b);
  f.delivery.after = (request) => { if (request.path === path) throw new f.BackendRequestFailure('connection'); };
  const failedScope = await f.connect(a);
  assert.equal((await f.bridge.getState()).savedSession.phase, 'failed');
  assert.equal(f.contacts.getState().draft, '');
  assert.match(f.renderSession(await f.bridge.getState()), /读取|重试/);
  f.delivery.after = undefined;
  await f.bridge.readSavedSession(failedScope);
  assert.equal(f.contacts.getState().draft, '等待复验的甲草稿。');
  await f.connect(b);
  let release, arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  f.delivery.after = async (request) => { if (request.path === path) { arrived(); await gate; } };
  const pending = f.connect(a);
  await entered;
  const second = await f.connect(b);
  f.contacts.setDraft({ ...second, text: '乙当前新草稿。' });
  release(); await pending;
  assert.equal((await f.bridge.getState()).contactId, b);
  assert.equal(f.contacts.getState().draft, '乙当前新草稿。');
  f.delivery.after = undefined;
  await f.connect(a);
  assert.equal(f.contacts.getState().draft, '等待复验的甲草稿。');
  assert.equal((await f.bridge.getState()).requirements, '甲要求');
});

test('离开期间原助手会话被删除，旧草稿和编辑不会借默认会话复活', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  f.contacts.setDraft({ ...scope, text: '已删除讨论的草稿。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '已删除讨论的要求' });
  await f.connect(b);
  await f.request(`/api/contacts/${a}/assistant-sessions/${sessionId}`, { confirmed: true }, 'DELETE');
  await f.connect(a);
  assert.equal((await f.bridge.getState()).savedSession.phase, 'failed');
  assert.equal(f.contacts.getState().draft, '');
  assert.equal((await f.bridge.getState()).requirements, '');
  await f.connect(b); await f.connect(a);
  assert.equal(f.contacts.getState().draft, '');
  assert.equal((await f.bridge.getState()).requirements, '');
});

test('后台删除待回复来源后只清除失效引用，保留独立草稿和要求', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '与来源无关的草稿。' });
  await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
  const target = (await f.bridge.getState()).messages.items[0];
  await f.bridge.selectMessage({ ...scope, messageId: target.messageId });
  await f.bridge.updateDirection({ ...scope, direction: '用户直接输入的方向' });
  await f.bridge.updateCorrection({ ...scope, correction: '原来源的理解纠正' });
  await f.bridge.updateRequirements({ ...scope, requirements: '独立临时要求' });
  await f.connect(b);
  const sources = await f.request(`/api/contacts/${a}/sources`);
  const sourceId = sources.sources[0].source_id;
  await f.request(`/api/contacts/${a}/sources/${sourceId}`, undefined, 'DELETE');
  const deadline = Date.now() + 10000;
  let deleted = false;
  while (Date.now() < deadline) {
    const source = (await f.request(`/api/contacts/${a}/sources`)).sources.find((item) => item.source_id === sourceId);
    if (source.status === 'deleted' && source.task_status === 'succeeded') { deleted = true; break; }
    assert.notEqual(source.task_status, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(deleted);
  await f.replies.revalidateDeletedSource(a);
  await f.connect(a);
  const after = await f.bridge.getState();
  assert.equal(after.targetMessageId, null);
  assert.equal(after.correction, '');
  assert.equal(after.requirements, '独立临时要求');
  assert.equal(after.direction, '用户直接输入的方向');
  assert.equal(f.contacts.getState().draft, '与来源无关的草稿。');
  assert.equal(JSON.stringify(after).includes(target.text), false);
  assert.match(after.contentRestoreNotice, /待回复对象/);
});

test('同名联系人保持独立，Skill 只恢复当前联系人仍启用的版本', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  await f.command('same_names');
  const { skills } = await f.command('strategy_skills');
  const skill = skills.find((item) => item.label === 'first');
  let scope = await f.connect(a);
  const names = f.contacts.getState().contacts.filter((item) => [a, b].includes(item.contactId)).map((item) => item.displayName);
  assert.equal(names[0], names[1]);
  f.contacts.setDraft({ ...scope, text: '同名甲独立草稿。' });
  await f.bridge.updateSkill({ ...scope, skill: { mode: 'user', versionId: skill.version_id } });
  await f.connect(b);
  assert.equal(f.contacts.getState().draft, '');
  scope = await f.connect(a);
  assert.equal(f.contacts.getState().draft, '同名甲独立草稿。');
  assert.deepEqual((await f.bridge.getState()).skillChoice, { mode: 'user', versionId: skill.version_id });
  assert.equal((await f.bridge.getState()).skillChoices.some((item) => item.versionId === skills.find((item) => item.label === 'other_contact').version_id), false);
  await f.connect(b);
  await f.request(`/api/skills/${skill.skill_id}/disable`, {});
  await f.connect(a);
  assert.deepEqual((await f.bridge.getState()).skillChoice, { mode: 'auto', versionId: null });
  assert.equal(f.contacts.getState().draft, '同名甲独立草稿。');
  await assert.rejects(f.bridge.updateRequirements({ ...scope, contactId: f.data.foreign_contact_id, requirements: '不可越界' }));
});

test('候选版本读取失败不丢未保存编辑，重试和保存后的再次切换使用正确版本', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  let scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '版本失败合成输入。' });
  await f.command('plan', { plan: { text: '版本失败合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const before = await f.bridge.getState();
  const view = before.candidateVersions.items[0], version = view.history.versions[0];
  const identity = { sessionId: before.savedSession.sessionId, candidateId: view.candidateId, versionId: version.versionId };
  const messages = version.messages.map((message) => ({ ...message, text: '' }));
  await f.bridge.updateCandidateVersionDraft({ ...scope, ...identity, messages, requirements: '' });
  await assert.rejects(f.bridge.updateCandidateVersionDraft({ ...scope, ...identity, messages: [{ ...messages[0], messageId: '11111111-1111-4111-8111-111111111111' }], requirements: '' }));
  await f.connect(b);
  f.delivery.after = (request) => { if (request.method === 'GET' && request.path.includes(`/candidates/${view.candidateId}/versions`)) throw new f.BackendRequestFailure('connection'); };
  scope = await f.connect(a);
  assert.equal((await f.bridge.getState()).savedSession.phase, 'failed');
  assert.deepEqual((await f.bridge.getState()).candidateDrafts ?? [], []);
  f.delivery.after = undefined;
  await f.bridge.readSavedSession(scope);
  assert.deepEqual((await f.bridge.getState()).candidateDrafts[0].messages, messages);
  const completed = messages.map((message) => ({ ...message, text: '已确认保存的编辑。' }));
  await f.bridge.saveCandidateVersion({ ...scope, sessionId: identity.sessionId, candidateId: identity.candidateId,
    parentVersionId: identity.versionId, editKey: crypto.randomUUID(), messages: completed, requirements: null });
  await f.connect(b); await f.connect(a);
  const after = await f.bridge.getState();
  assert.deepEqual(after.candidateDrafts ?? [], []);
  assert.equal(after.candidateVersions.items[0].history.versions.length, 2);
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('首次会话读取未完成或失败期间接受的草稿仍按联系人保留', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  let release, arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  f.delivery.after = async (request) => { if (request.path.startsWith(`/api/contacts/${a}/assistant-sessions`)) { arrived(); await gate; } };
  const pending = f.connect(a);
  await entered;
  const scope = { contactId: a, scopeRevision: f.contacts.getState().scopeRevision };
  f.contacts.setDraft({ ...scope, text: '首次读取期间已输入的草稿。' });
  await f.connect(b);
  release(); await pending; f.delivery.after = undefined;
  const returned = await f.connect(a);
  assert.equal(f.contacts.getState().draft, '首次读取期间已输入的草稿。');
  f.delivery.after = (request) => { if (request.method === 'GET' && request.path.startsWith(`/api/contacts/${a}/assistant-sessions/`)) throw new f.BackendRequestFailure('connection'); };
  await f.bridge.readSavedSession(returned);
  assert.equal((await f.bridge.getState()).savedSession.phase, 'failed');
  f.contacts.setDraft({ ...returned, text: '读取失败后修改的草稿。' });
  await f.connect(b); f.delivery.after = undefined;
  await f.connect(a);
  assert.equal(f.contacts.getState().draft, '读取失败后修改的草稿。');
});

test('切换联系人保留有效的原生成，恢复输入不会再次提交', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '在途生成的独立草稿。' });
  await f.command('plan', { plan: { text: '归属于甲的合成结果。', count: 1 } });
  await f.command('hold');
  const pending = f.bridge.generate({ ...scope, newRequest: true });
  const deadline = Date.now() + 10000;
  while (!(await f.command('metrics')).model_entered && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await f.command('metrics')).model_entered, true);
  await f.connect(b); const returned = await f.connect(a);
  assert.equal(f.contacts.getState().draft, '在途生成的独立草稿。');
  await f.command('release'); await pending;
  await f.bridge.readSavedSession(returned);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.turns.length, 1);
  assert.equal(state.savedSession.turns[0].state, 'completed');
  assert.equal((await f.command('metrics')).model_calls, 1);
});

test('编号继续后的草稿分组编辑恢复仍使用分组版本编辑器', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '编号继续的合成草稿。' });
  await f.command('plan', { plan: { text: '首轮合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  await f.bridge.readSavedSession(scope);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  await f.command('plan', { plan: { count: 1, message_groups: [['继续后合成说法。', '补充合成说明。']] } });
  await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点' });
  const before = await f.bridge.getState();
  assert.equal(before.continuation.phase, 'completed');
  const view = before.candidateVersions.items.find((item) => item.candidateId === before.result.candidates[0].original.candidateId);
  const version = view.history.versions.find((item) => item.versionId === view.displayVersionId);
  const messages = version.messages.map((message) => ({ ...message, text: '编号继续的未保存分组编辑。' }));
  await f.bridge.updateCandidateVersionDraft({ ...scope, sessionId, candidateId: view.candidateId,
    versionId: version.versionId, messages, requirements: '继续分组临时要求' });
  await f.connect(b); await f.connect(a);
  const after = await f.bridge.getState();
  assert.deepEqual(after.result.continuation, before.result.continuation);
  assert.match(f.renderCandidates(after), /编号继续的未保存分组编辑/);
  assert.match(f.renderCandidates(after), /继续分组临时要求/);
  assert.equal((await f.command('metrics')).model_calls, 2);
});

test('删除检查先隔离可见候选，再清洗后台联系人恢复副本', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  let scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '需要依据的合成草稿。' });
  await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
  const target = (await f.bridge.getState()).messages.items[0];
  await f.bridge.selectMessage({ ...scope, messageId: target.messageId });
  await f.bridge.updateDirection({ ...scope, direction: '只回应本次合成消息。' });
  await f.command('plan', { plan: { text: '依赖来源的合成候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true }); await f.bridge.readSavedSession(scope);
  const old = await f.bridge.getState(), candidate = old.result.candidates[0].original.candidateId;
  await f.bridge.editCandidate({ ...scope, replyRequestId: old.result.replyRequestId, candidateId: candidate, text: '应删除的候选编辑副本。' });
  scope = await f.connect(b);
  f.contacts.setDraft({ ...scope, text: '乙独立草稿。' });
  await f.command('plan', { plan: { text: '乙独立候选。', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true }); await f.bridge.readSavedSession(scope);
  const independent = await f.bridge.getState();
  const sources = await f.request(`/api/contacts/${a}/sources`);
  await f.request(`/api/contacts/${a}/sources/${sources.sources[0].source_id}`, undefined, 'DELETE');
  let release, arrived, held = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  f.delivery.after = async (request) => {
    if (!held && request.method === 'GET' && request.path === `/api/contacts/${a}/assistant-sessions/${old.savedSession.sessionId}`) {
      held = true; arrived(); await gate;
    }
  };
  const checking = f.replies.revalidateDeletedSource(a);
  await entered;
  const masked = await f.bridge.getState();
  assert.equal(masked.result, null);
  assert.deepEqual(masked.candidateDrafts ?? [], []);
  assert.equal(masked.candidateVersions?.items.some((item) => item.history), false);
  await assert.rejects(f.bridge.editCandidate({ ...scope, replyRequestId: independent.result.replyRequestId,
    candidateId: independent.result.candidates[0].original.candidateId, text: '尚不可操作' }));
  release(); await checking; f.delivery.after = undefined;
  assert.equal((await f.bridge.getState()).result?.replyRequestId, independent.result.replyRequestId);
  await f.connect(a);
  assert.equal(JSON.stringify(await f.bridge.getState()).includes('应删除的候选编辑副本。'), false);
  await f.connect(b); await f.connect(a);
  assert.equal(JSON.stringify(await f.bridge.getState()).includes('应删除的候选编辑副本。'), false);
});

test('来源删除与切回恢复交错会重启有效读取，不留下永久恢复状态', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  const scope = await f.connect(a);
  f.contacts.setDraft({ ...scope, text: '删除交错仍保留的独立草稿。' });
  await f.bridge.updateRequirements({ ...scope, requirements: '独立要求' });
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  await f.connect(b);
  let release, arrived, holding = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  t.after(() => release());
  f.delivery.after = async (request) => {
    if (holding && request.method === 'GET' && request.path === `/api/contacts/${a}/assistant-sessions/${sessionId}`) {
      arrived(); await gate;
    }
  };
  const restoring = f.connect(a); await entered;
  const sources = await f.request(`/api/contacts/${a}/sources`);
  await f.request(`/api/contacts/${a}/sources/${sources.sources[0].source_id}`, undefined, 'DELETE');
  holding = false;
  await f.replies.revalidateDeletedSource(a);
  release(); await restoring; f.delivery.after = undefined;
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  assert.equal(state.requirements, '独立要求');
  assert.equal(f.contacts.getState().draft, '删除交错仍保留的独立草稿。');
  await f.bridge.updateRequirements({ contactId: a, scopeRevision: state.scopeRevision, requirements: '核验后可正常输入。' });
  assert.equal((await f.bridge.getState()).requirements, '核验后可正常输入。');
});

test('甲删除复验延迟时切换乙，最后发布的乙事件已解除恢复隔离', async (t) => {
  const f = await budgetPublicFixture(t); const [a, b] = f.data.contact_ids;
  let scope = await f.connect(b);
  f.contacts.setDraft({ ...scope, text: '乙保留的合成草稿。' });
  scope = await f.connect(a);
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  let release, arrived, held = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { arrived = resolve; });
  t.after(() => release());
  f.delivery.after = async (request) => {
    if (!held && request.path === `/api/contacts/${a}/assistant-sessions/${sessionId}`) {
      held = true; arrived(); await gate;
    }
  };
  const checking = f.replies.revalidateDeletedSource(a); await entered;
  const events = [];
  const unsubscribe = f.bridge.onStateChanged((state) => { if (state.contactId === b) events.push(state); });
  await f.connect(b); release(); await checking; unsubscribe();
  assert.ok(events.length);
  assert.equal(events.at(-1).savedSession.phase, 'ready');
  assert.equal(f.contacts.getState().draft, '乙保留的合成草稿。');
});
