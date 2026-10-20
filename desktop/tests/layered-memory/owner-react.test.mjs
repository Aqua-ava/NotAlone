import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids, payload } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

test('本人直接查看和修正记忆，不再展示摘要', { timeout: 20000 }, async (t) => {
  const requests = [];
  let deleted = false;
  const memory = {
    memory_id: ids.memory, level: 'owner', text: '喜欢清晨散步', category: 'common_fact', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 3,
    supersedes_memory_id: ids.other, source_candidate_id: ids.work, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false },
  };
  const f = await fixture(async request => {
    requests.push(request);
    if (request.path.endsWith('/delete')) deleted = true;
    return { generation: 1, data: request.path === '/api/memories/owner'
      ? { memories: deleted ? [] : [memory] } : payload({ scope_kind: 'owner', contact_id: null }) };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
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
    assert.equal(await page.getByText('查看摘要', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '主题资料', exact: true }).count(), 0);
    await card.getByRole('button', { name: '删除本人记忆', exact: true }).click();
    await card.getByRole('button', { name: '确认删除本人记忆', exact: true }).click();
    await page.getByText('还没有记住关于你的事。', { exact: true }).waitFor();
    assert.equal(requests.some(request => request.path.endsWith('/delete') && request.method === 'POST'), true);
  }, { ownerPanel: true });
});

test('本人空记忆列表保留补充资料，不展示摘要设置', { timeout: 20000 }, async (t) => {
  const requests = [];
  const f = await fixture(async request => {
    requests.push(request);
    return { generation: 1, data: request.path === '/api/memories/owner'
      ? { memories: [] } : payload({ scope_kind: 'owner', contact_id: null }) };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByText('还没有记住关于你的事。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '我的记忆', exact: true }).count(), 1);
    assert.equal(await page.getByText('整理管理', { exact: true }).count(), 0);
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
  }, { ownerPanel: true });
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
