import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDirectExtraction} from '../src/extraction-protocol.ts';
import {prepareSourceVerification} from '../src/complete-claim-verification.ts';
import {attachVerifiedSourceReceipt} from '../src/extraction-evidence.ts';
import {parseStoredJSON} from '../src/contact-overview-evidence.ts';

const mechanism = JSON.parse(readFileSync(new URL('./fixtures/complete-claim-mechanism.json', import.meta.url)));
const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-4333-8333-333333333333';
const policy = {id: 'complete-claim-v1', rule_version: 'a'.repeat(64)};

function scenario(example, overrides = {}) {
  const window = {owner_id: owner, contact_id: contact, target_message_ids: [message], messages: [{
    message_id: message, sender: 'contact', occurred_at: null, text_representation: 'text', text: example.source,
  }]};
  const raw = {text: example.candidate, subject: 'contact', category: 'recent_state', topic: 'other',
    source_message_ids: [message], confidence: 0.8, risk_flags: [], valid_at: null, invalid_at: null,
    speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal', alternatives: [],
    interpretation_reason: '完全虚构的机制例。', event: null, conditions: null, ...overrides};
  const facts = parseDirectExtraction({scenes: [{scene_name: '虚构机制', memories: [raw]}]}, window).accepted;
  assert.equal(facts.length, 1);
  return {window, facts};
}

function blocks(prepared, example, facetVerdict = 'supported', patch = {}) {
  const facet = verdict => ({verdict, evidence_indices: [0]});
  const item = {candidate_index: 0, verdict: 'supported', issues: [],
    evidence: [{message_id: message, quote: example.source}],
    claim_check: {version: 1, parts: [{candidate_span: {start: 0, end: [...example.candidate].length},
      attribution: {...facet('supported'), scope_subject: 'contact', actor_kind: 'contact', resolution: 'explicit'},
      arguments_and_relation: facet(facetVerdict), temporal_and_modality: facet(facetVerdict),
    }]}, ...patch};
  return [{type: 'tool-call', name: 'SourceVerificationOutput', arguments: JSON.stringify({
    request_fingerprint: prepared.fingerprint, results: [item],
  })}];
}

test('完整命题核验聚合时间/认知模态负向判断，保留两个有据控制', async () => {
  for (const example of mechanism.cases) {
    const {window, facts} = scenario(example);
    const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
    const output = blocks(prepared, example, example.expected_verdict);
    const checked = await prepared.decode(output);
    assert.equal(prepared.request.tool.name, 'SourceVerificationOutput');
    assert.equal(prepared.request.purpose, 'verification');
    assert.equal(checked.items[0].admitted, example.expected_verdict === 'supported');
    assert.equal(checked.items[0].result.model_verdict, 'supported');
    assert.equal(checked.items[0].result.verification_mode, 'complete-claim-v1');
    assert.equal(checked.items[0].result.proof_verification, null);
    assert.equal(facts[0].event, null);
    assert.equal(facts[0].subject, 'contact');
  }
});

test('prepared decode 幂等并隔离返回值，不能在验证后交换另一份响应', async () => {
  const example = mechanism.cases[1], {window, facts} = scenario(example);
  const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const output = blocks(prepared, example);
  await prepared.request.validateOutput(output);
  const first = await prepared.decode(output);
  first.items[0].admitted = false;
  assert.equal((await prepared.decode(output)).items[0].admitted, true);
  await assert.rejects(prepared.decode(blocks(prepared, example, 'uncertain')), /response_changed/);
});

test('全文漏核、facet 缺项或未定、归属 unresolved 均不能被顶层 supported 覆盖', async () => {
  const example = mechanism.cases[1];
  for (const failure of ['gap', 'missing', 'uncertain', 'unresolved', 'scope']) {
    const {window, facts} = scenario(example);
    const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
    const output = blocks(prepared, example), value = JSON.parse(output[0].arguments);
    const part = value.results[0].claim_check.parts[0];
    if (failure === 'gap') part.candidate_span.end -= 2;
    if (failure === 'missing') delete part.temporal_and_modality;
    if (failure === 'uncertain') part.temporal_and_modality.verdict = 'uncertain';
    if (failure === 'unresolved') part.attribution.resolution = 'unresolved';
    if (failure === 'scope') part.attribution.scope_subject = 'self';
    output[0].arguments = JSON.stringify(value);
    assert.equal((await prepared.decode(output)).items[0].admitted, false, failure);
  }
});

test('新策略原生准入可签来源receipt，序列化字段或更换正文/范围/来源不能代签', async () => {
  const example=mechanism.cases[1],{window,facts}=scenario(example),fact=facts[0];
  window.messages[0].message_type='text';
  window.messages[0].source_snapshots=[{source_ref_id:'44444444-4444-4444-8444-444444444444',
    source_id:'55555555-5555-4555-8555-555555555555',source_kind:'source_document',locator:'synthetic:1',
    raw_payload:parseStoredJSON('{"synthetic":true,"id":900719925474099312345,"ratio":1.0}'),source_content_sha256:'b'.repeat(64)}];
  const prepared=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}});
  const result=(await prepared.decode(blocks(prepared,example))).items[0].result;
  const bound=attachVerifiedSourceReceipt(window,fact,result);
  assert.equal(bound.dimension_evidence.version,1);
  assert.equal(bound.dimension_evidence.source_bound,true);
  assert.ok(bound.verified_source_receipt);
  assert.equal(bound.dimension_evidence.semantic_basis,undefined);
  assert.throws(()=>attachVerifiedSourceReceipt(window,fact,structuredClone(result)),/unbound_admission/);
  for(const changed of [{...fact,text:fact.text+'其他内容'},{...fact,confidence:0.99},
    {...fact,source_message_ids:['66666666-6666-4666-8666-666666666666']}])
    assert.throws(()=>attachVerifiedSourceReceipt(window,changed,result),/unbound_admission/);
  assert.throws(()=>attachVerifiedSourceReceipt({...window,contact_id:window.owner_id},fact,result),/unbound_admission/);
  const changed=structuredClone(window);changed.messages[0].source_snapshots[0].raw_payload.changed=true;
  assert.throws(()=>attachVerifiedSourceReceipt(changed,fact,result),/unbound_admission/);
});

test('覆盖按Unicode码点计数且请求指纹不能跨候选或来源复用', async () => {
  const example={source:'🙂阿青说日期还没定。',candidate:'🙂阿青说日期还没定。'};
  const {window,facts}=scenario(example),prepared=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}});
  assert.equal((await prepared.decode(blocks(prepared,example))).items[0].admitted,true);
  const invalid=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}});
  const wrong=blocks(invalid,example),value=JSON.parse(wrong[0].arguments);
  value.results[0].claim_check.parts[0].candidate_span.end=example.candidate.length;
  wrong[0].arguments=JSON.stringify(value);
  assert.equal((await invalid.decode(wrong)).items[0].admitted,false);
  const other=prepareSourceVerification({window:{...window,messages:[{...window.messages[0],text:'变化的来源'}]},facts,policy,requireCurrent:async()=>{}});
  await assert.rejects(other.decode(blocks(prepared,example)),/fingerprint_mismatch/);
});

test('shared仍归联系人资料范围，三项supported也不能覆盖旧事件或条件未核验',async()=>{
  const example={source:'我和阿青都喜欢绿茶。',candidate:'联系人与阿青都喜欢绿茶。'};
  const shared=scenario(example,{subject:'shared'}),prepared=prepareSourceVerification({...shared,policy,requireCurrent:async()=>{}});
  const response=blocks(prepared,example),value=JSON.parse(response[0].arguments);
  value.results[0].claim_check.parts[0].attribution.actor_kind='shared';
  response[0].arguments=JSON.stringify(value);
  assert.equal((await prepared.decode(response)).items[0].admitted,true);
  const ref={message_id:message,char_start:0,char_end:2};
  for(const extra of [
    {event:{version:1,stage:'planned',stage_evidence:[ref],occurrence_start:null,occurrence_end:null,occurrence_evidence:[]}},
    {conditions:{version:1,items:[{text:'合成条件',evidence:[ref]}]}},
  ]){
    const input=scenario(example,extra),check=prepareSourceVerification({...input,policy,requireCurrent:async()=>{}});
    const result=(await check.decode(blocks(check,example))).items[0];
    assert.equal(result.admitted,false);
    assert.equal(result.result.model_verdict,'supported');
    assert.equal(result.result.verdict,'unsupported');
  }
});
