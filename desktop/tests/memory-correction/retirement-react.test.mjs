import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from '../layered-memory/support.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';

for (const level of ['contact', 'owner']) test(`实际资料页面沿操作菜单修正 ${level} 并保留默认纠错`, { timeout: 20000 }, async t => {
  const memory = { memory_id: ids.memory, level, ...(level === 'contact' ? { contact_id: ids.contact } : {}),
    text: '合成咖啡偏好。', category: 'preference', topic: 'other', source_ids: [ids.memory],
    status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  const posts = [];
  const f = await fixture(async request => {
    if (request.method === 'POST') posts.push(request);
    return { generation: 1, data: request.path.includes('/layered-memory') ? payload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact })
      : request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [memory] } };
  });
  await withMemoryPage(f, t.signal, async page => {
    // 固定迁移前基线已合并卡片操作；state_changed仍由IPC/HTTP合同单独验证。
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: level === 'owner' ? '我' : '对方', exact: true }).click();
    await page.getByLabel(`更多操作：${memory.text}`, { exact: true }).click();
    await page.getByRole('button', { name: `修正资料：${memory.text}`, exact: true }).click();
    await page.getByLabel('资料正文', { exact: true }).fill('现在喜欢合成茶。');
    await page.getByRole('button', { name: '保存修正', exact: true }).click();
    await page.getByLabel(`更多操作：${memory.text}`, { exact: true }).waitFor();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, level === 'owner'
      ? `/api/contacts/${ids.contact}/owner-memories/${ids.memory}/correct`
      : `/api/contacts/${ids.contact}/memories/${ids.memory}/correct`);
    assert.equal(posts.at(-1).body.text, '现在喜欢合成茶。');
    assert.equal(posts.at(-1).body.change_kind, 'error_correction');
  });
});
