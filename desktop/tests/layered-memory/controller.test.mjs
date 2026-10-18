import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, readyPayload, profilePayload, ids, BackendRequestFailure } from './support.mjs';

test('已验证整理与回复资格经公开 bridge 保留各自合同和报告，允许真实资料使用', async () => {
  const f = await fixture(async () => ({ generation: 1, data: readyPayload({ quality_status: 'verified', quality: {
    organization: { status: 'verified', reasons: [], contract_id: 'organization-contract-v1', report_id: 'organization-report-v1' },
    reply: { status: 'verified', reasons: [], contract_id: 'reply-contract-v1', report_id: 'reply-report-v1' },
    automatic_use_allowed: true, synthetic: false,
  } }) }));
  try {
    await f.bridge.readLayeredMemory(f.selection());
    const state = (await f.bridge.getState()).layeredMemory;
    assert.equal(state.phase, 'ready');
    assert.equal(state.value.qualityStatus, 'verified');
    assert.deepEqual(state.value.quality, {
      organization: { status: 'verified', reasons: [], contractId: 'organization-contract-v1', reportId: 'organization-report-v1' },
      reply: { status: 'verified', reasons: [], contractId: 'reply-contract-v1', reportId: 'reply-report-v1' },
      automaticUseAllowed: true, synthetic: false,
    });
  } finally { f.disconnect(); }
});

test('整理资格变化只关闭自动使用，未知或未通过仍可回看来源有效的已有正文', async () => {
  for (const status of ['unknown', 'failed']) {
    const f = await fixture(async () => ({ generation: 1, data: profilePayload({ quality_status: status, status: 'blocked', quality: {
      organization: { status, reasons: ['整理合同变化，旧报告不能放行当前用途。'], contract_id: 'organization-v2', report_id: 'organization-report-v1' },
      reply: { status: 'verified', reasons: [], contract_id: 'reply-v1', report_id: 'reply-report-v1' },
      automatic_use_allowed: false, synthetic: false,
    } }) }));
    try {
      await f.bridge.readLayeredMemory(f.selection());
      const state = (await f.bridge.getState()).layeredMemory;
      assert.equal(state.phase, 'ready');
      assert.equal(state.value.quality.organization.status, status);
      assert.equal(state.value.quality.automaticUseAllowed, false);
      assert.equal(state.value.scenarios[0].title, '合成读书计划');
      assert.equal(state.value.profile.versionId, ids.profile);
    } finally { f.disconnect(); }
  }
});

test('生产质量合同缺失、伪造放行或不完整报告均撤下旧快照，不退回合成资格', async () => {
  const stage = { status: 'verified', reasons: [], contract_id: 'contract-v1', report_id: 'report-v1' };
  const valid = { organization: stage, reply: stage, automatic_use_allowed: true, synthetic: false };
  const wrong = [undefined, null, { ...valid, unexpected: true }, { ...valid, organization: { ...stage, report_id: null } },
    { ...valid, organization: { ...stage, reasons: ['存在关键错误。'] } }, { ...valid, reply: { ...stage, status: 'unknown' } },
    { ...valid, reply: { ...stage, status: 'failed', reasons: ['候选模型未通过。'] } },
    { ...valid, automatic_use_allowed: 'true' }, { ...valid, synthetic: true },
    { ...valid, organization: { ...stage, contract_id: '' } }, { ...valid, organization: { ...stage, extra: '未声明字段' } },
    { ...valid, reply: { ...stage, reasons: [17] } }, { ...valid, reply: { ...stage, status: 'synthetic' } }];
  for (const quality of wrong) {
    let current = readyPayload({ quality_status: 'verified', quality: valid });
    const f = await fixture(async () => ({ generation: 1, data: current }));
    try {
      await f.bridge.readLayeredMemory(f.selection());
      assert.equal((await f.bridge.getState()).layeredMemory.phase, 'ready');
      current = readyPayload({ quality_status: 'verified', quality });
      await f.bridge.readLayeredMemory(f.selection());
      assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'error', value: null });
    } finally { f.disconnect(); }
  }
});

for (const scope of ['contact', 'owner']) test(`已开启的已验证${scope === 'owner' ? '本人' : '联系人'}资料自动复核并展示资格失效`, { timeout: 4000 }, async () => {
  let reads = 0, notifyUpdated;
  const updated = new Promise((resolve) => { notifyUpdated = resolve; });
  const stage = { status: 'verified', reasons: [], contract_id: 'contract-v1', report_id: 'report-v1' };
  const f = await fixture(async () => {
    const changed = ++reads > 1;
    const data = readyPayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact,
      quality_status: changed ? 'unknown' : 'verified', quality: {
        organization: changed ? { ...stage, status: 'unknown', reasons: ['整理合同已变化。'] } : stage,
        reply: stage, automatic_use_allowed: !changed, synthetic: false,
      } });
    if (changed) notifyUpdated();
    return { generation: 1, data };
  });
  const read = () => scope === 'owner' ? f.bridge.readOwnerLayeredMemory({}) : f.bridge.readLayeredMemory(f.selection());
  const state = async () => scope === 'owner' ? f.bridge.getOwnerLayeredMemoryState() : (await f.bridge.getState()).layeredMemory;
  const deadline = setTimeout(() => notifyUpdated(), 2000);
  try {
    await read();
    await updated;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reads > 1, '已验证资料应继续复核后台状态');
    assert.equal((await state()).value.quality.organization.status, 'unknown');
    assert.equal((await state()).value.quality.automaticUseAllowed, false);
  } finally { clearTimeout(deadline); f.disconnect(); }
});

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
  const wrong = [readyPayload({ contact_id: ids.other }),
    readyPayload({ maintenance_pending: 'true' }),
    readyPayload({ scenario_mappings: [{ source_scenario_id: ids.other, source_version_id: ids.work,
      targets: [{ scenario_id: ids.scenario, version_id: ids.other }] }] }),
    readyPayload({ scenario_mappings: [{ source_scenario_id: ids.other, source_version_id: ids.work, targets: [] }] }),
    readyPayload({ work_id: '其他工作' }), readyPayload({ work_revision: -1 }), readyPayload({ current_batch: 0.5 }),
    readyPayload({ work_id: null }), readyPayload({ work_revision: 0 }),
    readyPayload({ model_calls_used: -1 }), readyPayload({ model_calls_used: 3, model_call_limit: 2 }),
    readyPayload({ model_calls_used: 1 }), readyPayload({ model_call_limit: 3 }),
    readyPayload({ model_calls_used: undefined }), readyPayload({ model_call_limit: undefined }),
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

test('暂停或继续必须使用已读取的工作版本，缺少或过期版本不发出请求', async () => {
  const posted = [];
  const f = await fixture(async (request) => {
    if (request.method === 'POST') posted.push(request);
    return { generation: 1, data: readyPayload({ status: 'paused', work_revision: 4 }) };
  });
  await f.bridge.readLayeredMemory(f.selection());
  for (const action of ['pause', 'continue']) {
    for (const revision of [undefined, 0, -1, 3, 4.5]) {
      await assert.rejects(f.bridge.manageLayeredMemory({ ...f.selection(), action, settingsGeneration: 1,
        ...(revision === undefined ? {} : { workRevision: revision }) }));
    }
  }
  assert.equal(posted.length, 0);
  await f.bridge.manageLayeredMemory({ ...f.selection(), action: 'continue', settingsGeneration: 1, workRevision: 4 });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { settings_generation: 1, work_revision: 4 });
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

test('后台读取未返回时切换联系人会取消请求，迟到主题不能恢复', { timeout: 5000 }, async () => {
  let reads = 0, releaseLate, signal, notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const f = await fixture(async (request) => {
    if (++reads === 1) return { generation: 1, data: readyPayload({ mapping_cursor: '1:100' }) };
    assert.ok(request.path.includes('mapping_cursor=1%3A100'), '后台更新保持正在查看的分页');
    signal = request.signal;
    return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1, data: readyPayload() }); notifyStarted(); });
  });
  try {
    await f.bridge.readLayeredMemory({ ...f.selection(), mappingCursor: '1:100' });
    const deadline = setTimeout(() => notifyStarted(), 2500);
    await started;
    clearTimeout(deadline);
    assert.equal(typeof releaseLate, 'function', '已开启范围应自动读取后台变化');
    const selection = f.selection();
    f.contacts.selectContact({ contactId: ids.other, scopeRevision: selection.scopeRevision });
    assert.equal(signal.aborted, true);
    releaseLate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'idle', value: null });
  } finally { f.disconnect(); }
});

test('1001个旧入口逐页可达最旧项，页面只保存当前100条以内映射且游标过期撤下缓存', async () => {
  const uuid = (n) => `77777777-7777-4777-8777-${n.toString().padStart(12, '0')}`;
  let expired = false;
  const f = await fixture(async (request) => {
    const cursor = new URL(request.path, 'http://localhost').searchParams.get('mapping_cursor');
    if (expired && cursor) throw new BackendRequestFailure('response', 409, 'mapping_cursor_expired');
    const offset = cursor ? Number(cursor.split(':')[1]) : 0;
    return { generation: 1, data: readyPayload({ mapping_cursor: cursor,
      mapping_next_cursor: offset + 100 < 1001 ? `1:${offset + 100}` : null,
      scenario_mappings: Array.from({ length: Math.min(100, 1001 - offset) }, (_, i) => ({
        source_scenario_id: uuid(offset + i), source_version_id: uuid(offset + i),
        targets: [{ scenario_id: ids.scenario, version_id: ids.version }],
      })) }) };
  });
  try {
    let mappingCursor = null, value;
    do {
      await f.bridge.readLayeredMemory({ ...f.selection(), mappingCursor });
      value = (await f.bridge.getState()).layeredMemory.value;
      assert.ok(value.scenarioMappings.length <= 100);
      mappingCursor = value.mappingNextCursor;
    } while (mappingCursor);
    assert.equal(value.scenarioMappings[0].sourceVersionId, uuid(1000));
    assert.equal(value.scenarioMappings.length, 1);
    expired = true;
    await f.bridge.readLayeredMemory({ ...f.selection(), mappingCursor: '1:1000' });
    assert.deepEqual((await f.bridge.getState()).layeredMemory, { phase: 'error', value: null });
    await f.bridge.readLayeredMemory(f.selection());
    assert.equal((await f.bridge.getState()).layeredMemory.value.mappingCursor, null);
  } finally { f.disconnect(); }
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

test('旧协议、无依据或非法时间状态的长期背景不能填回当前资料', async () => {
  const base = profilePayload(), profile = base.layered_memory.profile;
  const wrong = [profilePayload({ schema_version: 1 }), profilePayload({ profile: undefined }),
    profilePayload({ profile: { ...profile, system_generated: false } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], references: [] }] } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], temporal_status: 'current' }] } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], uncertainty: undefined }] } }),
    profilePayload({ profile: { ...profile, entries: [{ ...profile.entries[0], uncertainty: '' }] } })];
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

test('没有覆盖工作时保留当前配置额度，顶层与嵌套预算仍一致', async () => {
  const base = payload();
  const f = await fixture(async () => ({ generation: 1, data: payload({ model_call_limit: 4,
    budget: { ...base.layered_memory.budget, max_model_calls: 4, model_calls_used: 0, model_calls_remaining: 4 } }) }));
  await f.bridge.readLayeredMemory(f.selection());
  const value = (await f.bridge.getState()).layeredMemory.value;
  assert.equal(value.workId, null);
  assert.equal(value.modelCallLimit, 4);
  assert.equal(value.budget.modelCallsRemaining, 4);
});
