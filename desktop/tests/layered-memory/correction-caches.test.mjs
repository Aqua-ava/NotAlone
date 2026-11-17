import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, profilePayload, ids, TraceController } from './support.mjs';

for (const scope of ['contact', 'owner']) for (const action of ['summary-error', 'fact-error']) {
  test(`${scope}/${action} 沿生产删除协调撤旧追踪，迟到请求不能复活`, async () => {
    let finishWrite;
    const f = await fixture(async request => request.method === 'POST' ? new Promise(resolve => { finishWrite = resolve; })
      : { generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact }) });
    const late = [], signals = [];
    let pending = false, reads = 0;
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
      reads++;
      assert.ok(request.path.includes('memory-traces'));
      const data = { trace_id: ids.work, contact_id: ids.contact,
        status: 'succeeded', events: [{ stage: 'model_response', payload: '合成旧追踪正文。' }] };
      const result = { generation: 1, data };
      if (pending) { signals.push(request.signal); return new Promise(resolve => late.push(() => resolve(result))); }
      return result;
    } };
    const trace = new TraceController(backend, f.contacts);
    f.controller.onRecordDeletion(phase => trace.recordDeletionChanged(phase));
    const selection = f.selection(), traceRequest = { ...selection, resource: 'memory-traces', batchId: ids.work };
    await trace.show(traceRequest);
    assert.ok(trace.getState().detail);
    pending = true;
    const oldReads = [trace.show(traceRequest)];
    if (scope === 'owner') await f.bridge.readOwnerLayeredMemory({}); else await f.bridge.readLayeredMemory(selection);
    const command = { action, settingsGeneration: 1, organizationGeneration: 1, targetKind: 'scenario',
      versionId: ids.version, itemIndex: 0, ...(action === 'summary-error' ? { reason: '合成整理错误。', operationId: ids.other } : { memoryId: ids.memory }) };
    const writing = scope === 'owner' ? f.bridge.manageOwnerLayeredMemory(command) : f.bridge.manageLayeredMemory({ ...selection, ...command });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(trace.getState().detail, null);
    assert.equal(signals.length, 1);
    assert.ok(signals.every(signal => signal.aborted));
    const blockedReads = reads;
    await assert.rejects(trace.show(traceRequest));
    assert.equal(reads, blockedReads);
    finishWrite({ generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact, scenarios: [], profile: null }) });
    await writing;
    late.forEach(finish => finish()); await Promise.all(oldReads);
    assert.equal(trace.getState().detail, null);
    f.disconnect();
  });
}
