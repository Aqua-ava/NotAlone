import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, profilePayload, ids, TraceController, MemoryUpgradeController, observeMemoryUpgradeDeletion,
  SkillLearningController, coordinateSkillLearningDeletion } from './support.mjs';
import { algorithm } from '../memory-upgrade/algorithm-fixture.mjs';

for (const scope of ['contact', 'owner']) for (const action of ['summary-error', 'fact-error']) {
  test(`${scope}/${action} 沿生产删除协调撤旧追踪升级和技能，迟到请求不能复活`, async () => {
    let finishWrite;
    const f = await fixture(async request => request.method === 'POST' ? new Promise(resolve => { finishWrite = resolve; })
      : { generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact }) });
    const late = [], signals = [];
    let pending = false, reads = 0;
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
      reads++;
      const data = request.path.includes('memory-traces') ? { trace_id: ids.work, contact_id: ids.contact,
        status: 'succeeded', events: [{ stage: 'model_response', payload: '合成旧追踪正文。' }] }
        : request.path.includes('memory-upgrades') ? { jobs: [{ algorithm, job_id: ids.work,
          scope: { kind: 'contact', contact_id: ids.contact }, revision: 1, state: 'active',
          budget: { message_limit: 10, batch_size: 5, model_calls: 4 }, model_calls_used: 0, batches: [] }] }
          : { enabled: true, scope_revision: 1, drafts: [], task: null, recent_outcomes: [] };
      const result = { generation: 1, data };
      if (pending) { signals.push(request.signal); return new Promise(resolve => late.push(() => resolve(result))); }
      return result;
    } };
    const trace = new TraceController(backend, f.contacts), upgrades = new MemoryUpgradeController(backend, f.contacts),
      learning = new SkillLearningController(backend, f.contacts);
    f.controller.onRecordDeletion(phase => trace.recordDeletionChanged(phase));
    observeMemoryUpgradeDeletion(f.controller, upgrades);
    coordinateSkillLearningDeletion(learning, f.controller, { onSessionDeletion: () => () => {}, onStateChanged: () => () => {} },
      { started() {}, async settled() {} });
    const selection = f.selection(), traceRequest = { ...selection, resource: 'memory-traces', batchId: ids.work },
      upgradeRequest = { ...selection, kind: 'contact' };
    await Promise.all([trace.show(traceRequest), upgrades.refresh(upgradeRequest), learning.refresh(selection)]);
    assert.ok(trace.getState().detail);
    assert.equal(upgrades.getState().jobs.length, 1);
    assert.equal(learning.getState().enabled, true);
    pending = true;
    const oldReads = [trace.show(traceRequest), upgrades.refresh(upgradeRequest), learning.refresh(selection)];
    if (scope === 'owner') await f.bridge.readOwnerLayeredMemory({}); else await f.bridge.readLayeredMemory(selection);
    const command = { action, settingsGeneration: 1, organizationGeneration: 1, targetKind: 'scenario',
      versionId: ids.version, itemIndex: 0, ...(action === 'summary-error' ? { reason: '合成整理错误。', operationId: ids.other } : { memoryId: ids.memory }) };
    const writing = scope === 'owner' ? f.bridge.manageOwnerLayeredMemory(command) : f.bridge.manageLayeredMemory({ ...selection, ...command });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(trace.getState().detail, null);
    assert.deepEqual(upgrades.getState().jobs, []);
    assert.equal(learning.getState().enabled, false);
    assert.equal(signals.length, 3);
    assert.ok(signals.every(signal => signal.aborted));
    const blockedReads = reads;
    await assert.rejects(trace.show(traceRequest));
    await upgrades.refresh(upgradeRequest); await learning.refresh(selection);
    assert.equal(reads, blockedReads);
    finishWrite({ generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact, scenarios: [], profile: null }) });
    await writing;
    late.forEach(finish => finish()); await Promise.all(oldReads);
    assert.equal(trace.getState().detail, null);
    assert.deepEqual(upgrades.getState().jobs, []);
    assert.equal(learning.getState().enabled, false);
    f.disconnect();
  });
}
