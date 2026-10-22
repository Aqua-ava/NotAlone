import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload, profilePayload } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

for (const level of ['contact']) test(`${level} 记忆直接查看、修改和删除，下方展示整理结果`, { timeout: 20000 }, async t => {
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
    // 卡片默认只留正文与省略号入口，修正和移除都从菜单进入。
    const more = (text) => page.getByRole('article').filter({ has: page.getByText(text, { exact: true }) })
      .locator('.memory-more > summary');
    await more(original).click();
    await page.getByRole('button', { name: `修正资料：${original}`, exact: true }).click();
    await page.getByRole('textbox', { name: '资料正文', exact: true }).fill(corrected);
    await page.getByRole('button', { name: '保存修正', exact: true }).click();
    await page.locator('p.memory-text').getByText(corrected, { exact: true }).waitFor();
    const facts = page.getByRole('region', { name: '联系人记忆', exact: true });
    await more(corrected).click();
    await page.getByRole('button', { name: `删除资料：${corrected}`, exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await facts.getByText('还没有记住关于对方的事。', { exact: true }).waitFor();
    const writes = requests.filter(request => request.method === 'POST');
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.text, corrected);
    assert.equal(writes[0].path, `/api/contacts/${ids.contact}/${level === 'owner' ? 'owner-memories' : 'memories'}/${ids.memory}/correct`);
    assert.equal(writes[1].path, `/api/contacts/${ids.contact}/${level === 'owner' ? 'owner-memories' : 'memories'}/${ids.memory}/delete`);
  });
});

test('联系人记忆下方按只读行式展示主题资料与长期背景', { timeout: 20000 }, async t => {
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/layered-memory') ? profilePayload()
    : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  await withMemoryPage(f, t.signal, async page => {
    const scenarios = page.getByRole('region', { name: '主题资料', exact: true });
    await page.getByRole('heading', { name: '合成读书计划', exact: true }).waitFor();
    await scenarios.getByText('讨论中的长期读书安排', { exact: true }).waitFor();
    await scenarios.getByText('曾计划参加合成读书会，当前是否成行尚未核实。', { exact: true }).waitFor();
    const profile = page.getByRole('region', { name: '长期背景', exact: true });
    await profile.getByText('曾有共同读书安排，是否持续尚未核实。', { exact: true }).waitFor();
    await profile.getByText('尚不确定 · 没有新的来源核实持续状态。', { exact: true }).waitFor();
    assert.equal(await page.getByText('整理管理', { exact: true }).count(), 0);
  });
});

test('没有整理结果时不额外渲染分层区块', { timeout: 20000 }, async t => {
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/layered-memory') ? payload()
    : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  await withMemoryPage(f, t.signal, async page => {
    await page.getByText('还没有记住关于对方的事。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: '主题资料', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '长期背景', exact: true }).count(), 0);
  });
});

test('整理停用后仍可回看已有主题资料与长期背景', { timeout: 20000 }, async t => {
  const disabled = profilePayload();
  disabled.layered_memory.enabled = false;
  disabled.layered_memory.status = 'disabled';
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/layered-memory') ? disabled
    : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  await withMemoryPage(f, t.signal, async page => {
    const scenarios = page.getByRole('region', { name: '主题资料', exact: true });
    await page.getByRole('heading', { name: '合成读书计划', exact: true }).waitFor();
    await scenarios.getByText('整理已停用，下方为现有结果。', { exact: true }).waitFor();
    await page.getByRole('region', { name: '长期背景', exact: true }).waitFor();
  });
});
