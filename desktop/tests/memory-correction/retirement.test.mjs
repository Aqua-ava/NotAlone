import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from '../layered-memory/support.mjs';

function memory(level) {
  return { memory_id: ids.memory, level, ...(level === 'contact' ? { contact_id: ids.contact } : {}),
    text: '曾经喜欢合成咖啡。', category: 'preference', topic: 'other', source_ids: [ids.memory],
    status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
}

for (const level of ['contact', 'owner']) for (const changeKind of [undefined, 'error_correction', 'state_changed']) {
  test(`公开资料 IPC 保留 ${level} 的 ${changeKind ?? '默认纠错'} 含义`, async () => {
    const posts = [];
    const f = await fixture(async request => {
      if (request.method === 'POST') posts.push(request);
      return { generation: 1, data: request.path.includes('/layered-memory') ? payload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact })
        : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [memory(level)] } };
    });
    try {
      const fields = { memoryId: ids.memory, revision: 1, text: '现在改喝合成茶。', category: 'preference',
        ...(changeKind ? { changeKind } : {}) };
      if (level === 'owner') {
        await f.bridge.readOwnerMemories();
        await f.bridge.correctOwnerMemory(fields);
      } else {
        await f.bridge.refresh({ ...f.selection(), section: level });
        await f.bridge.correct({ ...f.selection(), level, ...fields });
      }
      assert.deepEqual(posts[0].body, { text: fields.text, category: 'preference', change_kind: changeKind ?? 'error_correction' });
    } finally { f.disconnect(); }
  });
}

for (const changeKind of ['unknown', null, true]) test(`公开 IPC 拒绝无效失效原因 ${changeKind}`, async () => {
  const f = await fixture(async () => { throw new Error('无效命令不应发送 HTTP'); });
  try {
    const fields = { memoryId: ids.memory, revision: 1, text: '合成修正', category: 'preference', changeKind };
    await assert.rejects(f.bridge.correct({ ...f.selection(), level: 'contact', ...fields }));
    await assert.rejects(f.bridge.correctOwnerMemory(fields));
  } finally { f.disconnect(); }
});
