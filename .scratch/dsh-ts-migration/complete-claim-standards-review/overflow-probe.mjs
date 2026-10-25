import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

// 完全合成的超限返回，核对同一默认入口的失败合同。
const message = '33333333-3333-4333-8333-333333333333';
const window = {owner_id: '11111111-1111-4111-8111-111111111111',
  contact_id: '22222222-2222-4222-8222-222222222222', target_message_ids: [message],
  messages: [{message_id: message, sender: 'contact', occurred_at: null,
    message_type: 'text', text_representation: 'text', text: '合成联系人喜欢绿茶。'}]};
const memory = {text: '合成联系人喜欢绿茶。', subject: 'contact', category: 'preference',
  topic: 'other', source_message_ids: [message], confidence: 0.8, risk_flags: [],
  valid_at: null, invalid_at: null, speech_act: 'assertion', assertion_status: 'asserted',
  figurative_type: 'literal', alternatives: [], interpretation_reason: '合成协议探针。',
  event: null, conditions: null};
const output = [{type: 'tool-call', name: 'DirectMemoryExtractionOutput',
  arguments: JSON.stringify({scenes: [{scene_name: '合成场景',
    memories: Array.from({length: 61}, () => ({...memory}))}]})}];
const results = {};
for (const [label, root] of [['base', process.env.STANDARDS_BASE], ['candidate', process.env.STANDARDS_SNAPSHOT]]) {
  const {runExtractionFlow} = await import(pathToFileURL(join(root, 'backend-ts/src/extraction-flow.ts')).href);
  let extractionCalls = 0, verificationCalls = 0;
  try {
    const outcome = await runExtractionFlow({window, signal: new AbortController().signal,
      max_retries: 0, requireCurrent: async () => {}, record: async () => {},
      invoke: async request => {
        if (request.purpose === 'extraction') {extractionCalls++; return {blocks: output};}
        verificationCalls++; throw new Error('不应进入核验调用');
      }});
    results[label] = {returned: true, failure_kind: outcome.failure_kind,
      extraction_completed: outcome.extraction_completed, accepted: outcome.accepted.length,
      extractionCalls, verificationCalls};
  } catch (error) {
    results[label] = {returned: false, error_name: error.constructor.name,
      error_message: error.message, failure_kind: error.failure_kind,
      retryable: error.retryable === true, extractionCalls, verificationCalls};
  }
}
assert.equal(results.base.returned, true);
assert.equal(results.base.failure_kind, 'invalid_output');
assert.equal(results.candidate.returned, false);
assert.equal(results.candidate.error_message, 'complete_claim_policy_invalid');
assert.equal(results.candidate.retryable, false);
console.log(JSON.stringify({probe: 'legacy_61_candidate_failure_contract', reproduced: true,
  base_sha: 'd4e7690bd9f57a2fae66b04d348219476c0cb497',
  candidate_sha: 'bcc6701ce67249d18b51625c07f4cad4e401ad04', results}, null, 2));
