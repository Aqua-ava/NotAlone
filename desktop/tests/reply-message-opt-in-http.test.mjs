import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eventually, withMessageOptInFixture } from './fixtures/reply-message-opt-in-public.mjs';

test('A15回应新消息只提醒，明确采用真实新target且保留原组已保存编辑', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
    await f.bridge.loadMessages({ ...scope, older: false });
    const oldMessage = (await f.bridge.getState()).messages.items[0];
    await f.bridge.selectMessage({ ...scope, messageId: oldMessage.messageId });
    await f.bridge.updateDirection({ ...scope, direction: '只说明本次拒绝。' });
    await f.bridge.updateRequirements({ ...scope, requirements: '不要承诺' });
    await f.fixture.plan({ count: 1, message_groups: [['旧target第一条。', '旧target第二条。']] });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const before = await f.bridge.getState();
    const sessionId = before.savedSession.sessionId;
    const history = before.candidateVersions.items[0].history;
    const parent = history.versions[0];
    const editedMessages = parent.messages.map((message, index) => ({ messageId: message.messageId, text: `已保存编辑第${index + 1}条。` }));
    await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
      parentVersionId: parent.versionId, editKey: randomUUID(), messages: editedMessages, requirements: '简短一点' });
    const edited = (await f.bridge.getState()).candidateVersions.items[0];
    const newMessage = await f.fixture.command('append_message');
    const noticed = await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '真实认证SSE须发布尚未结合提醒。');
    assert.equal(noticed.result.replyRequestId, before.result.replyRequestId);
    assert.equal(noticed.candidateVersions.items[0].displayVersionId, edited.displayVersionId);
    assert.equal((await f.fixture.command('observations')).model_calls, 1);
    await f.fixture.plan({ count: 1, message_groups: [['新target只说明拒绝。', '保持不承诺。']] });
    await f.bridge.combineNewMessages(scope);
    const after = await f.bridge.getState();
    assert.equal(after.phase, 'ready');
    assert.equal(after.result.input.target.messageId, newMessage.message_id);
    assert.equal(after.result.input.direction, '只说明本次拒绝。');
    assert.equal(after.messageNotice.changed, false);
    const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
    assert.equal(saved.turns.length, 2);
    assert.equal(saved.turns[0].input.content.target_message_id, oldMessage.messageId);
    assert.equal(saved.turns[1].input.content.target_message_id, newMessage.message_id);
    assert.equal(saved.current_input_version_id, saved.turns[1].input_version_id);
    const reread = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}/candidates/${history.candidateId}/versions`);
    const retained = reread.versions.find((version) => version.version_id === edited.displayVersionId);
    assert.deepEqual(retained.messages.map((message) => message.text), editedMessages.map((message) => message.text));
    assert.equal((await f.fixture.command('observations')).model_calls, 2);
  });
});

test('A15主动路径提供显式采用公开控件，保持原目的且实际新上下文进入模型', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '只问候近况。' });
    await f.bridge.updateRequirements({ ...scope, requirements: '不要承诺' });
    await f.fixture.plan({ count: 1, message_groups: [['原合成问候。', '原第二条。']] });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const before = await f.bridge.getState();
    await f.fixture.command('append_message');
    const noticed = await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '主动路径认证SSE须只提醒。');
    assert.equal((await f.fixture.command('observations')).model_calls, 1);
    assert.match(f.renderCandidates(noticed), /结合新消息重新生成/);
    await f.fixture.plan({ count: 1, message_groups: [['结合新近况问候。', '没有约定。']] });
    await f.bridge.combineNewMessages(scope);
    const after = await f.bridge.getState();
    assert.equal(after.phase, 'ready');
    assert.equal(after.result.input.purpose, '只问候近况。');
    assert.equal(after.result.input.userInstruction, '不要承诺');
    assert.equal(after.messageNotice.changed, false);
    const observed = await f.fixture.command('observations');
    assert.equal(observed.model_calls, 2);
    assert.match(JSON.stringify(observed.payloads.at(-1)), /甲的新合成消息：时间安排更新。/);
    const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${before.savedSession.sessionId}`);
    assert.equal(saved.turns.length, 2);
    assert.equal(saved.turns[1].input.content.purpose, '只问候近况。');
    assert.equal(saved.current_input_version_id, saved.turns[1].input_version_id);
  });
});

test('A15回应生成中的明确采用走实际替换，晚旧模型只能保留新CURRENT和候选', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
    await f.bridge.loadMessages({ ...scope, older: false });
    const originalTarget = (await f.bridge.getState()).messages.items[0].messageId;
    await f.bridge.selectMessage({ ...scope, messageId: originalTarget });
    await f.bridge.updateDirection({ ...scope, direction: '只说明本次立场。' });
    // 先到新租约的模型与晚旧租约使用同一非敏感文本；以真实UUID/CURRENT判定归属。
    await f.fixture.plan({ count: 1, message_groups: [['合成受控说法。', '没有约定。']] });
    await f.fixture.plan({ count: 1, message_groups: [['合成受控说法。', '没有约定。']] });
    await f.fixture.command('hold_generation');
    const running = f.bridge.generate({ ...scope, newRequest: true });
    try {
      await eventually(() => f.fixture.command('observations'), (value) => value.generation_entered, '原生成须实际进入可控模型边界。');
      const sessionId = (await f.bridge.getState()).savedSession.sessionId;
      const old = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
      assert.equal(old.turns[0].state, 'running');
      const arrived = await f.fixture.command('append_message');
      await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '生成中也须只提醒。');
      assert.equal((await f.fixture.command('observations')).model_calls, 0);
      const replacing = f.bridge.combineNewMessages(scope);
      await eventually(() => f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`),
        (value) => value.turns.length === 2 && value.current_input_version_id !== old.current_input_version_id,
        '先核实际替换已领取，旧租约失效后再释放两个受控模型。');
      await f.fixture.command('release'); await replacing;
      const latest = await f.bridge.getState();
      assert.equal(latest.phase, 'ready');
      assert.equal(latest.result.input.target.messageId, arrived.message_id);
      const saved = await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`);
      assert.equal(saved.turns.length, 2);
      assert.equal(saved.turns[0].state, 'failed');
      assert.equal(saved.turns[1].state, 'completed');
      assert.equal(saved.current_input_version_id, saved.turns[1].input_version_id);
      assert(f.requests.some((request) => request.path.endsWith('/replace/prepare')));
      await running;
      await eventually(() => f.fixture.command('observations'), (value) => value.model_calls === 2, '晚旧模型须实际返回以覆盖迟到守卫。');
      assert.equal((await f.bridge.getState()).result.replyRequestId, latest.result.replyRequestId);
      assert.equal((await f.request(`/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`)).current_input_version_id,
        saved.current_input_version_id);
      assert.deepEqual(f.replies.pendingGenerationReceipts(), []);
    } finally { await f.fixture.command('release'); await running; }
  });
});

test('A15采用前来源实际删除，拒绝且当前公开投影不保留旧候选正文', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'reply_to_message' });
    await f.bridge.loadMessages({ ...scope, older: false });
    await f.bridge.selectMessage({ ...scope, messageId: (await f.bridge.getState()).messages.items[0].messageId });
    await f.bridge.updateDirection({ ...scope, direction: '拒绝本次邀约。' });
    await f.fixture.plan({ count: 1, message_groups: [['来源删除后不能留存的合成旧候选。']] });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    await f.fixture.command('append_message');
    await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '先验证真实通知归属。');
    const sources = await f.request(`/api/contacts/${scope.contactId}/sources`);
    const sourceId = sources.sources[0].source_id;
    await f.request(`/api/contacts/${scope.contactId}/sources/${sourceId}`, undefined, 'DELETE');
    await eventually(async () => (await f.request(`/api/contacts/${scope.contactId}/sources`)).sources
      .find((source) => source.source_id === sourceId),
    (value) => value.status === 'deleted' && value.task_status === 'succeeded', '来源实际删除必须完成。');
    await assert.rejects(f.bridge.combineNewMessages(scope));
    const rejected = await f.bridge.getState();
    assert.equal(rejected.result, null, '实际source失效后公开状态应重新读取无正文投影。');
    assert.doesNotMatch(JSON.stringify(rejected), /来源删除后不能留存的合成旧候选/);
    assert.equal((await f.fixture.command('observations')).model_calls, 1);
  });
});

test('A15只有真实当前范围通知可采用，具名字段及旧SID提醒拒绝且不增加模型', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.setMode({ ...scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...scope, purpose: '只问候近况。' });
    await f.fixture.plan({ count: 1, message_groups: [['原合成问候。']] });
    await f.bridge.generate({ ...scope, newRequest: true });
    await f.bridge.readSavedSession(scope);
    const before = await f.bridge.getState();
    let finishForeign;
    const verified = new Promise((resolve) => { finishForeign = resolve; });
    f.delivery.after = (request) => { if (request.path.endsWith('/messages?limit=20')) finishForeign(); };
    await f.fixture.command('append_other_contact'); await f.fixture.command('append_other_owner');
    await f.fixture.command('publish_foreign_id'); await verified;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.bridge.getState()).messageNotice.changed, false);
    await assert.rejects(f.bridge.combineNewMessages(scope));
    f.delivery.after = undefined;
    await f.fixture.command('append_message');
    await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '合法本联系人消息才可提醒。');
    const denied = [
      [{ ...scope, contactId: f.fixture.data.contact_ids[1] }],
      [{ ...scope, scopeRevision: scope.scopeRevision - 1 }],
      [{ ...scope, ownerId: f.fixture.data.owner_id }],
      [{ ...scope, sessionId: before.savedSession.sessionId }],
      [{ ...scope, url: 'https://invalid.example' }],
      [scope, {}],
    ];
    for (const args of denied) await assert.rejects(Reflect.apply(f.bridge.combineNewMessages, f.bridge, args));
    assert.equal(f.handlers.get('reply:combine-new-messages').role, 'helper');
    await f.bridge.newSavedSession(scope);
    const next = await f.bridge.getState();
    assert.notEqual(next.savedSession.sessionId, before.savedSession.sessionId);
    assert.equal(next.messageNotice.changed, false);
    await assert.rejects(f.bridge.combineNewMessages(scope));
    assert.equal((await f.fixture.command('observations')).model_calls, 1);
  });
});

test('A15新SID切换后旧消息实际HTTP核验迟到，不能恢复提醒或生成资格', async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    let arrived, release;
    const observed = new Promise((resolve) => { arrived = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    f.delivery.after = async (request) => {
      if (request.path.endsWith('/messages?limit=20')) { arrived(); await held; }
    };
    const old = (await f.bridge.getState()).savedSession.sessionId;
    await f.fixture.command('append_message'); await observed;
    try {
      await f.bridge.newSavedSession(scope);
      const selected = await f.bridge.getState();
      assert.notEqual(selected.savedSession.sessionId, old);
      release(); await new Promise((resolve) => setImmediate(resolve));
      const after = await f.bridge.getState();
      assert.equal(after.savedSession.sessionId, selected.savedSession.sessionId);
      assert.equal(after.messageNotice.changed, false);
      await assert.rejects(f.bridge.combineNewMessages(scope));
      assert.equal((await f.fixture.command('observations')).model_calls, 0);
    } finally { release(); f.delivery.after = undefined; }
  });
});
