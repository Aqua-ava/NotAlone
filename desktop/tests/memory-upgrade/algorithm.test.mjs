import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { MemoryUpgradeController } from './src/main/memory-upgrade/controller';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { MemoryUpgradeController } = module.exports;
const algorithm = { version: 1, digest: 'a'.repeat(64), protocol: 'grounded-labels-v3/source-event-v1',
  compiler: 'grounded-source-event-v1', verification_mode: 'legacy-v4', configuration: {} };

function fixture(transform = value => value) {
  const contactId = randomUUID();
  const selection = { kind: 'contact', contactId, scopeRevision: 1 };
  const job = { job_id: randomUUID(), scope: { kind: 'contact', contact_id: contactId }, revision: 2,
    state: 'active', budget: { message_limit: 1, batch_size: 1, model_calls: 4 }, model_calls_used: 2,
    algorithm, batches: [{ batch_id: randomUUID(), revision: 2, state: 'ready', number: 1, contact_id: contactId,
      message_count: 1, comparison: null, task_status: 'succeeded', current_step: 'verify_upgrade_preview',
      error_code: null, algorithm: structuredClone(algorithm) }] };
  const calls = [];
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    calls.push(request);
    return { generation: 1, data: request.method === 'GET' ? { jobs: [transform(structuredClone(job))] } : job };
  } };
  const contacts = { getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
    directoryPhase: 'ready', contacts: [{ contactId }] }), onStateChanged: () => () => {} };
  return { controller: new MemoryUpgradeController(backend, contacts), selection, job, calls };
}

for (const [name, transform] of [
  ['缺少算法身份', job => { delete job.algorithm; return job; }],
  ['批次身份与工作不同', job => { job.batches[0].algorithm.digest = 'b'.repeat(64); return job; }],
  ['无效摘要', job => { job.algorithm.digest = 'unknown'; return job; }],
]) test(`${name}不能变成可批准的工作`, async () => {
  const { controller, selection, job, calls } = fixture(transform);
  await controller.refresh(selection);
  assert.equal(controller.getState().phase, 'failed');
  assert.deepEqual(controller.getState().jobs, []);
  await assert.rejects(controller.operate({ ...selection, jobId: job.job_id, expectedRevision: job.revision,
    confirmed: true, action: 'apply', batches: [{ batch_id: job.batches[0].batch_id, expected_revision: 2 }] }));
  assert.equal(calls.length, 1);
});

test('批准采用展示批次的修订，客户端不提供可替换服务端算法的身份', async () => {
  const { controller, selection, job, calls } = fixture();
  await controller.refresh(selection);
  assert.deepEqual(controller.getState().jobs[0].algorithm, algorithm);
  await controller.operate({ ...selection, jobId: job.job_id, expectedRevision: job.revision,
    confirmed: true, action: 'apply', batches: [{ batch_id: job.batches[0].batch_id, expected_revision: 2 }] });
  assert.equal(calls[1].body.expected_revision, 2);
  assert.equal(Object.hasOwn(calls[1].body, 'algorithm'), false);
});

test('旧未知算法可回看，应用必须先重新比较', async () => {
  const { controller, selection, job, calls } = fixture(value => {
    value.algorithm = null; value.batches[0].algorithm = null; return value;
  });
  await controller.refresh(selection);
  assert.equal(controller.getState().phase, 'ready');
  await assert.rejects(controller.operate({ ...selection, jobId: job.job_id, expectedRevision: job.revision,
    confirmed: true, action: 'apply', batches: [{ batch_id: job.batches[0].batch_id, expected_revision: 2 }] }), /算法身份未知/);
  assert.equal(calls.length, 1);
});
