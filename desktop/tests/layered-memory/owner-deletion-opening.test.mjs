import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids } from './support.mjs';

test('联系人删除期间首次打开本人记忆，删除结束后自动读取且不恢复旧来源快照', async () => {
  const contactMemory = { memory_id: ids.memory, level: 'contact', contact_id: ids.contact, text: '待删除合成记忆。',
    category: 'common_fact', topic: 'other', source_ids: [ids.memory], status: 'active', adoption_method: 'manual',
    confidence: 1, risk_flags: [], revision: 1, supersedes_memory_id: null, source_candidate_id: null,
    valid_at: null, invalid_at: null, timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  const ownerMemory = { ...contactMemory, memory_id: ids.other, level: 'owner', text: '仍有效的本人合成记忆。' };
  let started, release; let removed = false, ownerReads = 0;
  const posted = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async request => {
    if (request.method === 'POST') { started(); await gate; removed = true; return { generation: 1, data: {} }; }
    if (request.path === '/api/memories/owner') { ownerReads++; return { generation: 1, data: { memories: [ownerMemory] } }; }
    return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
      : { memories: removed ? [] : [contactMemory] } };
  });
  try {
    await f.bridge.refresh({ ...f.selection(), section: 'contact' });
    const deleting = f.bridge.remove({ ...f.selection(), level: 'contact', memoryId: ids.memory, revision: 1 });
    await posted;
    await f.bridge.readOwnerMemories();
    assert.equal(ownerReads, 0, '来源删除未结束，不能越过读取门禁');
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).memories.phase, 'idle');
    release(); await deleting;
    await new Promise(resolve => setImmediate(resolve));
    const state = await f.bridge.getOwnerLayeredMemoryState();
    assert.equal(state.memories.phase, 'ready');
    assert.deepEqual(state.memories.items.map(memory => memory.text), ['仍有效的本人合成记忆。']);
    assert.equal(ownerReads, 1);
  } finally { release(); f.disconnect(); }
});
