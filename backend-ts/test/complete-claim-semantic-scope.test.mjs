import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDirectExtraction} from '../src/extraction-protocol.ts';
import {prepareSourceVerification} from '../src/complete-claim-verification.ts';
import {attachVerifiedSourceReceipt} from '../src/extraction-evidence.ts';
import {deepSeekStrictVerificationSchema} from '../src/deepseek-strict-verification.ts';
import {resolveExtractionPolicy} from '../src/extraction-policy-version.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-4333-8333-333333333333';
const policy = {id: 'complete-claim-v1', rule_version: 'a'.repeat(64)};

function scenario({source = '这张通行证上印着 Z。', candidate = source,
  sender = 'contact', scene = '通行证标记', messageId = message, ...overrides} = {}) {
  const window = {owner_id: owner, contact_id: contact, target_message_ids: [messageId], messages: [{
    message_id: messageId, sender, occurred_at: null, text_representation: 'text', text: source,
  }]};
  const raw = {text: candidate, subject: 'contact', category: 'relationship_note', topic: 'other',
    source_message_ids: [messageId], confidence: 0.8, risk_flags: [], valid_at: null, invalid_at: null,
    speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal', alternatives: [],
    interpretation_reason: '仅保留通行证上的字样，未确定标记含义。', event: null, conditions: null,
    ...overrides};
  const {accepted: facts} = parseDirectExtraction({scenes: [{scene_name: scene, memories: [raw]}]}, window);
  assert.equal(facts.length, 1);
  return {window, facts};
}

const semanticFields = ['category', 'topic', 'scene_name', 'alternatives', 'interpretation_reason',
  'valid_at', 'invalid_at', 'speech_act', 'assertion_status', 'figurative_type', 'event', 'conditions'];
const facet = (verdict = 'supported', evidence_indices = [0]) => ({verdict, evidence_indices});
const completeFields = () => Object.fromEntries(semanticFields.map(field => [field, facet()]));
const mention = (kind = 'literal_subject', sourceStart = 0, sourceEnd = 2, candidateStart = 0, candidateEnd = 2) => ({
  kind, evidence_index: 0, source_span: {start: sourceStart, end: sourceEnd},
  candidate_span: {start: candidateStart, end: candidateEnd},
});
function response(input, prepared, {version = 2, fields = completeFields(), attribution = {}} = {}) {
  const claim_check = {version, parts: [{candidate_span: {start: 0, end: [...input.facts[0].text].length},
    attribution: {...facet(), scope_subject: input.facts[0].subject === 'self' ? 'self' : 'contact',
      actor_kind: 'third_party', resolution: 'explicit', subject_mentions: [mention()], ...attribution},
    arguments_and_relation: facet(), temporal_and_modality: facet(),
  }], ...(fields ? {field_checks: fields} : {})};
  return [{type: 'tool-call', name: 'SourceVerificationOutput', arguments: JSON.stringify({
    request_fingerprint: prepared.fingerprint, results: [{candidate_index: 0, verdict: 'supported', issues: [],
      evidence: [{message_id: input.facts[0].source_message_ids[0], quote: input.window.messages[0].text}], claim_check}],
  })}];
}

test('现代核验请求包含完整提议；场景、解释及备选含义不能只留在 E', () => {
  const input = scenario({topic: 'finance', scene: '金融标记', alternatives: ['Z 可能表示账户等级'],
    interpretation_reason: '把 Z 理解为金融等级。', confidence: 0.07, risk_flags: ['sensitive']});
  const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
  const payload = JSON.parse(prepared.request.user), candidate = payload.candidates[0];
  assert.equal(candidate.scene_name, '金融标记');
  assert.equal(candidate.interpretation_reason, '把 Z 理解为金融等级。');
  assert.deepEqual(candidate.alternatives, ['Z 可能表示账户等级']);
  assert.equal(candidate.confidence, 0.07);
  assert.deepEqual(candidate.risk_flags, ['sensitive']);
  assert.equal(candidate.source_dependency_mode, 'any');
  assert.equal(candidate.requires_all_sources, true);
  assert.deepEqual(candidate.timing, input.facts[0].timing);
  assert.equal(candidate.event, null);
  assert.equal(candidate.conditions, null);
});

test('正文忠实也不能在语义元数据尚未逐项核验时接纳', async () => {
  const input = scenario({source: '陈禾说这张通行证上印着 Z。', topic: 'finance', scene: '金融标记'});
  const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
  assert.equal((await prepared.decode(response(input, prepared, {version: 1, fields: null}))).items[0].admitted, false);
});

test('每个语义字段的未定或无支持都否决整体；结构配置与忠实未知不判假', async () => {
  const input = scenario({source: '陈禾说展演日期还没有确定。', confidence: 0, risk_flags: ['synthetic-risk'],
    scene: '展演日期', interpretation_reason: '陈禾表示展演日期仍未知。'});
  for (const field of semanticFields) {
    for (const verdict of ['supported', 'uncertain', 'unsupported']) {
      const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
      const fields = completeFields();
      fields[field] = facet(verdict);
      const item = (await prepared.decode(response(input, prepared, {fields}))).items[0];
      assert.equal(item.admitted, verdict === 'supported', `${field}: ${verdict}`);
      assert.equal(item.result.model_verdict, 'supported');
      assert.equal(item.result.verdict, verdict);
    }
  }
});

test('省略语义主体不能靠发言者身份与 explicit 自签通过', async () => {
  const input = scenario({source: '这项安排谈不上省心。', candidate: '用户近期状态不佳。', sender: 'self',
    subject: 'self', category: 'recent_state', topic: 'emotion', scene: '近期状态',
    interpretation_reason: '将对安排的评价扩为用户近期状态。'});
  const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
  const item = (await prepared.decode(response(input, prepared, {attribution: {actor_kind: 'self', subject_mentions: []}}))).items[0];
  assert.equal(item.admitted, false);
  assert.equal(item.result.verdict, 'uncertain');
  assert.equal(item.result.claim_validation.status, 'checked');
});

test('实际第一人称和第三方主体有据可接受；任意重合字与发言者标签不能充当指代依据', async () => {
  const examples = [
    {source: '我最近状态不佳。', candidate: '用户最近状态不佳。', sender: 'self', subject: 'self',
      actor_kind: 'self', mentions: [mention('first_person', 0, 1, 0, 2)]},
    {source: '我最近状态不佳。', candidate: '联系人最近状态不佳。', sender: 'contact',
      actor_kind: 'contact', mentions: [mention('first_person', 0, 1, 0, 3)]},
    {source: '陈禾最近状态不佳。', actor_kind: 'third_party', mentions: [mention()]},
    {source: '陈禾说展演日期还没定。', actor_kind: 'third_party', mentions: [mention()]},
    {source: '这项安排谈不上省心。', candidate: '用户近期状态不佳。', sender: 'self', subject: 'self',
      actor_kind: 'self', mentions: [mention('first_person', 0, 1, 0, 2)], admitted: false},
    {source: '这项安排谈不上省心。', candidate: '用户近期状态不佳。', sender: 'self', subject: 'self',
      actor_kind: 'self', mentions: [mention('literal_subject', 6, 7, 6, 7)], admitted: false},
    {source: '我最近状态不佳。', candidate: '用户最近状态不佳。', sender: 'contact', subject: 'self',
      actor_kind: 'self', mentions: [mention('first_person', 0, 1, 0, 2)], admitted: false},
  ];
  for (const example of examples) {
    const {actor_kind, mentions, admitted = true, ...data} = example;
    const input = scenario(data), prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
    const item = (await prepared.decode(response(input, prepared, {attribution: {actor_kind, subject_mentions: mentions}}))).items[0];
    assert.equal(item.admitted, admitted, JSON.stringify(example));
  }
});

test('完成核验后替换场景不能复用原接纳资格', async () => {
  const input = scenario({source: '陈禾说通行证上印着 Z。'});
  input.window.messages[0].message_type = 'text';
  input.window.messages[0].source_snapshots = [{source_ref_id: '44444444-4444-4444-8444-444444444444',
    source_id: '55555555-5555-4555-8555-555555555555', source_kind: 'source_document', locator: 'synthetic:1',
    raw_payload: {synthetic: true}, source_content_sha256: 'b'.repeat(64)}];
  const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
  const item = (await prepared.decode(response(input, prepared))).items[0];
  assert.equal(item.admitted, true);
  assert.ok(attachVerifiedSourceReceipt(input.window, input.facts[0], item.result).verified_source_receipt);
  assert.throws(() => attachVerifiedSourceReceipt(input.window, {...input.facts[0], _scene_name: '金融等级'}, item.result), /unbound_admission/);
});

test('元数据缺项、非法证据和额外字段逐项失败；空值不要求补造来源事实', async () => {
  const input = scenario({source: '陈禾说展演日期尚未确定。'});
  for (const failure of ['missing', 'extra', 'out_of_bounds', 'nonempty_without_evidence', 'empty_values']) {
    const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
    const fields = completeFields();
    if (failure === 'missing') delete fields.topic;
    if (failure === 'extra') fields.confidence = facet();
    if (failure === 'out_of_bounds') fields.scene_name.evidence_indices = [1];
    if (failure === 'nonempty_without_evidence') fields.topic.evidence_indices = [];
    if (failure === 'empty_values') for (const name of ['alternatives', 'event', 'conditions', 'valid_at', 'invalid_at']) fields[name].evidence_indices = [];
    const item = (await prepared.decode(response(input, prepared, {fields}))).items[0];
    assert.equal(item.admitted, failure === 'empty_values', failure);
  }
});

test('主体位置按Unicode码点绑定当前段与实际引文，错误提及不能越界或串证据', async () => {
  const input = scenario({source: '🙂陈禾说展演日期还没定。'});
  for (const failure of ['valid', 'utf16', 'source_bounds', 'candidate_bounds', 'evidence', 'extra', 'unresolved']) {
    const attribution = {subject_mentions: [mention('literal_subject', 1, 3, 1, 3)]};
    const ref = attribution.subject_mentions[0];
    if (failure === 'utf16') ref.source_span = {start: 2, end: 4};
    if (failure === 'source_bounds') ref.source_span.end = 99;
    if (failure === 'candidate_bounds') ref.candidate_span.start = -1;
    if (failure === 'evidence') ref.evidence_index = 1;
    if (failure === 'extra') ref.sender = 'contact';
    if (failure === 'unresolved') attribution.resolution = 'unresolved';
    const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
    assert.equal((await prepared.decode(response(input, prepared, {attribution}))).items[0].admitted, failure === 'valid', failure);
  }
});

test('主体依据沿用既有UUID规范化，不把合法来源大小写差异判为无依据', async () => {
  const input = scenario({source: '我最近状态不佳。', candidate: '用户最近状态不佳。', sender: 'self', subject: 'self',
    messageId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'});
  const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
  const item = (await prepared.decode(response(input, prepared, {attribution: {actor_kind: 'self',
    subject_mentions: [mention('first_person', 0, 1, 0, 2)]}}))).items[0];
  assert.equal(item.admitted, true);
});

test('主体提及不能裁掉复数限定、把人称标为第三方，或借重复短引句猜定位', async () => {
  for (const example of [
    {source: '我们最近状态不佳。', candidate: '用户最近状态不佳。', subject: 'self', actor: 'self',
      ref: mention('first_person', 0, 1, 0, 2)},
    {source: '我们最近状态不佳。', candidate: '用户最近状态不佳。', subject: 'self', actor: 'self',
      ref: mention('first_person', 0, 1, 0, 2), quote: '我'},
    {source: '我最近状态不佳。', actor: 'third_party', ref: mention('literal_subject', 0, 1, 0, 1)},
    {source: '陈禾到了，陈禾随后坐下。', candidate: '陈禾坐下。', actor: 'third_party', ref: mention(), quote: '陈禾'},
    {source: '我们最近状态不佳。', subject: 'shared', actor: 'shared',
      ref: mention('first_person', 0, 2, 0, 2), admitted: true},
  ]) {
    const {actor, ref, quote, admitted = false, ...data} = example;
    const input = scenario({...data, sender: 'self'}), prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
    const blocks = response(input, prepared, {attribution: {actor_kind: actor, subject_mentions: [ref]}});
    if (quote) {
      const value = JSON.parse(blocks[0].arguments);
      value.results[0].evidence[0].quote = quote;
      blocks[0].arguments = JSON.stringify(value);
    }
    assert.equal((await prepared.decode(blocks)).items[0].admitted, admitted, JSON.stringify(example));
  }
});

test('单项元数据未定或结构错误不污染相邻有据候选', async () => {
  for (const invalid of [false, true]) {
    const input = scenario({source: '陈禾说展演日期仍未知。'});
    input.facts.push(structuredClone(input.facts[0]));
    const prepared = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
    const blocks = response(input, prepared), value = JSON.parse(blocks[0].arguments);
    const second = structuredClone(value.results[0]);
    second.candidate_index = 1;
    if (invalid) delete value.results[0].claim_check.field_checks.topic;
    else value.results[0].claim_check.field_checks.topic.verdict = 'uncertain';
    value.results.unshift(second);
    blocks[0].arguments = JSON.stringify(value);
    const items = (await prepared.decode(blocks)).items;
    assert.deepEqual(items.map(item => [item.candidate_index, item.admitted]), [[0, false], [1, true]]);
  }
});

test('新schema仍可编译strict合同，旧null/v1与nullable请求不升级到新语义合同', async () => {
  const input = scenario({source: '陈禾说展演日期还没定。'});
  const modern = prepareSourceVerification({...input, policy, requireCurrent: async () => {}});
  const schema = deepSeekStrictVerificationSchema(modern.request.tool.parameters);
  const check = schema.properties.results.items.properties.claim_check;
  assert.deepEqual(check.properties.version.enum, [2]);
  assert.deepEqual(check.properties.field_checks.required, semanticFields);
  function closed(node) {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(closed);
    }
    if (node.items) closed(node.items);
    node.anyOf?.forEach(closed);
  }
  closed(schema);
  for (const config of [null, {version: 1, mode: 'legacy', rule_set_sha256: null},
    {version: 1, mode: 'bounded-runtime-v1', rule_set_sha256: 'b'.repeat(64)}]) {
    const legacy = prepareSourceVerification({...input, policy: resolveExtractionPolicy(config, 'a'.repeat(64)).verification,
      requireCurrent: async () => {}});
    const payload = JSON.parse(legacy.request.user);
    assert.equal(Object.hasOwn(payload, 'request_fingerprint'), false);
    assert.equal(Object.hasOwn(payload.candidates[0], 'scene_name'), false);
    assert.equal(Object.hasOwn(legacy.request.tool.parameters.properties.results.items.properties, 'claim_check'), false);
    assert.notEqual(legacy.fingerprint, modern.fingerprint);
  }
});
