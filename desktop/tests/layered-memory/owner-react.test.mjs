import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from './support.mjs';
import { selectLayeredMemory, withMemoryPage } from './react-support.mjs';

test('本人入口直接展示实际记忆，摘要与技术详情按需读取展开', { timeout: 20000 }, async (t) => {
  const requests = [];
  const memory = {
    memory_id: ids.memory, level: 'owner', text: '喜欢清晨散步', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 3,
    supersedes_memory_id: ids.other, source_candidate_id: ids.work, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false },
  };
  const f = await fixture(async request => {
    requests.push(request);
    return { generation: 1, data: request.path === '/api/memories/owner'
      ? { memories: [memory] } : payload({ scope_kind: 'owner', contact_id: null }) };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '我', exact: true }).click();
    await page.getByRole('heading', { name: '我的记忆', exact: true }).waitFor();
    await page.getByText(memory.text, { exact: true }).waitFor();
    assert.equal(await page.getByText(memory.text, { exact: true }).count(), 1);
    assert.equal(await page.getByText('版本 3', { exact: true }).isVisible(), false);
    assert.equal(requests.some(request => request.path.includes('/layered-memory')), false);
    assert.equal(requests.some(request => request.method !== 'GET'), false);
    const card = page.getByRole('article').filter({ hasText: memory.text });
    await card.getByText('查看详情', { exact: true }).click();
    await card.getByText(`替代版本引用：${ids.other}`, { exact: true }).waitFor();
    await card.getByText(`来源候选引用：${ids.work}`, { exact: true }).waitFor();
    await card.getByText('来源聊天时间：未知（来源时间不完整）', { exact: true }).waitFor();
    await card.getByRole('button', { name: '修正本人记忆', exact: true }).click();
    await card.getByLabel('资料分类', { exact: true }).selectOption('preference');
    await card.getByRole('button', { name: '保存本人记忆修正' }).click();
    await page.getByText('本人资料已保存，请核对整理状态。', { exact: true }).waitFor();
    assert.equal(requests.find(request => request.path.endsWith('/correct')).body.category, 'preference');
    await page.getByText('查看摘要', { exact: true }).click();
    await page.getByText('整理设置与状态', { exact: true }).waitFor();
    assert.equal(requests.some(request => request.path === '/api/memories/owner/layered-memory'), true);
  });
});

test('无联系人也可读取本人的空记忆列表，默认不展示摘要设置', { timeout: 20000 }, async (t) => {
  const requests = [];
  const f = await fixture(async request => {
    requests.push(request);
    return { generation: 1, data: request.path === '/api/memories/owner'
      ? { memories: [] } : payload({ scope_kind: 'owner', contact_id: null }) };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '我', exact: true }).click();
    await page.getByText('还没有记住关于你的事。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '我的记忆', exact: true }).count(), 1);
    assert.equal(await page.getByText('整理设置与状态', { exact: true }).count(), 0);
    assert.equal(requests.filter(request => request.path === '/api/memories/owner').length, 1);
    assert.equal(requests.some(request => request.path.includes('/layered-memory')), false);
    await page.locator('summary').filter({ hasText: /^＋ 补充一条$/ }).click();
    await page.getByLabel('本人资料内容').waitFor();
    assert.equal(requests.some(request => request.method !== 'GET'), false);
    const form = page.getByRole('form', { name: '补充本人资料' });
    await form.getByLabel('本人资料内容').fill('合成偏好');
    await form.getByLabel('资料分类', { exact: true }).selectOption('preference');
    await form.getByRole('button', { name: '保存本人资料' }).click();
    await page.getByText('本人资料已保存，请核对整理状态。', { exact: true }).waitFor();
    assert.equal(requests.find(request => request.path === '/api/memories/manual-owner').body.category, 'preference');
  });
});

test('无联系人可通过当前React页面确认本人范围、停用及删除', { timeout: 20000 }, async (t) => {
  let saved = payload({ scope_kind: 'owner', contact_id: null });
  const f = await fixture(async request => {
    if (request.path.endsWith('/enable')) saved = payload({ scope_kind: 'owner', contact_id: null, enabled: true, status: 'blocked', settings_generation: 1 });
    if (request.path.endsWith('/disable') || request.path.endsWith('/delete')) saved = payload({ scope_kind: 'owner', contact_id: null, settings_generation: 2 });
    return { generation: 1, data: saved };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    await selectLayeredMemory(page, true);
    await page.getByRole('checkbox', { name: /确认仅整理本人的/ }).check();
    await page.getByRole('button', { name: '确认范围并开启' }).click();
    await page.getByText('已开启范围，质量资格待核验', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停用主题资料' }).click();
    await page.getByRole('checkbox', { name: /确认仅整理本人的/ }).waitFor();
    await page.getByRole('button', { name: '删除整理结果', exact: true }).click();
    await page.getByRole('button', { name: '确认删除整理结果' }).click();
    await page.getByText('本人资料操作已完成并核对。', { exact: true }).waitFor();
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).value.enabled, false);
  });
});

test('React测试取消立即结束页面等待并关闭自有浏览器', { timeout: 20000 }, async (t) => {
  const cancellation = new AbortController();
  const f = await fixture(async () => ({ generation: 1, data: payload({ scope_kind: 'owner', contact_id: null }) }), { noContact: true });
  await assert.rejects(withMemoryPage(f, AbortSignal.any([t.signal, cancellation.signal]), async page => {
    const waiting = page.getByRole('button', { name: '不存在的合成控件', exact: true }).waitFor({ timeout: 0 });
    cancellation.abort();
    await waiting;
  }), /closed|cancel/i);
});
