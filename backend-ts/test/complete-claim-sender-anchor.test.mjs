import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDirectExtraction} from '../src/memory/extraction/protocol.ts';
import {prepareSourceVerification} from '../src/memory/extraction/verification/complete-claim.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const ids = ['33333333-3333-4333-8333-333333333331', '33333333-3333-4333-8333-333333333332'];
const policy = {id: 'complete-claim-v1', rule_version: 'a'.repeat(64)};

/** messages: [{sender, text}]；每条原文整句作引文；省略主语句不列任何人称提及。 */
async function verify(messages, candidate, {subject = 'contact', actor = 'contact', resolution = 'unique_context', mentions = []} = {}) {
  const window = {owner_id: owner, contact_id: contact, target_message_ids: ids.slice(0, messages.length),
    messages: messages.map((item, index) => ({message_id: ids[index], sender: item.sender, occurred_at: null, text_representation: 'text', text: item.text}))};
  const raw = {text: candidate, subject, category: 'recent_state', topic: 'other', source_message_ids: ids.slice(0, messages.length),
    confidence: 0.8, risk_flags: [], valid_at: null, invalid_at: null, speech_act: 'assertion', assertion_status: 'asserted',
    figurative_type: 'literal', alternatives: [], interpretation_reason: '合成。', event: null, conditions: null};
  const facts = parseDirectExtraction({scenes: [{scene_name: '合成', memories: [raw]}]}, window).accepted;
  assert.equal(facts.length, 1);
  const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const indices = messages.map((_, index) => index);
  const facet = verdict => ({verdict, evidence_indices: indices});
  const field_checks = Object.fromEntries(['category', 'topic', 'scene_name', 'alternatives', 'interpretation_reason',
    'valid_at', 'invalid_at', 'speech_act', 'assertion_status', 'figurative_type', 'event', 'conditions'].map(name => [name, facet('supported')]));
  const item = {candidate_index: 0, verdict: 'supported', issues: [], evidence: messages.map((entry, index) => ({message_id: ids[index], quote: entry.text})),
    claim_check: {version: 2, field_checks, parts: [{candidate_span: {start: 0, end: [...candidate].length},
      attribution: {...facet('supported'), scope_subject: subject, actor_kind: actor, resolution, subject_mentions: mentions},
      arguments_and_relation: facet('supported'), temporal_and_modality: facet('supported')}]}};
  const blocks = [{type: 'tool-call', name: 'SourceVerificationOutput',
    arguments: JSON.stringify({request_fingerprint: prepared.fingerprint, results: [item]})}];
  return (await prepared.decode(blocks)).items[0];
}

test('省略主语句：引文全部来自同一发送者且模型判定的主体恰为该发送者时，按发送者定归属', async () => {
  const contactSaid = await verify([{sender: 'contact', text: '现在不太愿意干服务业'}], '联系人现在不太愿意干服务业。');
  assert.equal(contactSaid.admitted, true);
  assert.equal(contactSaid.result.verdict, 'supported');
  const ownerSaid = await verify([{sender: 'self', text: '专科的时候干过兼职'}], '用户本人专科的时候干过兼职。', {subject: 'self', actor: 'self'});
  assert.equal(ownerSaid.admitted, true);
  const twoMessages = await verify([{sender: 'contact', text: '专科的时候干过兼职'}, {sender: 'contact', text: '时薪二十五'}], '联系人专科的时候干过兼职，时薪二十五。');
  assert.equal(twoMessages.admitted, true, '多条引文同一发送者');
});

test('发送者兜底的门槛：explicit 自签、发送者不一致、含你／您、复数、第三方、未消解、混合发送者均仍拒绝', async () => {
  const rejected = item => {assert.equal(item.admitted, false);assert.ok(item.result.issues.includes('subject'));};
  rejected(await verify([{sender: 'contact', text: '现在不太愿意干服务业'}], '用户本人现在不太愿意干服务业。', {subject: 'self', actor: 'self'}));
  rejected(await verify([{sender: 'contact', text: '你现在不太愿意干服务业'}], '联系人现在不太愿意干服务业。'));
  rejected(await verify([{sender: 'contact', text: '您现在不太愿意干服务业'}], '联系人现在不太愿意干服务业。'));
  rejected(await verify([{sender: 'contact', text: '我们现在不太愿意干服务业'}], '联系人现在不太愿意干服务业。'));
  rejected(await verify([{sender: 'contact', text: '现在不太愿意干服务业'}], '联系人的闺蜜现在不太愿意干服务业。', {actor: 'third_party'}));
  rejected(await verify([{sender: 'contact', text: '现在不太愿意干服务业'}], '联系人现在不太愿意干服务业。', {resolution: 'unresolved'}));
  rejected(await verify([{sender: 'contact', text: '现在不太愿意干服务业'}], '联系人现在不太愿意干服务业。', {resolution: 'explicit'}));
  rejected(await verify([{sender: 'contact', text: '现在不太愿意干服务业'}, {sender: 'self', text: '我也是'}], '联系人现在不太愿意干服务业。'));
});
