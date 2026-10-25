import test from 'node:test';
import assert from 'node:assert/strict';
import {runExtractionFlow} from '../src/extraction-flow.ts';
import {DshMemoryAdjudicationRuntime} from '../src/memory-adjudication-dsh.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const background = '33333333-3333-4333-8333-333333333333';
const target = '44444444-4444-4444-8444-444444444444';

test('正式提取区分腾讯流程的背景与新消息，保留真实说话人和未知时间', async () => {
  const outcome = await runExtractionFlow({
    window: {
      owner_id: owner, contact_id: contact, target_message_ids: [target],
      messages: [
        {message_id: background, sender: 'self', occurred_at: null, text: '合成背景：你周末偏好什么？'},
        {message_id: target, sender: 'contact', occurred_at: '2026-10-01T01:02:03.123456+08:00', text: '合成回答：我周末喜欢散步。'},
      ],
    },
    signal: new AbortController().signal,
    requireCurrent: async () => {}, record: async () => {},
    invoke: async request => {
      assert.match(request.user, /【背景对话】/);
      assert.match(request.user, /【待提取的新消息】/);
      const [context, fresh] = request.user.split('【待提取的新消息】');
      assert.ok(context.includes(background));
      assert.ok(context.includes('[self]'));
      assert.ok(context.includes('unknown'));
      assert.ok(fresh.includes(target));
      assert.ok(fresh.includes('[contact]'));
      assert.ok(fresh.includes('2026-10-01T01:02:03.123456+08:00'));
      assert.ok(fresh.includes('合成回答：我周末喜欢散步。'));
      assert.equal(request.user.includes('[assistant]'), false);
      assert.equal(request.tool.name, 'DirectMemoryExtractionOutput');
      return {blocks: [{type: 'tool-call', name: request.tool.name, arguments: '{"scenes":[]}'}]};
    },
  });
  assert.equal(outcome.extraction_completed, true);
  assert.deepEqual(outcome.accepted, []);
});

test('批量裁决共用腾讯统一候选池，保留每条新记忆的关联和来源', async () => {
  const memoryId = '55555555-5555-4555-8555-555555555555';
  const prior = {memory_id: memoryId, revision: 1, text: '合成旧记忆：周末散步。', category: 'preference',
    topic: 'other', subject: 'contact', adoption_method: 'auto', source_message_ids: [background],
    source_texts: [{message_id: background, text: '合成来源：我周末散步。', occurred_at: null}]};
  const items = [0, 1].map(candidate_index => ({candidate_index,
    candidate: {text: `合成新记忆${candidate_index}`, category: 'preference', subject: 'contact', topic: 'other',
      source_message_ids: [target], confidence: 0.9, risk_flags: [], valid_at: null, invalid_at: null,
      speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal', alternatives: [],
      interpretation_reason: '合成', event: null, conditions: null, requires_all_sources: true,
      source_dependency_mode: 'all', _scene_name: '合成周末'},
    candidate_source_texts: [{message_id: target, text: '合成新来源：周末会散步。', occurred_at: null}], similar: [prior],
  }));
  const runtime = new DshMemoryAdjudicationRuntime({batchKey: 'synthetic-tencent', port: {async call(request) {
    assert.match(request.user, /统一候选记忆池（共 1 条已有记忆）/);
    assert.match(request.user, /第 1 条新记忆/);
    assert.match(request.user, /第 2 条新记忆/);
    assert.ok(request.user.includes('合成来源：我周末散步。'));
    assert.equal(request.user.split(`"message_id":"${background}"`).length - 1, 1,
      '同一旧版本的原始来源只发送一次，不能按新候选重复复制');
    const decisions = items.map(item => ({candidate_index: item.candidate_index, action: 'keep',
      replaced_memory_id: null, merged_memory_ids: [], merged_text: null, duplicate_memory_id: null, relation: null}));
    return {blocks: [{type: 'tool-call', name: request.schema.title, arguments: JSON.stringify({decisions})}]};
  }}});
  const decisions = await runtime.adjudicate(items, new AbortController().signal);
  assert.deepEqual(decisions.map(item => [item.candidate_index, item.action]), [[0, 'keep'], [1, 'keep']]);
});

test('统一候选池遇到同一资料的不同版本时在模型发送前拒绝', async () => {
  let calls = 0;
  const items = [1, 2].map((revision, candidate_index) => ({candidate_index,
    candidate: {text: '合成新记忆', category: 'preference'}, candidate_source_texts: [],
    similar: [{memory_id: '55555555-5555-4555-8555-555555555555', revision,
      text: revision === 1 ? '合成旧版本' : '合成修订版本', category: 'preference', subject: 'contact', topic: 'other'}],
  }));
  const runtime = new DshMemoryAdjudicationRuntime({batchKey: 'synthetic-conflict', port: {async call() {
    calls++;
    throw new Error('不应发送模型');
  }}});
  await assert.rejects(runtime.adjudicate(items, new AbortController().signal),
    {code: 'adjudication_model_candidate_pool_conflict'});
  assert.equal(calls, 0);
});
