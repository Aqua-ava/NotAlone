import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from './layered-memory/support.mjs';
import { withMemoryPage } from './layered-memory/react-support.mjs';

for (const level of ['contact', 'owner']) test(`实际 ${level} 页面区分条件来源和当前满足情况，支持修改与清空`, { timeout: 20000 }, async t => {
  let memory = { memory_id: ids.memory, level, ...(level === 'contact' ? { contact_id: ids.contact } : {}),
    text: '出差期间不便通话。', category: 'taboo', topic: 'other', source_ids: [ids.memory],
    status: 'active', adoption_method: 'auto', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    conditions: { version: 1, items: [{ text: '出差期间', evidence: [{ message_id: ids.memory, char_start: 0, char_end: 4 }], source_supported: true }] },
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false,
      current_status: 'current_unverified', current_status_reason: '附适用条件；来源只支持当时的条件表达，当前是否满足未知。' } };
  const posts = [];
  const f = await fixture(async request => {
    if (request.method === 'POST') {
      posts.push(request);
      memory = { ...memory, revision: memory.revision + 1, conditions: request.body.conditions === null ? null
        : { version: 1, items: request.body.conditions.items.map(item => ({ ...item, source_supported: false })) } };
    }
    return { generation: 1, data: request.path.includes('/layered-memory') ? payload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact })
      : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [memory] } };
  });
  await withMemoryPage(f, t.signal, async page => {
    if (level === 'contact') await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '对方', exact: true }).click();
    await page.getByText('适用条件：出差期间', { exact: true }).waitFor();
    await page.getByText('来源支持限定，当前是否满足未知', { exact: true }).waitFor();
    await page.getByText('已关联 1 条来源消息，可在本条资料的来源中核对原话。', { exact: true }).waitFor();
    const conditionDetails = page.getByRole('group', { name: '记忆适用条件', exact: true });
    assert.doesNotMatch(await conditionDetails.innerText(), /44444444|字符 0 至 4/);
    const modify = () => page.getByRole('button', { name: level === 'owner' ? '修正本人记忆' : `修正资料：${memory.text}`, exact: true });
    const save = () => page.getByRole('button', { name: level === 'owner' ? '保存本人记忆修正' : '保存修正', exact: true });
    await modify().click();
    await page.getByLabel('适用条件', { exact: true }).fill('旅行期间');
    await save().click();
    await page.getByText('适用条件：旅行期间', { exact: true }).waitFor();
    await page.getByText('条件依据未核实，当前是否满足未知', { exact: true }).waitFor();
    assert.deepEqual(posts.at(-1).body.conditions, { version: 1, items: [{ text: '旅行期间', evidence: [] }] });
    await modify().click();
    await page.getByLabel('适用条件', { exact: true }).fill('');
    await save().click();
    await page.getByText('适用条件：未知', { exact: true }).waitFor();
    assert.equal(posts.at(-1).body.conditions, null);
  }, { ownerPanel: level === 'owner' });
});
