import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

// 执行目录选择本轮正式夹具；从总协调desktop运行时，不复制其生产源码。
const { eventually, withMessageOptInFixture } = await import(pathToFileURL(
  path.resolve('tests/fixtures/reply-message-opt-in-public.mjs')).href);
const rows = [];
const intent = '明确拒绝本次合成邀请，不增加未来约定。';
const selectedRequirement = '甲'.repeat(4096);
const requirements = ['自然一点', selectedRequirement, '简短一点'].join('；');
after(async () => {
  if (process.env.NOTALONE_AUTHENTIC_ACCUMULATED_OPT_IN_CAPTURE) await writeFile(
    process.env.NOTALONE_AUTHENTIC_ACCUMULATED_OPT_IN_CAPTURE,
    JSON.stringify({ data_kind: 'synthetic', quality_verified: false, human_fidelity_pass: 0,
      coverage: '公开具名桥→真实HTTP→隔离PG；不是Page、Host或真人质量', rows }, null, 2) + '\n');
});

for (const mode of ['reply_to_message', 'initiate_conversation']) {
  test(`C06 ${mode}合法4106码点累计要求经真实SSE明确采用完整保留并经过原预算`, async () => {
    await withMessageOptInFixture(async (f) => {
      const scope = await f.connect();
      const samplePath = `/api/contacts/${scope.contactId}/style-samples`;
      const sample = (await f.request(samplePath, { idempotency_key: randomUUID(),
        text: '合成旧表达：我总是答应，明晚陪同。', origin: { kind: 'manual' } })).sample;
      assert.deepEqual(sample.source_ids, []);
      await f.bridge.setMode({ ...scope, mode });
      let originalTarget;
      if (mode === 'reply_to_message') {
        await f.bridge.loadMessages({ ...scope, older: false });
        originalTarget = (await f.bridge.getState()).messages.items[0].messageId;
        await f.bridge.selectMessage({ ...scope, messageId: originalTarget });
        await f.bridge.updateDirection({ ...scope, direction: intent });
      } else await f.bridge.updatePurpose({ ...scope, purpose: intent });
      await f.bridge.updateRequirements({ ...scope, requirements: '自然一点' });
      await f.fixture.plan({ count: 1, message_groups: [['本次不参加。', '谢谢邀请。']] });
      await f.bridge.generate({ ...scope, newRequest: true });
      await f.bridge.readSavedSession(scope);
      const initial = await f.bridge.getState(), sessionId = initial.savedSession.sessionId;
      const endpoint = `/api/contacts/${scope.contactId}/assistant-sessions/${sessionId}`;
      const history = initial.candidateVersions.items[0].history;
      await f.bridge.saveCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
        parentVersionId: history.versions[0].versionId, editKey: randomUUID(), requirements: selectedRequirement,
        messages: history.versions[0].messages.map((message, index) => ({ messageId: message.messageId,
          text: ['本次先不参加。', '谢谢你。'][index] })) });
      const edited = (await f.bridge.getState()).candidateVersions.items[0];
      await f.bridge.selectCandidateVersion({ ...scope, sessionId, candidateId: history.candidateId,
        versionId: edited.displayVersionId, selectionKey: randomUUID() });
      await f.fixture.plan({ count: 1, message_groups: [['本次不参加。', '谢谢你邀请。']] });
      await f.bridge.continueSession({ ...scope, sessionId, instruction: '第一条简短一点',
        requirementChanges: [{ action: 'keep', previous: selectedRequirement }] });
      const continued = await f.bridge.getState(), before = await f.request(endpoint);
      assert.equal(continued.continuation.phase, 'completed');
      assert.equal(continued.requirements, requirements);
      assert.equal(Array.from(requirements).length, 4106);
      assert.equal(before.turns.length, 2);
      assert.equal(before.turns[1].input.content.user_instruction, requirements);
      const originalSubmission = before.turns[1].input.continuation.submission;
      const arrived = await f.fixture.command('append_message');
      const notice = await eventually(() => f.bridge.getState(), (value) => value.messageNotice.changed,
        '真实本联系人SSE须仅提醒，不隐式采用。');
      assert.equal(notice.result.replyRequestId, continued.result.replyRequestId);
      assert.deepEqual(await f.request(endpoint), before);
      assert.equal((await f.fixture.command('observations')).model_calls, 2);
      await f.fixture.plan({ count: 1, message_groups: [['本次不参加。', '谢谢这次告知。']] });
      await f.bridge.combineNewMessages(scope);
      const combined = await f.bridge.getState(), saved = await f.request(endpoint);
      const observed = await f.fixture.command('observations');
      const capture = { case_id: `${mode}-accumulated-opt-in`, session_id: sessionId,
        sample_id: sample.sample_id, requirement_codepoints: 4106, actual_model_inputs: observed.payloads,
        actual_calls: observed.model_calls, before_notice: before, after_combine: saved,
        request_observations: f.requests, combined_phase: combined.phase, error_code: combined.errorCode,
        control_contract_completed: false, notice_model_delta: 0, deletion_model_delta: null };
      rows.push(capture);
      assert.equal(combined.phase, 'ready', '合法累计要求须采用新消息，不经公开单次声明解析器重新拒绝。');
      assert.equal(combined.messageNotice.changed, false);
      assert.equal(saved.turns.length, 3);
      assert.equal(saved.current_input_version_id, saved.turns[2].input_version_id);
      assert.equal(saved.turns[2].input.content.user_instruction, requirements);
      assert.equal(saved.turns[2].input.content[mode === 'reply_to_message' ? 'target_message_id' : 'purpose'],
        mode === 'reply_to_message' ? arrived.message_id : intent);
      assert.deepEqual(saved.turns.slice(0, 2), before.turns);
      if (originalTarget) assert.equal(saved.turns[0].input.content.target_message_id, originalTarget);
      assert.equal(observed.model_calls, 3);
      assert.equal(observed.payloads.length, 3);
      assert.equal(observed.payloads[2].user_instruction, requirements);
      assert.equal(observed.payloads[2].fidelity_contract.current_intent.text, intent);
      assert.deepEqual(observed.payloads[2].style_references.map((item) => item.sample_id), [sample.sample_id]);
      assert(observed.payloads[2].style_references.every((item) => item.weight === 'low' && item.factual_role === 'expression_reference'));
      const budget = saved.turns[2].reply.input_budget;
      assert.equal(budget.allowed, true); assert.equal(budget.measurement_kind, 'exact');
      assert.equal(budget.total_tokens, budget.input_tokens + budget.output_reserve_tokens);
      assert(budget.total_tokens <= budget.context_window_tokens);
      const independent = (await f.request(samplePath, { idempotency_key: randomUUID(),
        text: '新生成之后独立主动保存的合成表达。', origin: { kind: 'manual' } })).sample;
      await f.request(`${samplePath}/${sample.sample_id}`, undefined, 'DELETE');
      await f.bridge.readSavedSession(scope);
      const erased = await f.request(endpoint);
      assert.equal(erased.current_input_version_id, null);
      assert(erased.turns.every((turn) => turn.state === 'redacted' && turn.input === null && turn.reply === null));
      assert.equal((await f.bridge.getState()).result, null);
      await assert.rejects(f.request(endpoint + '/continue', originalSubmission));
      assert.deepEqual((await f.request(`${samplePath}/${independent.sample_id}`)).sample, independent);
      assert.equal((await f.fixture.command('observations')).model_calls, 3);
      capture.deletion_model_delta = 0; capture.control_contract_completed = true;
      capture.deleted_projection = erased; capture.input_budget = budget;
    });
  });
}
