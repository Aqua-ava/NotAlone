import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, ids } from '../layered-memory/support.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';
import { processingPayload } from './payload.mjs';

function otherResponse(request) {
  return request.path.includes('/layered-memory') ? payload() : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] };
}

test('记忆页默认展示真实中断进度，显式继续并回读，来源历史保持折叠', { timeout: 20000 }, async t => {
  const writes = []; let resumed = false;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      if (request.method === 'POST') { writes.push(request.body); resumed = true; return { generation: 1, data: { task_id: ids.work, status: 'queued' } }; }
      return { generation: 1, data: processingPayload(resumed ? { status: 'queued', action: null, reason_code: null } : {}) };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByText('处理已中断', { exact: true }).waitFor();
    await card.getByText('已处理 20 / 53 条聊天', { exact: true }).first().waitFor();
    assert.equal(await card.getByText('新增 0 条记忆').count(), 0);
    assert.equal(await card.getByRole('progressbar').getAttribute('value'), '20');
    assert.equal(await page.locator('summary').filter({ hasText: /^历史与来源$/ }).locator('..').getAttribute('open'), null);
    assert.equal(writes.length, 0);
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByText('等待处理', { exact: true }).waitFor();
    assert.deepEqual(writes, [{ task_id: ids.work, action: 'resume' }]);
  });
});

test('无可靠总量不画百分比，读取失败不能显示完成，本人入口明确全部联系人范围', { timeout: 20000 }, async t => {
  let fail = false;
  const writes = [];
  const f = await fixture(async request => {
    if (request.method !== 'GET') writes.push(request);
    if (request.path.includes('/memory-processing')) {
      if (fail) throw new Error('synthetic unavailable');
      return { generation: 1, data: { ...processingPayload({ status: 'stopped', action: 'restart', processed_count: null, total_count: null, reason_code: 'task_cancelled' }),
        ...(request.path.startsWith('/api/owner/') ? { scope: 'owner', contact_id: null } : {}) } };
    }
    const data = otherResponse(request);
    if (request.path.startsWith('/api/memories/owner/layered-memory')) Object.assign(data.layered_memory, { scope_kind: 'owner', contact_id: null });
    return { generation: 1, data };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByText('已停止', { exact: true }).waitFor();
    assert.equal(await card.getByRole('progressbar').count(), 0);
    await card.getByRole('button', { name: '重新处理历史', exact: true }).waitFor();
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '我', exact: true }).click();
    await card.getByText('全部联系人任务（可能含本人信息），非本人专属。', { exact: true }).waitFor();
    await card.getByText('资料联系人：合成主题联系人', { exact: true }).first().waitFor();
    fail = true;
    await card.getByRole('button', { name: '刷新进度' }).click();
    await card.getByRole('alert').getByText('处理状态暂时读取失败，请刷新重试。', { exact: true }).waitFor();
    assert.equal(await card.getByText('本次提取完成', { exact: true }).count(), 0);
    assert.equal(writes.length, 0);
  });
});

test('可见页面按真实进展更新记忆，新增结果不清空正在编辑的草稿', { timeout: 20000 }, async t => {
  const memory = { memory_id: ids.memory, level: 'contact', contact_id: ids.contact, text: '原有合成偏好。', category: 'preference', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  let advanced = false;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) return { generation: 1, data: processingPayload({
      status: 'extracting', action: null, reason_code: null, processed_count: advanced ? 40 : 20 }) };
    if (request.path === `/api/contacts/${ids.contact}/memories`) return { generation: 1, data: { memories: [memory,
      ...(advanced ? [{ ...memory, memory_id: ids.other, text: '新生成合成偏好。' }] : [])] } };
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByText('已处理 20 / 53 条聊天', { exact: true }).first().waitFor();
    await page.locator('summary').filter({ hasText: /^逐条记忆$/ }).click();
    await page.getByRole('button', { name: '修正资料：原有合成偏好。', exact: true }).click();
    const input = page.getByRole('textbox', { name: '资料正文', exact: true });
    await input.fill('尚未保存的人工草稿。');
    advanced = true;
    await card.getByText('已处理 40 / 53 条聊天', { exact: true }).first().waitFor();
    await page.getByText('新生成合成偏好。', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '尚未保存的人工草稿。');
  });
});
