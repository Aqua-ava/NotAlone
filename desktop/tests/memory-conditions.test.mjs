import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fixture, ids, payload } from './layered-memory/support.mjs';
const built = await build({ stdin: { contents: `export { memoryTemporalFields, listedMemories } from './src/main/memory/read';`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const conditions = { version: 1, items: [{ text: '出差期间', evidence: [{ message_id: ids.memory, char_start: 0, char_end: 4 }], source_supported: true }] };
const memory = level => ({ memory_id: ids.memory, level, ...(level === 'contact' ? { contact_id: ids.contact } : {}), text: '出差期间不便通话。', category: 'taboo', topic: 'other', source_ids: [ids.memory], status: 'active', adoption_method: 'auto', confidence: 1, risk_flags: [], revision: 1, supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null, conditions, timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } });
test('正式资料和冻结时间读取保留条件依据，旧记录保持未知', () => {
  for (const value of [mod.exports.memoryTemporalFields({ conditions }), mod.exports.listedMemories({ memories: [memory('contact')] }, 'contact', ids.contact)[0]]) {
    assert.equal(value.conditions.items[0].text, '出差期间');
    assert.equal(value.conditions.items[0].sourceSupported, true);
    assert.equal(value.conditions.items[0].evidence[0].messageId, ids.memory);
  }
  assert.equal(mod.exports.memoryTemporalFields({}).conditions, null);
  for (const malformed of [{ ...conditions, current: true }, { version: 1, items: [{ ...conditions.items[0], evidence: [] }] }, { version: 1, items: [{ ...conditions.items[0], source_supported: 'true' }] }]) assert.throws(() => mod.exports.memoryTemporalFields({ conditions: malformed }));
});
for (const level of ['contact', 'owner']) for (const proposal of [null, { version: 1, items: [{ text: '旅行期间', evidence: [] }] }]) test(`修正 ${level} 条件提案或显式清空经过正式 IPC`, async () => {
  const posts = [];
  const f = await fixture(async request => {
    if (request.method === 'POST') posts.push(request);
    return { generation: 1, data: request.path.includes('/layered-memory') ? payload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact }) : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [memory(level)] } };
  });
  try {
    const fields = { memoryId: ids.memory, revision: 1, text: '旅行期间不便通话。', category: 'taboo', conditions: proposal };
    if (level === 'owner') { await f.bridge.readOwnerMemories(); await f.bridge.correctOwnerMemory(fields); }
    else { await f.bridge.refresh({ ...f.selection(), section: level }); await f.bridge.correct({ ...f.selection(), level, ...fields }); }
    assert.deepEqual(posts[0].body.conditions, proposal);
  } finally { f.disconnect(); }
});

test('修正 IPC 拒绝自行认证条件或携带无效来源位置', async () => {
  const f = await fixture(async () => { throw new Error('无效命令不得请求后端'); });
  try {
    for (const item of [
      { text: '出差期间', evidence: [], sourceSupported: true },
      { text: '出差期间', evidence: [{ messageId: ids.memory, charStart: 4, charEnd: 1 }] },
      { text: '出差期间', evidence: Array.from({ length: 9 }, () => ({ messageId: ids.memory, charStart: 0, charEnd: 1 })) },
    ]) {
      const fields = { memoryId: ids.memory, revision: 1, text: '合成正文', category: 'taboo', conditions: { version: 1, items: [item] } };
      await assert.rejects(f.bridge.correctOwnerMemory(fields));
      await assert.rejects(f.bridge.correct({ ...f.selection(), level: 'contact', ...fields }));
    }
  } finally { f.disconnect(); }
});
