import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, profilePayload } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

for (const level of ['contact']) test(`${level} 记忆直接查看、修改和删除，不再展示摘要`, { timeout: 20000 }, async t => {
  const original = '合成联系人喜欢清晨散步。';
  const corrected = '合成联系人喜欢傍晚散步。';
  let memories = [{ memory_id: ids.memory, level, ...(level === 'contact' ? { contact_id: ids.contact } : {}),
    text: original, category: 'preference', topic: 'other', source_ids: [ids.memory],
    status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } }];
  const requests = [];
  const f = await fixture(async request => {
    requests.push(request);
    if (request.path.endsWith('/correct')) memories = [{ ...memories[0], text: request.body.text, revision: 2 }];
    if (request.path.endsWith('/delete')) memories = [];
    return { generation: 1, data: request.path.includes('/layered-memory') ? profilePayload({ scope_kind: level, contact_id: level === 'owner' ? null : ids.contact })
      : request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories } };
  });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: level === 'owner' ? '我' : '对方', exact: true }).click();
    await page.locator('p.memory-text').getByText(original, { exact: true }).waitFor();
    assert.equal(await page.getByText('查看摘要', { exact: true }).count(), 0);
    assert.equal(await page.getByText('整理管理', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '主题资料', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '长期背景', exact: true }).count(), 0);
    await page.getByRole('button', { name: `查看来源与版本：${original}`, exact: true }).click();
    await page.getByText(`记忆标识：${ids.memory}`, { exact: true }).waitFor();
    await page.getByRole('button', { name: `修正资料：${original}`, exact: true }).click();
    await page.getByRole('textbox', { name: '资料正文', exact: true }).fill(corrected);
    await page.getByRole('button', { name: '保存修正', exact: true }).click();
    await page.locator('p.memory-text').getByText(corrected, { exact: true }).waitFor();
    await page.getByRole('button', { name: `删除资料：${corrected}`, exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByText(level === 'owner' ? '还没有记住你和这位联系人交流中的事。' : '还没有记住关于对方的事。', { exact: true }).waitFor();
    const writes = requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.text, corrected);
    assert.equal(writes[0].path, `/api/contacts/${ids.contact}/${level === 'owner' ? 'owner-memories' : 'memories'}/${ids.memory}/correct`);
    assert.equal(writes[1].path, `/api/contacts/${ids.contact}/${level === 'owner' ? 'owner-memories' : 'memories'}/${ids.memory}/delete`);
  });
});
