import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from '../layered-memory/support.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';

for (const level of ['contact', 'owner']) test(`实际资料页面明确区分 ${level} 纠错和变化`, { timeout: 20000 }, async t => {
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
    if (level === 'owner') {
      await page.getByRole('button', { name: '本人主题资料', exact: true }).click();
      await page.getByRole('button', { name: '管理底层本人记忆', exact: true }).click();
      await page.getByRole('button', { name: '修正本人记忆', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '联系人记忆', exact: true }).click();
      await page.getByRole('button', { name: `修正资料：${memory.text}`, exact: true }).click();
    }
    const kind = page.getByLabel('修改原因', { exact: true });
    assert.equal(await kind.inputValue(), 'error_correction');
    await page.getByText('原来的内容记错了。旧版只保留供查看，不再用于生成。', { exact: true }).waitFor();
    await kind.selectOption('state_changed');
    await page.getByText('原来的内容曾经成立，后来发生变化。旧版可作为历史参考。', { exact: true }).waitFor();
    await page.getByRole('button', { name: level === 'owner' ? '保存本人记忆修正' : '保存修正', exact: true }).click();
    await page.getByRole('button', { name: level === 'owner' ? '修正本人记忆' : `修正资料：${memory.text}`, exact: true }).waitFor();
    assert.equal(posts.at(-1).body.change_kind, 'state_changed');
  });
});
