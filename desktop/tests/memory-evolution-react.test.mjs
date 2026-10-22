import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from './layered-memory/support.mjs';
import { withMemoryPage } from './layered-memory/react-support.mjs';

for (const level of ['contact', 'owner', 'pending']) test(`实际 ${level} 记忆卡片只展示正文与操作入口`, { timeout: 20000 }, async t => {
  const kinds = [['supplement', '补充'], ['state_change', '状态变化'], ['error_correction', '错误纠正'], ['historical_supplement', '历史补充'], ['unresolved_conflict', '未解决矛盾'], ['independent', '独立事项']];
  const memories = kinds.map(([kind], index) => ({ memory_id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, level,
    ...(level === 'contact' ? { contact_id: ids.contact } : {}), text: index === 0 ? 'contact曾说会给self留晚饭。' : `合成条件记忆${index + 1}`, category: 'taboo', topic: 'other', source_ids: [ids.memory],
    status: index === 2 ? 'invalidated' : 'active', adoption_method: 'auto', confidence: 1, risk_flags: [], revision: 3,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    evolution: { version: 1, kind, explanation: `后续来源说明${index + 1}：出差已经结束。`, related_versions: [{ memory_id: ids.memory, revision: 2 }], evidence_message_ids: [ids.version], source_supported: true, claim_changed: false, condition_changed: true },
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } }));
  memories.push({ ...memories[0], memory_id: ids.other, evolution: undefined, text: '旧资料变化未知。' });
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/layered-memory') ? payload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact })
    : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: level === 'pending' ? memories.map(memory => ({ ...memory, candidate_id: memory.memory_id, subject: 'contact', status: 'pending' })) : [] }
    : { memories: request.path.endsWith('/owner-memories') ? level === 'owner' ? memories : [] : level === 'contact' ? memories : [] } }));
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: level === 'owner' ? '我' : level === 'pending' ? '待确认' : '对方', exact: true }).click();
    const first = page.getByRole('article').filter({ has: page.getByText('对方曾说会给我留晚饭。', { exact: true }) });
    await first.waitFor();
    assert.doesNotMatch(await first.innerText(), /系统记下|手动保存|日期|适用|变化|分类|版本|置信|self|contact/);
    assert.equal(await first.locator('.memory-more-actions').isVisible(), false);
    assert.equal(await first.locator('.memory-details').count(), 0);
    await first.locator('.memory-more > summary').click();
    assert.match(await first.innerText(), /查看依据/);
    assert.doesNotMatch(await first.innerText(), /日期|适用|变化|分类|版本|置信|44444444/);
    if (level !== 'pending') {
      await first.getByRole('button', { name: /^修正资料：/ }).click();
      await first.getByRole('textbox', { name: '资料正文', exact: true }).waitFor();
      assert.equal(await first.getByRole('textbox', { name: '资料正文', exact: true }).inputValue(), '对方曾说会给我留晚饭。');
      assert.equal(await first.getByRole('combobox').count(), 0);
      await first.getByRole('button', { name: '取消修正', exact: true }).click();
      await first.locator('.memory-more > summary').click();
      await first.getByRole('button', { name: /^撤销自动采纳：/ }).click();
      await first.getByRole('group', { name: '确认删除资料', exact: true }).waitFor();
      await first.getByRole('button', { name: '取消删除', exact: true }).click();
      assert.equal(await first.locator('.memory-more-actions').isVisible(), false);
      await page.getByText('已失效 · 不再引用', { exact: true }).waitFor();
    } else {
      assert.match(await first.innerText(), /尚未记住/);
      await first.getByRole('button', { name: /^确认并保存：/ }).waitFor();
    }
  });
});
