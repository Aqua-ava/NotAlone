import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDirectExtraction} from '../src/memory/extraction/protocol.ts';
import {prepareSourceVerification} from '../src/memory/extraction/verification/complete-claim.ts';
import {assertCompleteClaimAdmission} from '../src/memory/extraction/verification/complete-claim.ts';
import {parseStoredJSON} from '../src/memory/evidence/canonical-json.ts';

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
  const span = (text, quote) => {
    const start = [...text.slice(0, text.indexOf(quote))].length;
    return {start, end: start + [...quote].length};
  };
  const firstPerson = example.source.includes('我'), shared = example.candidate.startsWith('联系人与');
  const subject_mentions = [{kind: firstPerson ? 'first_person' : 'literal_subject', evidence_index: 0,
    source_span: span(example.source, firstPerson ? '我' : '阿青'),
    candidate_span: firstPerson ? {start: 0, end: 3} : span(example.candidate, '阿青')}];
  if (shared) subject_mentions.push({kind: 'literal_subject', evidence_index: 0,
    source_span: span(example.source, '阿青'), candidate_span: span(example.candidate, '阿青')});
  const field_checks = Object.fromEntries(['category', 'topic', 'scene_name', 'alternatives', 'interpretation_reason',
    'valid_at', 'invalid_at', 'speech_act', 'assertion_status', 'figurative_type', 'event', 'conditions'].map(name => [name, facet('supported')]));
  const item = {candidate_index: 0, verdict: 'supported', issues: [],
    evidence: [{message_id: message, quote: example.source}],
    claim_check: {version: 2, field_checks, parts: [{candidate_span: {start: 0, end: [...example.candidate].length},
      attribution: {...facet('supported'), scope_subject: 'contact',
        actor_kind: shared ? 'shared' : firstPerson ? 'contact' : 'third_party', resolution: 'explicit', subject_mentions},
      arguments_and_relation: facet(facetVerdict), temporal_and_modality: facet(facetVerdict),
    }]}, ...patch};
  return [{type: 'tool-call', name: 'SourceVerificationOutput', arguments: JSON.stringify({
    results: [item],
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

test('时间核验不过只丢时间标注，正文候选仍按其余字段准入', async () => {
  const example = mechanism.cases[1];
  const event = {version: 2, stage: 'unknown', stage_evidence: [], occurrence_start: null, occurrence_end: null,
    occurrence_evidence: [], occurrence_precision: 'unknown', occurrence_expression: '明天', anchor_message_id: message};
  const {window, facts} = scenario(example, {event});
  assert.notEqual(facts[0].event, null);
  const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const output = blocks(prepared, example);
  // 核验模型如实把时间字段判为不确定；其余字段全部有据。时间不参与整条准入。
  const value = JSON.parse(output[0].arguments);
  value.results[0].claim_check.field_checks.event = {verdict: 'uncertain', evidence_indices: [0]};
  output[0].arguments = JSON.stringify(value);
  const checked = await prepared.decode(output);
  assert.equal(checked.items[0].admitted, true);
  assert.equal(checked.items[0].result.event, null);
  assert.equal(checked.items[0].result.time_unverified, true);
  assert.equal(checked.items[0].result.claim_validation.status, 'checked');
  assert.equal(checked.items[0].result.claim_validation.semantic_support, 'supported');
  assert.equal(checked.items[0].result.model_verdict, 'supported');
  assert.equal(checked.items[0].result.evidence.length, 1, '丢弃时间标注不能连带清空正文证据');
});

test('claim_check 判时间不确定时丢弃结构上已采纳的时间标注', async () => {
  const example = mechanism.cases[1];
  const event = {version: 2, stage: 'cancelled', stage_evidence: [], occurrence_start: null, occurrence_end: null,
    occurrence_evidence: [], occurrence_precision: 'unknown', occurrence_expression: null, anchor_message_id: null};
  const {window, facts} = scenario(example, {event});
  const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const output = blocks(prepared, example);
  const value = JSON.parse(output[0].arguments), item = value.results[0];
  item.event_verification = {stage_verdict: 'supported', occurrence_verdict: 'uncertain',
    stage_evidence: [{message_id: message, char_start: 0, char_end: 2}], occurrence_evidence: []};
  item.claim_check.field_checks.event = {verdict: 'supported', evidence_indices: [0]};
  output[0].arguments = JSON.stringify(value);
  const adopted = (await prepared.decode(output)).items[0];
  assert.equal(adopted.result.event?.stage, 'cancelled', '结构核验通过且 claim 支持时保留已取消事件');
  const dropped = JSON.parse(JSON.stringify(value));
  dropped.results[0].claim_check.field_checks.event = {verdict: 'uncertain', evidence_indices: [0]};
  const reprepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const droppedOutput = blocks(reprepared, example);
  droppedOutput[0].arguments = JSON.stringify(dropped);
  const checked = (await reprepared.decode(droppedOutput)).items[0];
  assert.equal(checked.admitted, true);
  assert.equal(checked.result.event, null, 'claim_check 判时间不确定时丢弃结构上已采纳的时间标注');
  assert.equal(checked.result.time_unverified, true);
  assert.equal(checked.result.claim_validation.status, 'checked');
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

test('响应末尾多余的收尾括号被丢弃，核验结论与逐字来源检查不变', async () => {
  const example = mechanism.cases[1], {window, facts} = scenario(example);
  const prepared = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const clean = blocks(prepared, example);
  const baseline = await prepared.decode(clean);
  for (const tail of ['}', ']}']) {
    const stray = [{...clean[0], arguments: clean[0].arguments + tail}];
    await prepared.request.validateOutput(stray);
    assert.deepEqual(await prepared.decode(stray), baseline);
  }
  // 丢弃尾部不会放过内容问题：引文不是逐字来源时仍拒绝，其他尾随内容仍判为非 JSON。
  const forged = blocks(prepared, example, 'supported', {evidence: [{message_id: message, quote: '来源里没有的虚构引文'}]});
  forged[0].arguments += '}';
  await assert.rejects(prepared.decode(forged), error => error.code !== 'extraction_arguments_invalid');
  const extra = [{...clean[0], arguments: clean[0].arguments + '}x'}];
  await assert.rejects(prepared.decode(extra), {code: 'extraction_arguments_invalid'});
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
  assert.doesNotThrow(()=>assertCompleteClaimAdmission(window,fact,result));
  assert.equal(result.claim_validation.status,'checked');
  assert.throws(()=>assertCompleteClaimAdmission(window,fact,structuredClone(result)),/unbound_admission/);
  for(const changed of [{...fact,text:fact.text+'其他内容'},{...fact,confidence:0.99},
    {...fact,source_message_ids:['66666666-6666-4666-8666-666666666666']}])
    assert.throws(()=>assertCompleteClaimAdmission(window,changed,result),/unbound_admission/);
  assert.throws(()=>assertCompleteClaimAdmission({...window,contact_id:window.owner_id},fact,result),/unbound_admission/);
  const changed=structuredClone(window);changed.messages[0].source_snapshots[0].raw_payload.changed=true;
  assert.throws(()=>assertCompleteClaimAdmission(changed,fact,result),/unbound_admission/);
});

test('覆盖按Unicode码点计数且本地准入不能跨来源复用', async () => {
  const example={source:'🙂阿青说日期还没定。',candidate:'🙂阿青说日期还没定。'};
  const {window,facts}=scenario(example),prepared=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}});
  const admitted=(await prepared.decode(blocks(prepared,example))).items[0];
  assert.equal(admitted.admitted,true);
  const invalid=prepareSourceVerification({window,facts,policy,requireCurrent:async()=>{}});
  const wrong=blocks(invalid,example),value=JSON.parse(wrong[0].arguments);
  value.results[0].claim_check.parts[0].candidate_span.end=example.candidate.length;
  wrong[0].arguments=JSON.stringify(value);
  assert.equal((await invalid.decode(wrong)).items[0].admitted,false);
  const changedWindow={...window,messages:[{...window.messages[0],text:'变化的来源'}]};
  const other=prepareSourceVerification({window:changedWindow,facts,policy,requireCurrent:async()=>{}});
  assert.notEqual(other.fingerprint,prepared.fingerprint);
  assert.throws(()=>assertCompleteClaimAdmission(changedWindow,facts[0],admitted.result),/unbound_admission/);
});

test('shared仍归联系人资料范围；旧事件未核验只丢时间，条件未核验仍拒绝',async()=>{
  const example={source:'我和阿青都喜欢绿茶。',candidate:'联系人与阿青都喜欢绿茶。'};
  const shared=scenario(example,{subject:'shared'}),prepared=prepareSourceVerification({...shared,policy,requireCurrent:async()=>{}});
  const response=blocks(prepared,example),value=JSON.parse(response[0].arguments);
  value.results[0].claim_check.parts[0].attribution.actor_kind='shared';
  response[0].arguments=JSON.stringify(value);
  assert.equal((await prepared.decode(response)).items[0].admitted,true);
  const ref={message_id:message,char_start:0,char_end:2};
  const eventInput=scenario(example,{event:{version:1,stage:'planned',stage_evidence:[ref],occurrence_start:null,occurrence_end:null,occurrence_evidence:[]}});
  const eventCheck=prepareSourceVerification({...eventInput,policy,requireCurrent:async()=>{}});
  const eventResult=(await eventCheck.decode(blocks(eventCheck,example))).items[0];
  assert.equal(eventResult.admitted,true,'时间标注未核验只丢时间，不拒绝正文候选');
  assert.equal(eventResult.result.event,null);
  assert.equal(eventResult.result.time_unverified,true);
  assert.equal(eventResult.result.model_verdict,'supported');
  const conditionInput=scenario(example,{conditions:{version:1,items:[{text:'合成条件',evidence:[ref]}]}});
  const conditionCheck=prepareSourceVerification({...conditionInput,policy,requireCurrent:async()=>{}});
  const conditionResult=(await conditionCheck.decode(blocks(conditionCheck,example))).items[0];
  assert.equal(conditionResult.admitted,false,'条件不属于可选时间标注，仍按准入拒绝');
  assert.equal(conditionResult.result.model_verdict,'supported');
  assert.equal(conditionResult.result.verdict,'unsupported');
});
