import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, profilePayload, ids } from './support.mjs';

for (const scope of ['contact', 'owner']) for (const targetKind of ['scenario', 'profile']) {
  test(`${scope} 的 ${targetKind} 总结纠错绑定实际项，处理中撤下旧副本并回看反馈`, async () => {
    let finish, posted;
    const f = await fixture(async request => {
      if (request.method === 'POST') { posted = request; return new Promise(resolve => { finish = resolve; }); }
      return { generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact }) };
    });
    const read = () => scope === 'owner' ? f.bridge.readOwnerLayeredMemory({}) : f.bridge.readLayeredMemory(f.selection());
    const state = async () => scope === 'owner' ? f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
    const manage = request => scope === 'owner' ? f.bridge.manageOwnerLayeredMemory(request) : f.bridge.manageLayeredMemory({ ...f.selection(), ...request });
    await read();
    const base = { action: 'summary-error', settingsGeneration: 1, organizationGeneration: 1,
      targetKind, versionId: targetKind === 'scenario' ? ids.version : ids.profile, itemIndex: 0,
      reason: '总结将计划写成已发生。', operationId: ids.other };
    for (const invalid of [{ itemIndex: 1 }, { versionId: ids.other }, { organizationGeneration: 0 }, { reason: ' ' }, { extra: true }]) {
      await assert.rejects(manage({ ...base, ...invalid }));
    }
    assert.equal(posted, undefined);
    const pending = manage(base);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await state()).value, null);
    await assert.rejects(read());
    assert.equal(posted.path, `${scope === 'owner' ? '/api/memories/owner' : `/api/contacts/${ids.contact}`}/layered-memory/summary-error`);
    assert.deepEqual(posted.body, { settings_generation: 1, organization_generation: 1, target_kind: targetKind,
      version_id: base.versionId, item_index: 0, reason: base.reason, operation_id: ids.other });
    finish({ generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact,
      scenarios: targetKind === 'scenario' ? [] : profilePayload().layered_memory.scenarios, profile: null,
      correction_revision: 1, protected_count: 1,
      feedback: [{ id: ids.other, target_kind: targetKind, version_id: base.versionId, item_index: 0, reason: base.reason, state: 'active' }] }) });
    await pending;
    assert.equal((await state()).value.feedback[0].reason, base.reason);
    assert.equal((await state()).value.correctionRevision, 1);
    f.disconnect();
  });
}

for (const scope of ['contact', 'owner']) for (const targetKind of ['scenario', 'profile']) {
  test(`${scope} 的 ${targetKind} 事实纠错仅接受实际引用并返回权威叶版本`, async () => {
    let posted;
    const f = await fixture(async request => {
      if (request.method === 'POST') posted = request;
      return { generation: 1, data: profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact,
        ...(posted ? { correction_target: { memory_id: ids.other, revision: 2 }, scenarios: [], profile: null } : {}) }) };
    });
    const read = () => scope === 'owner' ? f.bridge.readOwnerLayeredMemory({}) : f.bridge.readLayeredMemory(f.selection());
    const state = async () => scope === 'owner' ? f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
    const manage = request => scope === 'owner' ? f.bridge.manageOwnerLayeredMemory(request) : f.bridge.manageLayeredMemory({ ...f.selection(), ...request });
    await read();
    const base = { action: 'fact-error', settingsGeneration: 1, organizationGeneration: 1, targetKind,
      versionId: targetKind === 'scenario' ? ids.version : ids.profile, itemIndex: 0, memoryId: ids.memory };
    await assert.rejects(manage({ ...base, memoryId: ids.other }));
    assert.equal(posted, undefined);
    await manage(base);
    assert.equal(posted.path.endsWith('/fact-error'), true);
    assert.deepEqual(posted.body, { settings_generation: 1, organization_generation: 1, target_kind: targetKind,
      version_id: base.versionId, item_index: 0, memory_id: ids.memory });
    assert.deepEqual((await state()).value.correctionTarget, { memoryId: ids.other, revision: 2 });
    await read();
    f.disconnect();
  });
}
