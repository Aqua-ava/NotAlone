import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDirectExtraction} from '../src/memory/extraction/protocol.ts';
import {prepareSourceVerification} from '../src/memory/extraction/verification/complete-claim.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-4333-8333-333333333333';
const policy = {id: 'complete-claim-v1', rule_version: 'a'.repeat(64)};

/** 合成单条消息的核验场景；人称提及的 span 由用例指定，用来模拟模型数错码点位置。 */
async function verify(source, candidate, {mentions, sender = 'contact', subject = 'contact', actor = 'contact'}) {
  const window = {owner_id: owner, contact_id: contact, target_message_ids: [message], messages: [{
    message_id: message, sender, occurred_at: null, text_representation: 'text', text: source}]};
  const raw = {text: candidate, subject, category: 'recent_state', topic: 'other', source_message_ids: [message],
    confidence: 0.8, risk_flags: [], valid_at: null, invalid_at: null, speech_act: 'assertion', assertion_status: 'asserted',
    figurative_type: 'literal', alternatives: [], interpretation_reason: '合成。', event: null, conditions: null};
  const facts = parseDirectExtraction({scenes: [{scene_name: '合成', memories: [raw]}]}, window).accepted;
  assert.equal(facts.length, 1);
  const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const facet = verdict => ({verdict, evidence_indices: [0]});
  const field_checks = Object.fromEntries(['category', 'topic', 'scene_name', 'alternatives', 'interpretation_reason',
    'valid_at', 'invalid_at', 'speech_act', 'assertion_status', 'figurative_type', 'event', 'conditions'].map(name => [name, facet('supported')]));
  const item = {candidate_index: 0, verdict: 'supported', issues: [], evidence: [{message_id: message, quote: source}],
    claim_check: {version: 2, field_checks, parts: [{candidate_span: {start: 0, end: [...candidate].length},
      attribution: {...facet('supported'), scope_subject: subject, actor_kind: actor, resolution: 'explicit', subject_mentions: mentions},
      arguments_and_relation: facet('supported'), temporal_and_modality: facet('supported')}]}};
  const blocks = [{type: 'tool-call', name: 'SourceVerificationOutput',
    arguments: JSON.stringify({request_fingerprint: prepared.fingerprint, results: [item]})}];
  return (await prepared.decode(blocks)).items[0];
}
const mention = (kind, start, end) => ({kind, evidence_index: 0, source_span: {start, end}, candidate_span: {start: 0, end: 3}});

test('模型把人称词的码点位置数错一位时，按引文中真实的人称词定位，仍须与发送者一致', async () => {
  const exact = await verify('我现在住在海城。', '联系人现在住在海城。', {mentions: [mention('first_person', 0, 1)]});
  assert.equal(exact.admitted, true, '位置正确本来就通过');
  const shifted = await verify('我现在住在海城。', '联系人现在住在海城。', {mentions: [mention('first_person', 1, 2)]});
  assert.equal(shifted.admitted, true, '落在“现”上，附近唯一的“我”应被定位');
  assert.equal(shifted.result.verdict, 'supported');
  const second = await verify('你现在住在海城。', '用户本人现在住在海城。', {mentions: [mention('second_person', 1, 2)], subject: 'self', actor: 'self'});
  assert.equal(second.admitted, true, '第二人称：联系人说“你”指用户本人');
});

test('重定位不放宽归属：发送者对不上、种类不符、位置太远、复数、没有人称提及均仍拒绝', async () => {
  const rejected = item => {assert.equal(item.admitted, false);assert.ok(item.result.issues.includes('subject'));};
  rejected(await verify('我现在住在海城。', '用户本人现在住在海城。', {mentions: [mention('first_person', 1, 2)], subject: 'self', actor: 'self'}));
  rejected(await verify('你现在住在海城。', '联系人现在住在海城。', {mentions: [mention('first_person', 1, 2)]}));
  rejected(await verify('我现在住在海城，目前没有搬家。', '联系人现在住在海城。', {mentions: [mention('first_person', 8, 9)]}));
  rejected(await verify('我们现在住在海城。', '联系人现在住在海城。', {mentions: [mention('first_person', 1, 2)]}));
  rejected(await verify('现在住在海城。', '联系人现在住在海城。', {mentions: []}));
});
