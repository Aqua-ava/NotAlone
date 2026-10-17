import { algorithm } from './algorithm-fixture.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { MemoryUpgradeController } from './src/main/memory-upgrade/controller';
  export { observeMemoryUpgradeDeletion } from './src/main/memory-upgrade/deletion';
  export { SourceDeletionController } from './src/main/sources/controller';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { MemoryUpgradeController, observeMemoryUpgradeDeletion, SourceDeletionController } = module.exports;

function fixture() {
  const contactId = randomUUID();
  const selection = { kind: 'contact', contactId, scopeRevision: 1 };
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }), onStateChanged: () => () => {} };
  const job = { algorithm, job_id: randomUUID(), scope: { kind: 'contact', contact_id: contactId }, revision: 1,
    state: 'active', budget: { message_limit: 2, batch_size: 1, model_calls: 4 }, model_calls_used: 0, batches: [] };
  return { contactId, selection, contacts, job };
}

for (const action of ['prepare', 'cancel']) test(`${action}已提交但响应未知时刷新恢复原动作，不建立新工作或追加预算`, async () => {
  const { selection, contacts, job } = fixture();
  const calls = [], receipts = new Set();
  let jobs = action === 'prepare' ? [] : [job], lost = false;
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    calls.push(structuredClone({ method: request.method, path: request.path, body: request.body }));
    if (request.method === 'GET') return { generation: 1, data: { jobs } };
    if (!receipts.has(request.body.operation_key)) {
      receipts.add(request.body.operation_key);
      jobs = [{ ...job, state: action === 'prepare' ? 'active' : 'cancelled', revision: 2 }];
    }
    if (!lost) { lost = true; throw new Error('合成已提交响应丢失'); }
    return { generation: 1, data: jobs[0] };
  } };
  const controller = new MemoryUpgradeController(backend, contacts);
  await controller.refresh(selection);
  if (action === 'prepare') await controller.prepare({ ...selection, budget: job.budget, confirmed: true });
  else await controller.operate({ ...selection, jobId: job.job_id, expectedRevision: 1, action,
    batches: [], confirmed: true });
  assert.equal(controller.getState().phase, 'failed');
  await controller.refresh(selection);
  const mutations = calls.filter(call => call.method !== 'GET');
  assert.equal(mutations.length, 2, '刷新须先重试原已授权动作');
  assert.deepEqual(mutations[1], mutations[0]);
  assert.equal(receipts.size, 1);
  assert.equal(controller.getState().jobs.length, 1);
  assert.equal(controller.getState().phase, 'ready');
});

test('来源删除已提交但响应未知时拒绝迟到升级GET，删除未决期间不重读旧比较', async () => {
  const { contactId, selection, contacts, job } = fixture();
  const sourceId = randomUUID();
  let finishDelete, finishRead, reads = 0, deleted = false;
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    if (request.path.startsWith('/api/memory-upgrades')) {
      if (++reads === 2) return new Promise(resolve => { finishRead = () => resolve({ generation: 1, data: { jobs: [job] } }); });
      return { generation: 1, data: { jobs: deleted ? [] : [job] } };
    }
    if (request.method === 'DELETE') return new Promise((_, reject) => {
      finishDelete = () => { deleted = true; reject(new Error('合成来源已删除，响应丢失')); };
    });
    return { generation: 1, data: { sources: [{ source_id: sourceId, file_name: 'synthetic.jsonl',
      record_count: 1, status: 'active', task_id: null }] } };
  } };
  const upgrades = new MemoryUpgradeController(backend, contacts);
  const sources = new SourceDeletionController(backend, contacts, async () => {});
  observeMemoryUpgradeDeletion({ onRecordDeletion: () => () => {} }, upgrades, sources);
  await sources.refresh(selection);
  await upgrades.refresh(selection);
  const oldRead = upgrades.refresh(selection);
  const deleting = sources.delete({ contactId, scopeRevision: 1, sourceId });
  assert.deepEqual(upgrades.getState().jobs, []);
  const before = reads;
  await upgrades.refresh(selection);
  assert.equal(reads, before);
  finishDelete(); await deleting;
  finishRead(); await oldRead;
  assert.deepEqual(upgrades.getState().jobs, [], '旧响应不能恢复已删除来源的比较正文');
  await upgrades.refresh(selection);
  assert.deepEqual(upgrades.getState().jobs, []);
});
