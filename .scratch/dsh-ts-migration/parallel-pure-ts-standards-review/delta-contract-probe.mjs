/** 只比较固定源码的默认合同及显式加严边界；不装配模型或数据库。 */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';

const snapshot = process.argv[2];
if (!snapshot) throw new Error('snapshot_required');
const current = await import(pathToFileURL(join(snapshot, 'backend-ts/src/extraction-protocol-contract.ts')));
const before = await import(pathToFileURL(join(snapshot, 'backend-ts/src/__standards_before_contract.ts')));
let comparisons = 0;
for (const requires_all_sources of [false, true]) {
  const facts = [{requires_all_sources, event: null, conditions: null}];
  const original = structuredClone(facts);
  for (const mode of ['legacy-v4', 'nullable-proof-v3']) {
    assert.deepEqual(current.buildSourceVerificationContract(facts, mode), before.buildSourceVerificationContract(facts, mode));
    comparisons++;
  }
  assert.deepEqual(current.buildSourceVerificationContract(facts), before.buildSourceVerificationContract(facts));
  assert.deepEqual(facts, original);
  assert.throws(() => current.buildSourceVerificationContract(facts, 'nullable-proof-v3', {require_complete_evidence: true}));
  assert.match(current.buildSourceVerificationContract(facts, 'legacy-v4', {require_complete_evidence: true}).prompt, /source_message_ids 中每条消息都须在 evidence/);
}
console.log(JSON.stringify({default_contract_comparisons: comparisons, inputs_unchanged: true, explicit_mode_restriction: true}));
