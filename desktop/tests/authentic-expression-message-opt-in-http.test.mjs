import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { eventually, withMessageOptInFixture } from './fixtures/reply-message-opt-in-public.mjs';

const rows = [];
const intent = '明确拒绝本次合成邀请，不增加未来约定。';
after(async () => {
  if (process.env.NOTALONE_AUTHENTIC_MESSAGE_OPT_IN_CAPTURE) {
    await writeFile(process.env.NOTALONE_AUTHENTIC_MESSAGE_OPT_IN_CAPTURE, JSON.stringify({
      data_kind: 'synthetic', coverage: '公开具名桥→HTTP→隔离PG；不是DOM或Host退出',
      quality_verified: false, human_fidelity_pass: 0, rows,
    }, null, 2) + '\n');
  }
});

for (const mode of ['reply_to_message', 'initiate_conversation']) {
  test(`C06 ${mode}当前意图经typed续改与真实SSE显式采用后保留`, async () => {
    await withMessageOptInFixture(async (f) => {
      const scope = await f.connect();
      await f.bridge.setMode({ ...scope, mode });
      let originalTarget;
      if (mode === 'reply_to_message') {
        await f.bridge.loadMessages({ ...scope, older: false });
        originalTarget = (await f.bridge.getState()).messages.items[0].messageId;
        await f.bridge.selectMessage({ ...scope, messageId: originalTarget });
        await f.bridge.updateDirection({ ...scope, direction: intent });
      } else await f.bridge.updatePurpose({ ...scope, purpose: intent });
      await f.bridge.updateRequirements({ ...scope, requirements: '不要承诺' });
      await f.fixture.plan({ count: 1, message_groups: [['本次不参加。', '谢谢邀请。']] });
      await f.bridge.generate({ ...scope, newRequest: true });
      await f.bridge.readSavedSession(scope);
      const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
      const path = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
      const first = await f.request(path);
      const history = initial.candidateVersions.items[0].history;
      await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
        parentVersionId: history.versions[0].versionId, editKey: randomUUID(), requirements: '不要承诺',
        messages: history.versions[0].messages.map((message, index) => ({ messageId: message.messageId,
          text: ['本次先不参加。', '谢谢你。'][index] })) });
      const edited = (await f.bridge.getState()).candidateVersions.items[0];
      await f.bridge.selectCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
        versionId: edited.displayVersionId, selectionKey: randomUUID() });
      await f.fixture.plan({ count: 1, message_groups: [['本次不参加。', '谢谢你邀请。']] });
      await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条自然一点' });
      const continued = await f.bridge.getState();
      assert.equal(continued.continuation.phase, 'completed');
      const beforeNotice = await f.request(path);
      assert.equal(beforeNotice.turns.length, 2);
      const typedSubmission = beforeNotice.turns[1].input.continuation.submission;
      const arrived = await f.fixture.command('append_message');
      const noticed = await eventually(() => f.bridge.getState(), (value) => value.messageNotice.changed,
        '真实本联系人SSE须只提醒。');
      assert.equal(noticed.result.replyRequestId, continued.result.replyRequestId);
      assert.equal((await f.fixture.command('observations')).model_calls, 2);
      assert.deepEqual(await f.request(path), beforeNotice, '收到新消息不改变助手CURRENT或已保存讨论。');

      // 故意错误输出只证明输入和控制契约；不把这组说法计为真人表达质量通过。
      await f.fixture.plan({ count: 1, message_groups: [['本次不参加。', '明晚七点我陪你去合成海边。']] });
      await f.bridge.combineNewMessages(scope);
      const combined = await f.bridge.getState();
      assert.equal(combined.phase, 'ready');
      assert.equal(combined.messageNotice.changed, false);
      const saved = await f.request(path);
      assert.equal(saved.turns.length, 3);
      assert.equal(saved.current_input_version_id, saved.turns[2].input_version_id);
      assert.equal(saved.turns[2].input.content[mode === 'reply_to_message' ? 'target_message_id' : 'purpose'],
        mode === 'reply_to_message' ? arrived.message_id : intent);
      if (originalTarget) assert.equal(first.turns[0].input.content.target_message_id, originalTarget);
      assert.equal(saved.turns[2].input.content.user_instruction, '不要承诺；自然一点');
      const observed = await f.fixture.command('observations');
      assert.equal(observed.model_calls, 3);
      assert.equal(observed.payloads.length, 3);
      for (const payload of observed.payloads) {
        assert.equal(payload.fidelity_contract.current_intent.text, intent);
      }
      assert.equal(observed.payloads[1].continuation_reference.is_current_draft, false);
      assert.equal(observed.payloads[1].continuation_reference.version_id, edited.displayVersionId);
      assert.deepEqual(observed.payloads[1].continuation_reference.messages.map((message) => message.text),
        ['本次先不参加。', '谢谢你。']);
      assert.match(JSON.stringify(observed.payloads[2]), /甲的新合成消息：时间安排更新。/);
      rows.push({ case_id: `${mode}-typed-opt-in`,
        session_id: sessionId, original_target_message_id: originalTarget ?? null,
        new_message_id: arrived.message_id, typed_submission: typedSubmission,
        model_inputs: observed.payloads, outputs: saved.turns.map((turn) => turn.reply), actual_calls: 3,
        notice_model_delta: 0,
        control_contract_completed: true, semantic_review: '故意整组新增承诺；未进行真人审阅',
      });
    });
  });
}
