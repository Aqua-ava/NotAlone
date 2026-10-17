import { algorithm } from './algorithm-fixture.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { MemoryReadingController } from './src/main/memory/controller';
  export { MemoryUpgradeController } from './src/main/memory-upgrade/controller';
  export { observeMemoryUpgradeDeletion } from './src/main/memory-upgrade/deletion';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { MemoryReadingController, MemoryUpgradeController, observeMemoryUpgradeDeletion } = module.exports;

for (const kind of ['contact', 'owner']) for (const lostAcknowledgement of [false, true]) {
  test(`${kind}人工资料删除未决时新读取不恢复比较，${lostAcknowledgement ? '响应未知' : '成功'}后可重读`, async () => {
    const contactId = randomUUID(), memoryId = randomUUID(), jobId = randomUUID(), batchId = randomUUID();
    const secret = '合成人工资料待删除';
    let committed = false, finishDeletion, upgradeReads = 0;
    const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
      directoryPhase: 'ready', contacts: [{ contactId }] }), onStateChanged: () => () => {} };
    const previous = { memory_id: memoryId, level: kind, contact_id: contactId, text: secret,
      category: 'relationship_note', topic: 'other', status: 'active', adoption_method: 'manual', revision: 2,
      source_ids: [randomUUID()], confidence: 1, risk_flags: [], valid_at: null, invalid_at: null,
      supersedes_memory_id: null, source_candidate_id: null, timing: { recorded_at: null,
        source_started_at: null, source_ended_at: null, source_time_complete: false,
        current_status: 'current_unverified', current_status_reason: '合成旧依据。' } };
    const job = { algorithm, job_id: jobId, scope: { kind, contact_id: kind === 'contact' ? contactId : null },
      revision: 1, state: 'active', budget: { message_limit: 1, batch_size: 1, model_calls: 2 }, model_calls_used: 1,
      batches: [{ algorithm, batch_id: batchId, contact_id: contactId, revision: 1, number: 1, message_count: 1,
        state: 'ready', task_status: 'succeeded', current_step: 'verify_upgrade_preview', error_code: null,
        comparison: { version: 1, actions: [], current_count: 1, current: [{ memory_id: memoryId,
          text: secret, revision: 2, adoption_method: 'manual', proof_kind: 'unknown', scope_kind: kind,
          source_ids: previous.source_ids }] } }] };
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async (request) => {
      if (request.path.startsWith('/api/memory-upgrades')) {
        upgradeReads++;
        return { generation: 1, data: { jobs: [committed ? { ...job, revision: 2,
          batches: [{ ...job.batches[0], revision: 2, state: 'invalidated', task_status: 'cancelled', comparison: null }] } : job] } };
      }
      if (request.method === 'POST') return new Promise((resolve, reject) => {
        finishDeletion = () => { committed = true;
          if (lostAcknowledgement) reject(new Error('合成删除响应未知。'));
          else resolve({ generation: 1, data: {} });
        };
      });
      return { generation: 1, data: request.path.endsWith('/memory-candidates')
        ? { candidates: [] } : { memories: committed ? [] : [previous] } };
    } };
    const memory = new MemoryReadingController(backend, contacts);
    const upgrades = new MemoryUpgradeController(backend, contacts);
    observeMemoryUpgradeDeletion(memory, upgrades);
    if (kind === 'owner') upgrades.selectScope('owner');
    const selection = { contactId, scopeRevision: 1 };
    const upgradeSelection = { kind, contactId: kind === 'contact' ? contactId : null, scopeRevision: 1 };
    await memory.refresh({ ...selection, section: kind });
    await upgrades.refresh(upgradeSelection);
    assert.equal(upgrades.getState().jobs[0].batches[0].comparison.current[0].text, secret);
    const deleting = memory.remove({ ...selection, level: kind, memoryId, revision: 2 });
    try {
      assert.equal(typeof finishDeletion, 'function');
      assert.deepEqual(upgrades.getState().jobs, []);
      const before = upgradeReads;
      await upgrades.refresh(upgradeSelection);
      assert.deepEqual(upgrades.getState().jobs, [], '删除提交前的新GET不能恢复刚撤下的人工比较');
      assert.equal(upgradeReads, before, '未决删除期间不能重新读取正文');
    } finally { finishDeletion(); await deleting; }
    await upgrades.refresh(upgradeSelection);
    assert.equal(upgrades.getState().phase, 'ready');
    assert.equal(upgrades.getState().jobs[0].batches[0].comparison, null);
    assert.doesNotMatch(JSON.stringify(upgrades.getState()), new RegExp(secret));
  });
}

test('重叠删除跨范围切换仍阻止读取，旧GET迟到与单次settled不能解除保护', async () => {
  const contactId = randomUUID();
  let deletionChanged, releaseOldRead, reads = 0;
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }), onStateChanged: () => () => {} };
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async () => {
    reads++;
    if (reads === 1) return new Promise(resolve => { releaseOldRead = resolve; });
    return { generation: 1, data: { jobs: [] } };
  } };
  const upgrades = new MemoryUpgradeController(backend, contacts);
  observeMemoryUpgradeDeletion({ onRecordDeletion: listener => {
    deletionChanged = listener;
    return () => {};
  } }, upgrades);
  const pending = upgrades.refresh({ kind: 'contact', contactId, scopeRevision: 1 });
  deletionChanged('started');
  deletionChanged('started');
  upgrades.selectScope('owner');
  deletionChanged('settled');
  const owner = { kind: 'owner', contactId: null, scopeRevision: 1 };
  await upgrades.refresh(owner);
  assert.equal(reads, 1);
  releaseOldRead({ generation: 1, data: { jobs: [{ algorithm, job_id: randomUUID(),
    scope: { kind: 'contact', contact_id: contactId }, revision: 1, state: 'active',
    budget: { message_limit: 1, batch_size: 1, model_calls: 2 }, model_calls_used: 0, batches: [] }] } });
  await pending;
  assert.deepEqual(upgrades.getState().jobs, []);
  assert.equal(upgrades.getState().phase, 'idle');
  deletionChanged('settled');
  await upgrades.refresh(owner);
  assert.equal(reads, 2);
  assert.equal(upgrades.getState().phase, 'ready');
});
