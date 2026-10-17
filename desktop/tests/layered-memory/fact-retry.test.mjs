import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, profilePayload, ids, BackendRequestFailure } from './support.mjs';

for (const scope of ['contact', 'owner']) for (const kind of ['scenario', 'profile']) {
  test(`${scope} ${kind} 事实纠错丢失首响应后以同一命令有限重试并恢复精确入口`, async () => {
    const writes = [];
    const f = await fixture(async request => {
      const scopeFields = { scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact };
      if (request.method === 'POST') {
        writes.push(structuredClone(request.body));
        if (writes.length === 1) throw new BackendRequestFailure('connection');
        return { generation: 1, data: profilePayload({ ...scopeFields, scenarios: [], profile: null,
          pending_fact_count: 1, correction_target: { memory_id: ids.memory, revision: 1 } }) };
      }
      return { generation: 1, data: profilePayload({ ...scopeFields, ...(writes.length ? { scenarios: [], profile: null } : {}) }) };
    });
    try {
      if (scope === 'owner') await f.bridge.readOwnerLayeredMemory({});
      else await f.bridge.readLayeredMemory(f.selection());
      const command = { action: 'fact-error', settingsGeneration: 1, organizationGeneration: 1,
        targetKind: kind, versionId: kind === 'scenario' ? ids.version : ids.profile,
        itemIndex: 0, memoryId: ids.memory };
      if (scope === 'owner') await f.bridge.manageOwnerLayeredMemory(command);
      else await f.bridge.manageLayeredMemory({ ...f.selection(), ...command });
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], writes[0]);
      const state = scope === 'owner' ? await f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
      assert.deepEqual(state.value.correctionTarget, { memoryId: ids.memory, revision: 1 });
      assert.equal(state.value.pendingFactCount, 1);
    } finally { f.disconnect(); }
  });
}

for (const scope of ['contact', 'owner']) for (const failure of ['http-conflict', 'cancelled', 'persistent-connection', 'scope-changed', 'source-changed']) {
  test(`${scope} 事实纠错 ${failure} 不越过有限重试及范围门禁`, async () => {
    let writes = 0;
    const f = await fixture(async request => {
      if (request.method === 'POST') {
        writes++;
        if (failure === 'scope-changed') f.disconnect();
        if (failure === 'source-changed') f.controller.sourceDeletionChanged('started');
        throw failure === 'http-conflict' ? new BackendRequestFailure('response', 409, 'layered_memory_changed')
          : new BackendRequestFailure(failure === 'cancelled' ? 'cancelled' : 'connection');
      }
      return { generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact,
        ...(writes ? { scenarios: [], profile: null, pending_fact_count: 1 } : {}) }) };
    });
    try {
      if (scope === 'owner') await f.bridge.readOwnerLayeredMemory({});
      else await f.bridge.readLayeredMemory(f.selection());
      const command = { action: 'fact-error', settingsGeneration: 1, organizationGeneration: 1,
        targetKind: 'profile', versionId: ids.profile, itemIndex: 0, memoryId: ids.memory };
      if (scope === 'owner') await f.bridge.manageOwnerLayeredMemory(command);
      else await f.bridge.manageLayeredMemory({ ...f.selection(), ...command });
      assert.equal(writes, failure === 'persistent-connection' ? 2 : 1);
      const state = scope === 'owner' ? await f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
      assert.equal(state.value?.correctionTarget ?? null, null);
    } finally { f.disconnect(); }
  });
}
