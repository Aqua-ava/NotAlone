import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eventually, withMessageOptInFixture } from './fixtures/reply-message-opt-in-public.mjs';

for (const action of ['express', 'suggest']) {
  test(`统一工作区${action}在途采用新消息保留输入与来源，晚旧结果不覆盖CURRENT`, { timeout: 90_000 }, async () => {
    await withMessageOptInFixture(async (f) => {
      const scope = await f.connect();
      await f.bridge.enterWorkspace(scope);
      f.contacts.setDraft({ ...scope, text: '只说明本次立场，不作未来约定。' });
      const options = { inputKind: 'workspace', workspaceAction: action, tone: 'concise',
        instruction: '不要承诺', includeRelationshipContext: true,
        contextText: '用户补充：这次只聊今天。', excludedMessageIds: [randomUUID()] };
      await f.bridge.updateOptions({ ...scope, options });
      await f.fixture.plan({ count: 1, text: '旧模型的合成结果。' });
      await f.fixture.plan({ count: 1, text: '新模型的合成结果。' });
      await f.fixture.command('hold_generation');
      const first = f.bridge.generate({ ...scope, newRequest: true, workspaceAction: action });
      try {
        await eventually(() => f.fixture.command('observations'), (value) => value.generation_entered,
          '原请求须已进入真实受控模型。');
        const original = await f.bridge.getState();
        const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${original.savedSession.sessionId}`;
        const before = await f.request(endpoint);
        assert.equal(before.turns.length, 1);
        assert.equal(before.turns[0].state, 'running');
        const arrived = await f.fixture.command('append_message');
        await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '真实SSE须只提示。');
        assert.deepEqual(await f.request(endpoint), before, '新消息不能自动改变原CURRENT。');
        const combining = f.bridge.combineNewMessages(scope);
        let adoptionError;
        const completion = combining.then(() => null, (error) => { adoptionError = error; return error; });
        try {
          await eventually(async () => {
            if (adoptionError) throw adoptionError;
            return f.request(endpoint);
          }, (saved) => saved.turns.length === 2 && saved.current_input_version_id !== before.current_input_version_id,
          '明确采用须替换在途请求并建立新CURRENT。');
        } finally { await f.fixture.command('release'); }
        const failure = await completion;
        if (failure) throw failure;
        await first;
        const after = await f.bridge.getState(), saved = await f.request(endpoint);
        assert.equal(after.phase, 'ready');
        assert.equal(saved.turns.length, 2);
        assert.equal(saved.turns[0].state, 'failed');
        assert.equal(saved.turns[1].state, 'completed');
        assert.equal(saved.current_input_version_id, saved.turns[1].input_version_id);
        assert.equal(after.result.replyRequestId, saved.turns[1].reply.reply_request_id);
        assert.equal(after.messageNotice.changed, false);
        assert.deepEqual(saved.turns[1].input.content, saved.turns[0].input.content);
        assert.equal(saved.turns[1].input.content.workspace_action, action);
        assert.equal(saved.turns[1].input.content.user_instruction, '本次表达简洁直接。\n不要承诺');
        const evidence = await f.request(`/api/contacts/${scope.contactId}/replies/${after.result.replyRequestId}/evidence`);
        assert.match(JSON.stringify(evidence), new RegExp(arrived.message_id));
        assert.equal((await f.fixture.command('observations')).model_calls, 2);
      } finally { await f.fixture.command('release'); await first; }
    });
  });
}

for (const editTiming of ['联系人往返', '恢复复验交错']) test(`工作区连续修改后的完整累计要求随新消息采用，手动新要求仍由用户决定（${editTiming}）`, { timeout: 90_000 }, async () => {
  await withMessageOptInFixture(async (f) => {
    const scope = await f.connect();
    await f.bridge.enterWorkspace(scope);
    f.contacts.setDraft({ ...scope, text: '明确拒绝本次合成邀请。' });
    await f.bridge.updateOptions({ ...scope, options: { inputKind: 'workspace', workspaceAction: 'express',
      tone: 'original', instruction: '自然一点', includeRelationshipContext: true } });
    const messages = ['本次不参加。', '谢谢邀请。'];
    await f.fixture.plan({ count: 1, message_groups: [messages] });
    await f.bridge.generate({ ...scope, newRequest: true, workspaceAction: 'express' });
    await f.bridge.readSavedSession(scope);
    const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
    const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
    const history = initial.candidateVersions.items[0].history;
    const requirement = '甲'.repeat(4096), full = ['自然一点', requirement, '简短一点'].join('；');
    await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
      parentVersionId: history.versions[0].versionId, editKey: randomUUID(), requirements: requirement,
      messages: history.versions[0].messages.map((message) => ({ messageId: message.messageId, text: message.text })) });
    const edited = (await f.bridge.getState()).candidateVersions.items[0];
    await f.bridge.selectCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
      versionId: edited.displayVersionId, selectionKey: randomUUID() });
    await f.fixture.plan({ count: 1, message_groups: [messages] });
    await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点',
      requirementChanges: [{ action: 'keep', previous: requirement }] });
    assert.equal((await f.bridge.getState()).continuation.phase, 'completed');
    assert.equal((await f.request(endpoint)).turns.at(-1).input.content.user_instruction, full);
    await f.connect(f.fixture.data.contact_ids[1]);
    Object.assign(scope, await f.connect(scope.contactId));
    await eventually(() => f.bridge.getState(), (state) => state.savedSession.phase === 'ready'
      && state.sourceAvailability === undefined, '返回原联系人须完成实际讨论恢复和来源核验。');
    await f.bridge.listSavedSessions(scope);
    assert.equal((await f.bridge.getState()).sessionCatalog.phase, 'ready');
    for (let index = 0; index < 2; index += 1) {
      if (index === 1) {
        await f.bridge.updateScene({ ...scope, scene: '合成拒绝邀请场景' });
        const state = await f.bridge.getState();
        await f.bridge.updateOptions({ ...scope, options: { ...state.options, workspaceAction: 'suggest' } });
      }
      await f.fixture.command('append_message');
      await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '实际新消息须先仅提醒。');
      await f.fixture.plan({ count: 1, message_groups: [messages] });
      await f.bridge.combineNewMessages(scope);
      const state = await f.bridge.getState(), saved = await f.request(endpoint);
      assert.equal(state.phase, 'ready');
      assert.equal(saved.turns.at(-1).input.content.user_instruction, full, '采用不得从旧短options丢弃已完成的累计要求。');
      assert.equal(state.result.input.userInstruction, full);
      assert.equal((await f.fixture.command('observations')).payloads.at(-1).user_instruction, full);
      assert(saved.turns.at(-1).input.continuation.message_adoption);
      if (index === 1) {
        assert.equal(saved.turns.at(-1).input.scene, '合成拒绝邀请场景');
        assert.equal(saved.turns.at(-1).input.content.workspace_action, 'suggest');
      }
    }
    const current = await f.bridge.getState();
    if (editTiming === '联系人往返') {
      await f.bridge.updateOptions({ ...scope, options: { ...current.options, tone: 'original', instruction: '保持礼貌' } });
      await f.connect(f.fixture.data.contact_ids[1]);
      Object.assign(scope, await f.connect(scope.contactId));
    } else {
      await f.connect(f.fixture.data.contact_ids[1]);
      let release, reads = 0;
      const gate = new Promise((resolve) => { release = resolve; });
      f.delivery.after = async (request) => {
        if (request.method === 'GET' && request.path === endpoint) { reads += 1; await gate; }
      };
      const restoring = f.connect(scope.contactId);
      let checking;
      try {
        await eventually(() => reads, (count) => count >= 1, '先到达切回联系人实际读取。');
        scope.scopeRevision = f.contacts.getState().scopeRevision;
        checking = f.replies.revalidateDeletedSource(scope.contactId, { preserveInput: true });
        await eventually(() => reads, (count) => count >= 2, '来源复验须实际读取同一保存输入。');
        await f.bridge.updateOptions({ ...scope, options: { ...current.options, tone: 'original', instruction: '保持礼貌' } });
        release();
        await Promise.all([restoring, checking]);
      } finally {
        release(); await Promise.allSettled([restoring, checking]); f.delivery.after = undefined;
      }
    }
    await eventually(() => f.bridge.getState(), (state) => state.savedSession.phase === 'ready'
      && state.sourceAvailability === undefined, '返回原联系人须完成实际讨论恢复和来源核验。');
    await f.fixture.command('append_message');
    await eventually(() => f.bridge.getState(), (state) => state.messageNotice.changed, '用户更改要求后仍须实际新提醒。');
    await f.fixture.plan({ count: 1, message_groups: [messages] });
    await f.bridge.combineNewMessages(scope);
    assert.equal((await f.bridge.getState()).phase, 'ready');
    assert.equal((await f.request(endpoint)).turns.at(-1).input.content.user_instruction, '保持礼貌', '不得用旧累计要求覆盖用户刚明确的新要求。');
  });
});
