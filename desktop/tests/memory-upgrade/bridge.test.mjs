import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { algorithm } from './algorithm-fixture.mjs';

const compiled = await build({ stdin: { contents: `export { installMemoryUpgradeBridge } from './src/main/memory-upgrade/bridge';`,
  resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);

test('管理桥拒绝嵌套多余字段、伪造算法和未确认批准', async () => {
  const contactId = randomUUID(), handlers = new Map();
  const job = { algorithm, job_id: randomUUID(), scope: { kind: 'contact', contact_id: contactId }, revision: 1,
    state: 'active', budget: { message_limit: 1, batch_size: 1, model_calls: 4 }, model_calls_used: 0,
    batches: [{ algorithm, batch_id: randomUUID(), revision: 1, state: 'ready', number: 1, contact_id: contactId,
      message_count: 1, comparison: null, task_status: 'succeeded', current_step: 'verify_upgrade_preview', error_code: null }] };
  let requests = 0;
  module.exports.installMemoryUpgradeBridge({ handle: (channel, handler, role) => {
    assert.equal(role, 'manager'); handlers.set(channel, handler);
  }, publish() {} }, { onStateChanged() {}, getConnectionGeneration: () => 1,
    requestJson: async request => { requests++; return { generation: 1, data: request.method === 'GET' ? { jobs: [job] } : job }; } }, {
    onStateChanged() {}, getState: () => ({ selectedContactId: contactId, scopeRevision: 1,
      directoryPhase: 'ready', contacts: [{ contactId }] }),
  });
  const selection = { kind: 'contact', contactId, scopeRevision: 1 };
  await handlers.get('memory-upgrade:refresh')(selection);
  const request = { ...selection, budget: { message_limit: 1, batch_size: 1, model_calls: 4 }, confirmed: true };
  for (const malformed of [{ ...request, algorithm: 'client-override' },
    { ...request, budget: { ...request.budget, provider: 'unexpected' } }, { ...request, confirmed: false }]) {
    await assert.rejects(async () => handlers.get('memory-upgrade:prepare')(malformed));
  }
  const operation = { ...selection, jobId: job.job_id, action: 'apply', expectedRevision: 1,
    confirmed: true, batches: [{ batch_id: job.batches[0].batch_id, expected_revision: 1, algorithm: 'unexpected' }] };
  await assert.rejects(async () => handlers.get('memory-upgrade:operate')(operation));
  assert.equal(requests, 1);
});
