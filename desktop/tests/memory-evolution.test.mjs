import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { ids } from './layered-memory/support.mjs';
const built = await build({ stdin: { contents: `export { memoryTemporalFields, listedMemories, pendingCandidates, memoryVersions } from './src/main/memory/read';`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const evolution = { version: 1, kind: 'state_change', explanation: '出差已结束，未撤销原通话偏好。', related_versions: [{ memory_id: ids.memory, revision: 2 }], evidence_message_ids: [ids.version], source_supported: true, claim_changed: false, condition_changed: true };
const memory = level => ({ memory_id: ids.memory, level, ...(level === 'contact' ? { contact_id: ids.contact } : {}), text: '出差期间不便通话。', category: 'taboo', topic: 'other', source_ids: [ids.memory], status: 'active', adoption_method: 'auto', confidence: 1, risk_flags: [], revision: 3, supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null, evolution, timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } });
test('正式资料、候选、版本和冻结读取保留变化依据，条件变化不改变原主张', () => {
  const results = [mod.exports.memoryTemporalFields({ evolution }),
    ...['contact', 'owner'].flatMap(level => [mod.exports.listedMemories({ memories: [memory(level)] }, level, ids.contact)[0], mod.exports.memoryVersions({ versions: [memory(level)] }, level, ids.contact)[0]]),
    mod.exports.pendingCandidates({ candidates: [{ ...memory('contact'), candidate_id: ids.memory, status: 'pending', subject: 'contact' }] })[0]];
  for (const value of results) assert.deepEqual(value.evolution, { version: 1, kind: 'state_change', explanation: '出差已结束，未撤销原通话偏好。', relatedVersions: [{ memoryId: ids.memory, revision: 2 }], evidenceMessageIds: [ids.version], sourceSupported: true, claimChanged: false, conditionChanged: true });
  assert.equal(mod.exports.memoryTemporalFields({}).evolution, null);
  assert.equal(mod.exports.memoryTemporalFields({ evolution: null }).evolution, null);
});
test('新变化合同拒绝畸形、重复或无界依据，保持来源认证边界', () => {
  for (const malformed of [
    { ...evolution, explanation: '字'.repeat(1001) }, { ...evolution, explanation: ' ' },
    { ...evolution, related_versions: [] }, { ...evolution, related_versions: Array(9).fill(evolution.related_versions[0]) },
    { ...evolution, related_versions: [evolution.related_versions[0], evolution.related_versions[0]] },
    { ...evolution, related_versions: [{ memory_id: ids.memory, revision: 1 }, { memory_id: ids.memory, revision: 2 }] },
    { ...evolution, related_versions: [{ memory_id: ids.memory, revision: 0 }] },
    { ...evolution, related_versions: [{ ...evolution.related_versions[0], current: true }] },
    { ...evolution, evidence_message_ids: [ids.version, ids.version] },
    { ...evolution, evidence_message_ids: Array.from({ length: 61 }, (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`) },
    { ...evolution, evidence_message_ids: ['not-a-message'] }, { ...evolution, evidence_message_ids: [] },
    { ...evolution, version: 2 }, { ...evolution, kind: 'state_changed' }, { ...evolution, current: true },
    { ...evolution, source_supported: 'true' }, { ...evolution, claim_changed: 1 }, { ...evolution, condition_changed: null },
  ]) assert.throws(() => mod.exports.memoryTemporalFields({ evolution: malformed }), undefined, JSON.stringify(malformed));
  assert.equal(mod.exports.memoryTemporalFields({ evolution: { ...evolution, source_supported: false, evidence_message_ids: [] } }).evolution.sourceSupported, false);
});
