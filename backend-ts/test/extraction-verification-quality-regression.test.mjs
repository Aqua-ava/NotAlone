import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationPolicy,completeClaimRow} from './fixtures/complete-claim-response.mjs';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const question = '33333333-3333-4333-8333-333333333333';
const answer = '44444444-4444-4444-8444-444444444444';

test('声明依赖相连问答的确定主张不能凭单条含糊回答直接通过核验', async () => {
  const events = [];
  const window = {owner_id: owner, contact_id: contact, target_message_ids: [answer], messages: [
    {message_id: question, sender: 'self', occurred_at: null, text: '合成：你说的对象是谁？'},
    {message_id: answer, sender: 'contact', occurred_at: null, text: '合成：那个人需要调整安排。'},
  ]};
  const fact = {text: '联系人需要调整安排。', category: 'recent_state', subject: 'contact', topic: 'other',
    source_message_ids: [question, answer], confidence: 0.6, risk_flags: [], valid_at: null, invalid_at: null,
    speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal', alternatives: [],
    interpretation_reason: '合成模型把跨句指代补成了联系人。', event: null, conditions: null};
  const result = await runExtractionFlow({window,verificationPolicy, signal: new AbortController().signal,
    max_retries: 0, retry_delay_ms: 0, requireCurrent: async () => {}, record: async event => {events.push(event);},
    invoke: async request => {
      if (request.purpose === 'verification') assert.match(request.system, /source_message_ids 中每条消息都须在 evidence/);
      return {blocks: [{type: 'tool-call', name: request.tool.name,
      arguments: JSON.stringify(request.purpose === 'extraction'
        ? {scenes: [{scene_name: '合成安排', memories: [fact]}]}
        : {results: [completeClaimRow(fact,{candidate_index: 0, verdict: 'supported', issues: [],
          evidence: [{message_id: answer, quote: '合成：那个人需要调整安排。'}]},window)]}),
    }]};},
  });
  assert.equal(result.extraction_completed, true);
  assert.deepEqual(result.accepted, []);
  const checked = events.find(event => event.stage === 'verification').payload;
  assert.equal(checked.result.model_verdict, 'supported');
  assert.equal(checked.result.verdict, 'unsupported');
  assert.deepEqual(checked.result.issues, ['insufficient_evidence']);
  assert.equal(checked.before.source_dependency_mode, 'any');
});

test('明确单源事实与完整双源问答仍可通过，不能用全部拒绝代替修复', async () => {
  const scenarios = [
    {messages: [{message_id: answer, sender: 'contact', occurred_at: null, text: '合成：我住在南区。'}],
      sources: [answer], evidence: [{message_id: answer, quote: '合成：我住在南区。'}]},
    {messages: [
      {message_id: question, sender: 'self', occurred_at: null, text: '合成：你住在哪一片？'},
      {message_id: answer, sender: 'contact', occurred_at: null, text: '合成：南区。'},
    ], sources: [question, answer], evidence: [
      {message_id: question, quote: '合成：你住在哪一片？'},
      {message_id: answer, quote: '合成：南区。'},
    ]},
  ];
  for (const scenario of scenarios) {
    const fact = {text: '联系人住在南区。', category: 'common_fact', subject: 'contact', topic: 'other',
      source_message_ids: scenario.sources, confidence: 0.9, risk_flags: [], valid_at: null, invalid_at: null,
      speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal', alternatives: [],
      interpretation_reason: '合成明确来源。', event: null, conditions: null};
    const scopedWindow={owner_id:owner,contact_id:contact,target_message_ids:[answer],messages:scenario.messages};
    const outcome = await runExtractionFlow({verificationPolicy,
      window: {owner_id: owner, contact_id: contact, target_message_ids: [answer], messages: scenario.messages},
      signal: new AbortController().signal, max_retries: 0, retry_delay_ms: 0,
      requireCurrent: async () => {}, record: async () => {},
      invoke: async request => ({blocks: [{type: 'tool-call', name: request.tool.name,
        arguments: JSON.stringify(request.purpose === 'extraction'
          ? {scenes: [{scene_name: '合成居住', memories: [fact]}]}
          : {results: [completeClaimRow(fact,{candidate_index: 0, verdict: 'supported', issues: [], evidence: scenario.evidence},scopedWindow)]}),
      }]}),
    });
    assert.equal(outcome.accepted.length, 1);
    assert.equal(outcome.accepted[0].text, '联系人住在南区。');
    assert.equal(outcome.verification[0].result.verdict, 'supported');
  }
});
