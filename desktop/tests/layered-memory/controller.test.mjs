import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, readyPayload, profilePayload, ids, BackendRequestFailure } from './support.mjs';

test('用户明确确认联系人范围与用途后可开启；未知质量只保存范围而不放行整理', async () => {
  const posted = [];
  const f = await fixture(async (request) => {
    if (request.method === 'POST') { posted.push(request); return { generation: 1,
      data: payload({ enabled: true, settings_generation: 1, status: 'blocked' }) }; }
    return { generation: 1, data: payload() };
  });
  await f.bridge.readLayeredMemory(f.selection());
  assert.equal((await f.bridge.getState()).layeredMemory.value.enabled, false);
  await f.bridge.manageLayeredMemory({ ...f.selection(), action: 'enable', settingsGeneration: 0, purposeConfirmed: true });
  const state = await f.bridge.getState();
  assert.equal(state.layeredMemory.value.status, 'blocked');
  assert.equal(state.layeredMemory.value.qualityStatus, 'unknown');
  assert.deepEqual(state.layeredMemory.value.scenarios, []);
  assert.equal(posted[0].path, `/api/contacts/${ids.contact}/layered-memory/enable`);
  assert.deepEqual(posted[0].body, { settings_generation: 0, purpose_confirmed: true });
  assert.equal(f.handlers.get('memory:manage-layered-memory').role, 'manager');
});

test('停用期间撤下正文，结束后可重新读取合法现有文档；删除后不恢复旧正文', async () => {
  let saved = readyPayload(), finishDisable;
  const f = await fixture(async (request) => {
    if (request.path.endsWith('/disable')) return new Promise((resolve) => { finishDisable = () => {
      saved = readyPayload({ enabled: false, settings_generation: 2, status: 'disabled' }); resolve({ generation: 1, data: saved });
    }; });
    if (request.path.endsWith('/delete')) saved = payload({ settings_generation: 3, quality_status: 'synthetic' });
    return { generation: 1, data: saved };
  });
  await f.bridge.readLayeredMemory(f.selection());
  const disabling = f.bridge.manageLayeredMemory({ ...f.selection(), action: 'disable', settingsGeneration: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.bridge.getState()).layeredMemory.value, null);
  await assert.rejects(f.bridge.readLayeredMemory(f.selection()), /资料正在处理/);
  finishDisable(); await disabling;
  assert.equal((await f.bridge.getState()).layeredMemory.value.enabled, false);
  await f.bridge.readLayeredMemory(f.selection());
  assert.equal((await f.bridge.getState()).layeredMemory.value.scenarios[0].title, '合成读书计划');
  await f.bridge.manageLayeredMemory({ ...f.selection(), action: 'delete', settingsGeneration: 2 });
  const state = await f.bridge.getState();
  assert.equal(state.layeredMemory.value.settingsGeneration, 3);
  assert.equal(state.layeredMemory.value.enabled, false);
  assert.deepEqual(state.layeredMemory.value.scenarios, []);
  assert.match(state.mutation.message, /底层记忆可另行管理/);
});

test('联系人切换与断连立即撤下主题正文，迟到响应不可填回其他范围', async () => {
  for (const change of ['contact', 'disconnect']) {
    let releaseLate, signal;
    const f = await fixture(async (request) => new Promise((resolve) => { signal = request.signal;
      releaseLate = () => resolve({ generation: 1, data: profilePayload() }); }));
    const selection = f.selection();
    const reading = f.bridge.readLayeredMemory(selection);
    await new Promise((resolve) => setImmediate(resolve));
    if (change === 'contact') f.contacts.selectContact({ contactId: ids.other, scopeRevision: selection.scopeRevision });
    else f.disconnect();
    assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'idle', value: null });
    releaseLate(); await reading;
    assert.equal(signal.aborted, true);
    assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'idle', value: null });
    await assert.rejects(f.bridge.readLayeredMemory(selection), /范围已失效/);
  }
});

test('来源删除取消旧正文，重新读取失败时保持空缓存并拒绝迟到响应', async () => {
  let readCount = 0, releaseLate, signal;
  const f = await fixture(async (request) => {
    if (!request.path.endsWith('/layered-memory')) return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
    if (++readCount === 1) return { generation: 1, data: profilePayload() };
    if (readCount === 2) return new Promise((resolve) => { signal = request.signal;
      releaseLate = () => resolve({ generation: 1, data: profilePayload() }); });
    throw new Error('合成读取失败');
  });
  await f.bridge.readLayeredMemory(f.selection());
  const late = f.bridge.readLayeredMemory(f.selection());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.controller.revalidateDeletedSource(ids.contact), /仍需刷新核对/);
  releaseLate(); await late;
  assert.equal(signal.aborted, true);
  assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'error', value: null });
});

test('设置世代冲突先撤旧缓存再权威读取，未确认范围用途不发写请求', async () => {
  let writes = 0;
  const f = await fixture(async (request) => {
    if (request.method === 'POST') { writes++; throw new BackendRequestFailure('response', 409, 'settings_generation_conflict'); }
    return { generation: 1, data: writes ? payload({ settings_generation: 4 }) : readyPayload() };
  });
  await f.bridge.readLayeredMemory(f.selection());
  for (const request of [{ ...f.selection(), action: 'enable', settingsGeneration: 1 },
    { ...f.selection(), action: 'refresh', settingsGeneration: 0 },
    { ...f.selection(), action: 'delete', settingsGeneration: 1, extra: true }]) await assert.rejects(f.bridge.manageLayeredMemory(request));
  assert.equal(writes, 0);
  await f.bridge.manageLayeredMemory({ ...f.selection(), action: 'refresh', settingsGeneration: 1 });
  const state = await f.bridge.getState();
  assert.equal(state.layeredMemory.value.settingsGeneration, 4);
  assert.deepEqual(state.layeredMemory.value.scenarios, []);
  assert.match(state.mutation.message, /已撤下旧缓存并重新读取/);
});

test('底层记忆修正或删除先撤主题缓存，响应未知后仍权威核对当前结果', async () => {
  for (const action of ['correct', 'remove']) {
    let committed = false, finishWrite;
    const memory = { memory_id: ids.memory, level: 'contact', contact_id: ids.contact, text: '旧合成安排。', category: 'common_fact', topic: 'other',
      source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
      supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
      timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
    const f = await fixture(async (request) => {
      if (request.method === 'POST') return new Promise((_resolve, reject) => { finishWrite = () => { committed = true; reject(new Error('合成响应未知')); }; });
      if (request.path.endsWith('/layered-memory')) return { generation: 1, data: committed ? readyPayload({ status: 'stale', scenarios: [], covered_count: 0, remaining_count: 3 }) : profilePayload() };
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: committed && action === 'remove' ? [] : [memory] } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'contact' });
    await f.bridge.readLayeredMemory(f.selection());
    const writing = f.bridge[action]({ ...f.selection(), level: 'contact', memoryId: ids.memory, revision: 1,
      ...(action === 'correct' ? { text: '已修正的合成安排。', category: 'common_fact' } : {}) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.bridge.getState()).layeredMemory.value, null);
    await assert.rejects(f.bridge.readLayeredMemory(f.selection()), /资料正在处理/);
    finishWrite(); await writing;
    assert.deepEqual((await f.bridge.getState()).layeredMemory.value.scenarios, []);
    assert.equal((await f.bridge.getState()).layeredMemory.value.status, 'stale');
    assert.equal((await f.bridge.getState()).layeredMemory.value.profile, null);
  }
});

test('跨联系人、未知来历、无依据或非法时间响应不能替换已验证的主题资料', async () => {
  const base = readyPayload();
  const wrong = [readyPayload({ contact_id: ids.other }), readyPayload({ quality_status: 'unknown' }),
    readyPayload({ scenarios: [{ ...base.layered_memory.scenarios[0], paragraphs: [{ text: '无依据的合成正文。', references: [] }] }] }),
    readyPayload({ scenarios: [{ ...base.layered_memory.scenarios[0], paragraphs: [{ text: '错误来历的合成正文。', references: [{
      ...base.layered_memory.scenarios[0].paragraphs[0].references[0], provenance_kind: 'unknown' }] }] }] }),
    readyPayload({ scenarios: [{ ...base.layered_memory.scenarios[0], updated_at: '2026-10-17' }] })];
  for (const unavailable of wrong) {
    let result = base;
    const f = await fixture(async () => ({ generation: 1, data: result }));
    await f.bridge.readLayeredMemory(f.selection());
    result = unavailable;
    await f.bridge.readLayeredMemory(f.selection());
    assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'error', value: null });
  }
});

test('查看底层版本确认资料已失效时撤下主题并重新核对，不沿旧正文继续回看', async () => {
  let expired = false;
  const memory = { memory_id: ids.memory, level: 'contact', contact_id: ids.contact, text: '旧合成安排。', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  const f = await fixture(async (request) => {
    if (request.path.endsWith('/versions')) { expired = true; throw new BackendRequestFailure('response', 404); }
    if (request.path.endsWith('/layered-memory')) return { generation: 1, data: expired ? readyPayload({ status: 'stale', scenarios: [] }) : readyPayload() };
    return { generation: 1, data: { memories: [memory] } };
  });
  await f.bridge.refresh({ ...f.selection(), section: 'contact' });
  await f.bridge.readLayeredMemory(f.selection());
  await f.bridge.openVersions({ ...f.selection(), level: 'contact', memoryId: ids.memory, revision: 1 });
  assert.deepEqual((await f.bridge.getState()).layeredMemory.value.scenarios, []);
});

test('来源删除请求未决期间禁止回填旧主题；删除结束后只重新读取当前合法结果', async () => {
  let deleted = false, finishWrite;
  const f = await fixture(async (request) => {
    if (request.method === 'POST') return new Promise((resolve) => { finishWrite = () => resolve({ generation: 1, data: readyPayload() }); });
    return { generation: 1, data: deleted ? readyPayload({ status: 'stale', scenarios: [] }) : readyPayload() };
  });
  await f.bridge.readLayeredMemory(f.selection());
  const writing = f.bridge.manageLayeredMemory({ ...f.selection(), action: 'refresh', settingsGeneration: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  f.controller.sourceDeletionChanged('started');
  assert.equal((await f.bridge.getState()).layeredMemory.value, null);
  await assert.rejects(f.bridge.readLayeredMemory(f.selection()), /来源正在删除/);
  finishWrite(); await writing;
  assert.notEqual((await f.bridge.getState()).mutation.phase, 'working');
  assert.equal((await f.bridge.getState()).layeredMemory.value, null);
  deleted = true;
  f.controller.sourceDeletionChanged('settled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await f.bridge.getState()).layeredMemory.value.scenarios, []);
});

test('当前长期背景保留逐项依据与不确定性，并绑定一致版本撤回本版', async () => {
  let saved = profilePayload(), posted;
  const f = await fixture(async (request) => {
    if (request.method === 'POST') { posted = request; saved = readyPayload({ organization_generation: 2 }); }
    return { generation: 1, data: saved };
  });
  await f.bridge.readLayeredMemory(f.selection());
  const value = (await f.bridge.getState()).layeredMemory.value;
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.profile.versionId, ids.profile);
  assert.equal(value.profile.entries[0].temporalStatus, 'uncertain');
  assert.equal(value.profile.entries[0].uncertainty, '没有新的来源核实持续状态。');
  assert.equal(value.profile.entries[0].references[0].memoryId, ids.memory);
  await f.bridge.manageLayeredMemory({ ...f.selection(), action: 'withdraw-profile', settingsGeneration: 1,
    organizationGeneration: 1, profileVersionId: ids.profile });
  assert.equal(posted.path, `/api/contacts/${ids.contact}/layered-memory/withdraw-profile`);
  assert.deepEqual(posted.body, { settings_generation: 1, organization_generation: 1, profile_version_id: ids.profile });
  assert.equal((await f.bridge.getState()).layeredMemory.value.profile, null);
  assert.equal((await f.bridge.getState()).layeredMemory.value.scenarios[0].title, '合成读书计划');
});

test('旧协议、无依据或未知质量的长期背景不能填回当前资料', async () => {
  const base = profilePayload(), profile = base.layered_memory.profile;
  const wrong = [profilePayload({ schema_version: 1 }), profilePayload({ profile: undefined }),
    profilePayload({ profile: { ...profile, system_generated: false } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], references: [] }] } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], temporal_status: 'current' }] } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], uncertainty: undefined }] } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], uncertainty: '' }] } }),
    profilePayload({ scenarios: [], quality_status: 'unknown' })];
  for (const unavailable of wrong) {
    let saved = base;
    const f = await fixture(async () => ({ generation: 1, data: saved }));
    await f.bridge.readLayeredMemory(f.selection());
    saved = unavailable;
    await f.bridge.readLayeredMemory(f.selection());
    assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'error', value: null });
  }
});

test('撤回必须携带当前一致集合与画像版本，缺失或冲突时不发写请求', async () => {
  let writes = 0;
  const f = await fixture(async (request) => {
    if (request.method === 'POST') writes++;
    return { generation: 1, data: profilePayload() };
  });
  await f.bridge.readLayeredMemory(f.selection());
  const request = { ...f.selection(), action: 'withdraw-profile', settingsGeneration: 1,
    organizationGeneration: 1, profileVersionId: ids.profile };
  for (const invalid of [{ ...request, organizationGeneration: undefined }, { ...request, profileVersionId: undefined },
    { ...request, organizationGeneration: -1 }, { ...request, profileVersionId: 'unknown' },
    { ...request, organizationGeneration: 0 }, { ...request, profileVersionId: ids.version },
    { ...request, settingsGeneration: 0 }, { ...request, extra: true },
    { ...request, action: 'refresh' }]) await assert.rejects(f.bridge.manageLayeredMemory(invalid));
  assert.equal(writes, 0);
  assert.equal((await f.bridge.getState()).layeredMemory.value.profile.versionId, ids.profile);
});
