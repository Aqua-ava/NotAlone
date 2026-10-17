import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, profilePayload, ids } from './support.mjs';
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
