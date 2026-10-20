import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from './layered-memory/support.mjs';
import { withMemoryPage } from './layered-memory/react-support.mjs';

for (const level of ['contact', 'owner', 'pending']) test(`实际 ${level} 记忆页面说明条件变化及各版本依据，不认证现实或撤销原主张`, { timeout: 20000 }, async t => {
  const kinds = [['supplement', '补充'], ['state_change', '状态变化'], ['error_correction', '错误纠正'], ['historical_supplement', '历史补充'], ['unresolved_conflict', '未解决矛盾']];
  const memories = kinds.map(([kind], index) => ({ memory_id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, level,
    ...(level === 'contact' ? { contact_id: ids.contact } : {}), text: `合成条件记忆${index + 1}`, category: 'taboo', topic: 'other', source_ids: [ids.memory],
    status: index === 2 ? 'invalidated' : 'active', adoption_method: 'auto', confidence: 1, risk_flags: [], revision: 3,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    evolution: { version: 1, kind, explanation: `后续来源说明${index + 1}：出差已经结束。`, related_versions: [{ memory_id: ids.memory, revision: 2 }], evidence_message_ids: [ids.version], source_supported: true, claim_changed: false, condition_changed: true },
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } }));
  memories.push({ ...memories[0], memory_id: ids.other, evolution: undefined, text: '旧资料变化未知。' });
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/layered-memory') ? payload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact })
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: level === 'pending' ? memories.map(memory => ({ ...memory, candidate_id: memory.memory_id, subject: 'contact', status: 'pending' })) : [] } : { memories: level === 'pending' ? [] : memories } }));
  await withMemoryPage(f, t.signal, async page => {
    if (level === 'contact') await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '对方', exact: true }).click();
    if (level === 'pending') await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '待确认', exact: true }).click();
    await page.getByText('变化依据：未知', { exact: true }).waitFor();
    for (const [, label] of kinds) await page.getByText(`变化类型：${label}`, { exact: true }).waitFor();
    const details = page.getByRole('group', { name: '记忆变化依据', exact: true }).first();
    assert.match(await details.innerText(), /后续来源说明1：出差已经结束。/);
    assert.match(await details.innerText(), /仅来源支持，不认证现实/);
    assert.match(await details.innerText(), /条件发生变化；原主张未标记为改变，不代表撤销原偏好或禁忌/);
    await details.getByText('查看关联版本与来源', { exact: true }).click();
    assert.match(await details.innerText(), /44444444-4444-4444-8444-444444444444.*版本 2/);
    assert.match(await details.innerText(), /33333333-3333-4333-8333-333333333333/);
    assert.match(await page.locator('body').innerText(), /当前主张仍有不确定性/);
    assert.match(await page.locator('body').innerText(), /补充的是历史信息/);
    if (level !== 'pending') assert.match(await page.locator('body').innerText(), /不再引用/);
  }, { ownerPanel: level === 'owner' });
});
