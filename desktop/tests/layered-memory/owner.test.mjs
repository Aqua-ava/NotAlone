import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, readyPayload, profilePayload, ids, TraceController } from './support.mjs';
const owner = () => payload({ scope_kind: 'owner', contact_id: null, scenario_enabled: false, profile_enabled: false });
test('本人主题资料不依赖联系人，切换联系人保留独立状态和 owner 路由', async () => {
  const calls = [];
  const f = await fixture(async request => { calls.push(request); return { generation: 1, data: owner() }; });
  await f.bridge.readOwnerLayeredMemory({});
  f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).value.scopeKind, 'owner');
  await f.bridge.manageOwnerLayeredMemory({ action: 'enable', settingsGeneration: 0, purposeConfirmed: true });
  assert.equal(calls[1].path, '/api/memories/owner/layered-memory/enable');
  assert.equal((await f.bridge.getState()).layeredMemory.value, null);
  f.disconnect();
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).value, null);
});

test('无联系人仍能读取和管理本人范围，拒绝夹带联系人和未经确认用途', async () => {
  let writes = 0;
  const f = await fixture(async request => { if (request.method === 'POST') writes++; return { generation: 1, data: owner() }; }, { noContact: true });
  await f.bridge.readOwnerLayeredMemory({});
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).phase, 'ready');
  for (const invalid of [{ action: 'enable', settingsGeneration: 0 }, { action: 'enable', settingsGeneration: 0, purposeConfirmed: true, contactId: ids.contact },
    { action: 'refresh', settingsGeneration: 1 }, { action: 'continue', settingsGeneration: 0, workRevision: 1 }]) await assert.rejects(f.bridge.manageOwnerLayeredMemory(invalid));
  assert.equal(writes, 0);
  await f.bridge.manageOwnerLayeredMemory({ action: 'enable', settingsGeneration: 0, purposeConfirmed: true });
  assert.equal(writes, 1); f.disconnect();
});

test('本人来源删除撤下旧快照并拒绝迟到结果，结束后重新核验', async () => {
  let finish, pending = false;
  const f = await fixture(async () => pending ? new Promise(resolve => { finish = resolve; }) : { generation: 1, data: owner() });
  await f.bridge.readOwnerLayeredMemory({}); pending = true;
  const reading = f.bridge.readOwnerLayeredMemory({});
  await new Promise(resolve => setImmediate(resolve));
  f.controller.sourceDeletionChanged('started');
  await assert.rejects(f.bridge.readOwnerLayeredMemory({}));
  finish({ generation: 1, data: owner() }); await reading;
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).value, null);
  pending = false; f.controller.sourceDeletionChanged('settled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).phase, 'ready'); f.disconnect();
});

test('本人接口拒绝联系人响应，断连后迟到响应不会恢复本人资料', async () => {
  let finish, mode = 'wrong';
  const f = await fixture(async () => mode === 'late' ? new Promise(resolve => { finish = resolve; }) : { generation: 1, data: payload() });
  await f.bridge.readOwnerLayeredMemory({});
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).phase, 'error');
  mode = 'late'; const reading = f.bridge.readOwnerLayeredMemory({}); await new Promise(resolve => setImmediate(resolve));
  f.disconnect(); finish({ generation: 1, data: owner() }); await reading;
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).value, null);
});


test('本人长期背景撤回绑定集合及版本，删除保留独立路由且不带联系人字段', async () => {
  let saved = profilePayload({ scope_kind: 'owner', contact_id: null }), posted;
  const f = await fixture(async request => {
    if (request.method === 'POST') { posted = request; saved = owner(); }
    return { generation: 1, data: saved };
  });
  await f.bridge.readOwnerLayeredMemory({});
  await assert.rejects(f.bridge.manageOwnerLayeredMemory({ action: 'withdraw-profile', settingsGeneration: 1, organizationGeneration: 0, profileVersionId: ids.profile }));
  await f.bridge.manageOwnerLayeredMemory({ action: 'withdraw-profile', settingsGeneration: 1, organizationGeneration: 1, profileVersionId: ids.profile });
  assert.equal(posted.path, '/api/memories/owner/layered-memory/withdraw-profile');
  assert.deepEqual(posted.body, { settings_generation: 1, organization_generation: 1, profile_version_id: ids.profile });
  await f.bridge.manageOwnerLayeredMemory({ action: 'delete', settingsGeneration: 0 });
  assert.equal(posted.path, '/api/memories/owner/layered-memory/delete');
  assert.deepEqual(posted.body, { settings_generation: 0 }); f.disconnect();
});

test('本人主题撤回绑定实际主题版本和集合版本，缺失或过期版本不发请求', async () => {
  let posted;
  const f = await fixture(async request => { if (request.method === 'POST') posted = request; return { generation: 1, data: profilePayload({ scope_kind: 'owner', contact_id: null }) }; });
  await f.bridge.readOwnerLayeredMemory({});
  for (const extra of [{}, { scenarioVersionId: ids.profile }, { scenarioVersionId: ids.version, organizationGeneration: 0 }]) {
    await assert.rejects(f.bridge.manageOwnerLayeredMemory({ action: 'withdraw-scenario', settingsGeneration: 1, organizationGeneration: 1, ...extra }));
  }
  assert.equal(posted, undefined);
  await f.bridge.manageOwnerLayeredMemory({ action: 'withdraw-scenario', settingsGeneration: 1, organizationGeneration: 1, scenarioVersionId: ids.version });
  assert.equal(posted.path, '/api/memories/owner/layered-memory/withdraw-scenario');
  assert.deepEqual(posted.body, { settings_generation: 1, organization_generation: 1, scenario_version_id: ids.version }); f.disconnect();
});

test('无联系人可手动添加本人资料，仅发送本人文本与分类并重新核验', async () => {
  const posts = [];
  const f = await fixture(async request => { if (request.method === 'POST') posts.push(request); return { generation: 1, data: owner() }; }, { noContact: true });
  await f.bridge.addOwnerMemory({ text: '本人喜欢合成读书活动。', category: 'preference' });
  assert.equal(posts[0].path, '/api/memories/manual-owner');
  assert.deepEqual(posts[0].body, { text: '本人喜欢合成读书活动。', category: 'preference' });
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).phase, 'ready');
  await assert.rejects(f.bridge.addOwnerMemory({ text: '测试', category: 'preference', contactId: ids.contact }));
  f.disconnect();
});

test('本人底层查看修正删除无需联系人，未读取的版本不可操作', async () => {
  const memory = { memory_id: ids.memory, level: 'owner', text: '本人合成事实', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  const posts = [];
  const f = await fixture(async request => {
    if (request.method === 'POST') posts.push(request);
    return { generation: 1, data: request.path === '/api/memories/owner' ? { memories: [memory] } : owner() };
  }, { noContact: true });
  await assert.rejects(f.bridge.correctOwnerMemory({ memoryId: ids.memory, revision: 1, text: '本人修正事实', category: 'common_fact' }));
  await f.bridge.readOwnerMemories();
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).memories.items[0].memoryId, ids.memory);
  await f.bridge.correctOwnerMemory({ memoryId: ids.memory, revision: 1, text: '本人修正事实', category: 'common_fact' });
  assert.equal(posts[0].path, `/api/memories/owner/${ids.memory}/correct`);
  await f.bridge.deleteOwnerMemory({ memoryId: ids.memory, revision: 1 });
  assert.equal(posts[1].path, `/api/memories/owner/${ids.memory}/delete`);
  f.disconnect();
});

for (const action of ['delete', 'correct', 'uncertain']) test(`新本人${action}必须撤下旧缓存及迟到读取`, async () => {
  const memory = { memory_id: ids.memory, level: 'owner', text: '本人合成事实', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  let deleted = false, defer = false, finish;
  const f = await fixture(async request => {
    if (request.method === 'POST') { deleted = true; if (action === 'uncertain') throw new Error('合成保存结果未确认'); return { generation: 1, data: {} }; }
    if (request.path === '/api/memories/owner/overview') return { generation: 1, data: { overview: { version: 1, scope_kind: 'owner', contact_id: null, projection_revision: 'a'.repeat(64), memory_revision: 1, built_at: '2026-10-18T00:00:00Z', entries: [] } } };
    if (request.path === '/api/memories/owner') { if (defer) { defer = false; return new Promise(resolve => { finish = resolve; }); } return { generation: 1, data: { memories: deleted ? [] : [memory] } }; }
    return { generation: 1, data: owner() };
  });
  await f.bridge.refresh({ ...f.selection(), section: 'owner' });
  assert.equal((await f.bridge.getState()).owner.items.length, 1);
  await f.bridge.refreshOwnerOverview(f.selection());
  assert.equal((await f.bridge.getState()).ownerOverview.phase, 'ready');
  await f.bridge.readOwnerMemories();
  defer = true;
  const oldRead = f.bridge.refresh({ ...f.selection(), section: 'owner' });
  await new Promise(resolve => setImmediate(resolve));
  if (action === 'delete') await f.bridge.deleteOwnerMemory({ memoryId: ids.memory, revision: 1 });
  else if (action === 'correct') await f.bridge.correctOwnerMemory({ memoryId: ids.memory, revision: 1, text: '合成修正', category: 'common_fact' });
  else await assert.rejects(f.bridge.addOwnerMemory({ text: '合成新增', category: 'common_fact' }));
  finish({ generation: 1, data: { memories: [memory] } }); await oldRead;
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).memories.items.length, 0);
  assert.equal((await f.bridge.getState()).owner.items.length, 0);
  assert.notEqual((await f.bridge.getState()).ownerOverview.phase, 'loading');
  await f.bridge.refreshOwnerOverview(f.selection());
  assert.equal((await f.bridge.getState()).ownerOverview.phase, 'ready');
  f.disconnect();
});

for (const action of ['delete', 'correct', 'uncertain']) test(`本人${action}协调旧追踪清理及读栅栏`, async () => {
  const memory = { memory_id: ids.memory, level: 'owner', text: '本人合成事实', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  let trace, finish, delayed = false;
  const phases = [];
  const request = { resource: 'memory-traces', batchId: ids.work };
  const f = await fixture(async r => {
    if (r.method === 'POST') {
      assert.equal(trace.getState().detail, null);
      await assert.rejects(trace.show({ ...f.selection(), ...request }));
      if (action === 'uncertain') throw new Error('合成保存未确认');
      return { generation: 1, data: {} };
    }
    return { generation: 1, data: r.path === '/api/memories/owner' ? { memories: [memory] } : owner() };
  });
  const result = { generation: 1, data: { trace_id: ids.work, contact_id: ids.contact,
    status: 'succeeded', events: [{ stage: 'model_response', payload: '合成应删追踪正文' }] } };
  trace = new TraceController({ getConnectionGeneration: () => 1,
    requestJson: async () => delayed ? new Promise(resolve => { finish = resolve; }) : result }, f.contacts);
  f.controller.onRecordDeletion(phase => { phases.push(phase); trace.recordDeletionChanged(phase); });
  await trace.show({ ...f.selection(), ...request });
  assert.ok(trace.getState().detail);
  delayed = true;
  const late = trace.show({ ...f.selection(), ...request });
  delayed = false;
  await f.bridge.readOwnerMemories();
  if (action === 'delete') await f.bridge.deleteOwnerMemory({ memoryId: ids.memory, revision: 1 });
  else if (action === 'correct') await f.bridge.correctOwnerMemory({ memoryId: ids.memory, revision: 1, text: '修正', category: 'common_fact' });
  else await assert.rejects(f.bridge.addOwnerMemory({ text: '新增', category: 'common_fact' }));
  finish(result); await late;
  assert.deepEqual(phases, ['started', 'settled']);
  assert.equal(trace.getState().detail, null);
  delayed = false;
  await trace.show({ ...f.selection(), ...request });
  assert.equal(trace.getState().phase, 'ready');
  f.disconnect();
});

test('独立本人入口保存后自动恢复已打开的本人记忆列表，无需切换联系人或手动刷新', async () => {
  const memory = { memory_id: ids.memory, level: 'owner', text: '合成本人新事实', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  let saved = false, reads = 0;
  const f = await fixture(async request => {
    if (request.method === 'POST') saved = true;
    if (request.path === '/api/memories/owner') { reads++; return { generation: 1, data: { memories: saved ? [memory] : [] } }; }
    return { generation: 1, data: owner() };
  });
  await f.bridge.refresh({ ...f.selection(), section: 'owner' });
  assert.equal((await f.bridge.getState()).owner.phase, 'ready');
  const scope = f.selection();
  await f.bridge.addOwnerMemory({ text: memory.text, category: memory.category });
  assert.deepEqual(f.selection(), scope);
  const state = await f.bridge.getState();
  assert.equal(state.owner.phase, 'ready');
  assert.equal(state.owner.items[0]?.text, memory.text);
  assert.equal(reads, 2);
  f.disconnect();
});

test('独立本人写入不主动打开未请求列表，断连后也不恢复原列表', async () => {
  let reads = 0, disconnectOnWrite = false, f;
  f = await fixture(async request => {
    if (request.method === 'POST' && disconnectOnWrite) f.disconnect();
    if (request.path === '/api/memories/owner') { reads++; return { generation: 1, data: { memories: [] } }; }
    return { generation: 1, data: owner() };
  });
  await f.bridge.addOwnerMemory({ text: '合成未打开列表的事实', category: 'common_fact' });
  assert.equal(reads, 0);
  await f.bridge.refresh({ ...f.selection(), section: 'owner' });
  assert.equal(reads, 1);
  disconnectOnWrite = true;
  await assert.rejects(f.bridge.addOwnerMemory({ text: '合成断连中的事实', category: 'common_fact' }));
  assert.equal(reads, 1);
  const state = await f.bridge.getState();
  assert.equal(state.contactId, null);
  assert.equal(state.owner.phase, 'idle');
  assert.deepEqual(state.owner.items, []);
});

test('本人保存成功但列表复读失败不宣称成功，可只读刷新核对', async () => {
  let saved = false, failRead = false;
  const writes = [];
  const mutations = [];
  const f = await fixture(async request => {
    if (request.method === 'POST') { writes.push(request); saved = true; failRead = true; }
    if (request.path === '/api/memories/owner') {
      if (failRead) throw new Error('合成复读失败');
      return { generation: 1, data: { memories: [] } };
    }
    return { generation: 1, data: owner() };
  }, { noContact: true });
  const unsubscribe = f.bridge.onOwnerLayeredMemoryChanged(state => mutations.push(state.mutation.phase));
  await f.bridge.readOwnerMemories();
  await assert.rejects(f.bridge.addOwnerMemory({ text: '合成保存成功事实', category: 'preference' }));
  assert.equal(saved, true);
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).mutation.phase, 'error');
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).memories.phase, 'error');
  assert.equal(mutations.includes('success'), false);
  failRead = false;
  await f.bridge.readOwnerMemories();
  assert.equal((await f.bridge.getOwnerLayeredMemoryState()).memories.phase, 'ready');
  assert.equal(writes.length, 1);
  unsubscribe(); f.disconnect();
});

test('本人保存后列表复读跨过轮询周期，完成核验后仍继续读取摘要进度', async t => {
  let saved = false, layeredReads = 0, finishRead, enteredRead;
  const reading = new Promise(resolve => { enteredRead = resolve; });
  const f = await fixture(async request => {
    if (request.method === 'POST') saved = true;
    if (request.path === '/api/memories/owner') {
      if (saved) {
        enteredRead();
        return new Promise(resolve => { finishRead = resolve; });
      }
      return { generation: 1, data: { memories: [] } };
    }
    if (request.path === '/api/memories/owner/layered-memory') layeredReads++;
    return { generation: 1, data: readyPayload({ scope_kind: 'owner', contact_id: null,
      runtime_policy: 'verified_items', quality_status: 'unknown', quality: undefined }) };
  }, { noContact: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await f.bridge.readOwnerMemories();
    const writing = f.bridge.addOwnerMemory({ text: '合成慢复读资料', category: 'common_fact' });
    await reading;
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).mutation.phase, 'working');
    t.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(layeredReads, 1, '写入核验期间不启动并行摘要读取');
    finishRead({ generation: 1, data: { memories: [] } });
    await writing;
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).mutation.phase, 'success');
    t.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(layeredReads, 2, '完成写后核验应恢复摘要自动读取');
  } finally { f.disconnect(); t.mock.timers.reset(); }
});
