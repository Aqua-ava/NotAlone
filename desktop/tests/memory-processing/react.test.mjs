import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, ids } from '../layered-memory/support.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';
import { processingPayload } from './payload.mjs';

function otherResponse(request) {
  return request.path.includes('/layered-memory') ? payload() : request.path.endsWith('/sources') ? { sources: [] }
    : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] };
}

test('整体状态优先显示需要继续，排队任务只在详情内，继续处理恢复所有失败项', { timeout: 20000 }, async t => {
  const writes = [];
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      if (request.method === 'POST') {
        writes.push(request.body);
        return { generation: 1, data: { task_id: request.body.task_id, status: 'queued' } };
      }
      const result = processingPayload({ status: 'queued', task_type: 'observation', action: null,
        reason_code: null, processed_count: null, total_count: null });
      for (const taskId of [ids.other, ids.memory]) {
        const resumed = writes.some(write => write.task_id === taskId);
        result.tasks.push({ ...processingPayload().tasks[0], task_id: taskId,
          status: resumed ? 'queued' : 'failed', action: resumed ? null : 'resume' });
      }
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByRole('status').filter({ hasText: /^记忆处理需要继续$/ }).waitFor();
    await card.getByText('部分聊天未完成记忆提取，已保存处理进度。', { exact: true }).waitFor();
    assert.equal(await card.getByRole('heading').count(), 0);
    assert.equal(await card.getByText('新聊天', { exact: false }).count(), 0);
    assert.equal(await card.getByText(/已处理/).count(), 0, '多个任务可能重叠，不能相加或冒充整体进度');
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    await card.getByRole('heading', { name: '同步聊天资料 · 等待生成记忆', exact: true }).waitFor();
    assert.equal(await card.getByRole('heading').count(), 3);
    await card.getByRole('button', { name: '收起', exact: true }).click();
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    assert.deepEqual(writes, [{ task_id: ids.other, action: 'resume' }, { task_id: ids.memory, action: 'resume' }]);
  });
});

test('自动查询期间按钮保持稳定，继续等待当前查询结束且不重复提交', { timeout: 20000 }, async t => {
  const pollStarted = Promise.withResolvers(), pollResult = Promise.withResolvers();
  const resumeStarted = Promise.withResolvers(), resumeResult = Promise.withResolvers();
  const writes = []; let reads = 0, resumed = false;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      if (request.method === 'POST') {
        writes.push(request.body); resumeStarted.resolve();
        await resumeResult.promise; resumed = true;
        return { generation: 1, data: { task_id: ids.other, status: 'queued' } };
      }
      if (++reads === 2) { pollStarted.resolve(); await pollResult.promise; }
      const result = processingPayload({ status: 'extracting', action: null, reason_code: null, processed_count: reads > 1 ? 40 : 20 });
      result.tasks.push({ ...result.tasks[0], task_id: ids.other, task_type: 'observation',
        status: resumed ? 'queued' : 'interrupted', action: resumed ? null : 'resume',
        reason_code: resumed ? null : 'execution_interrupted' });
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  try {
    await withMemoryPage(f, t.signal, async page => {
      const card = page.getByRole('region', { name: '记忆处理状态' });
      await card.getByRole('status').filter({ hasText: /^记忆处理需要继续$/ }).waitFor();
      await card.getByRole('button', { name: '查看详情', exact: true }).click();
      await pollStarted.promise;
      const refresh = card.getByRole('button', { name: '刷新进度', exact: true });
      const resume = card.getByRole('button', { name: '继续', exact: true });
      assert.equal(await refresh.isEnabled(), true, '后台查询不应让刷新进度变灰');
      assert.equal(await resume.isEnabled(), true, '后台查询不应让继续变灰');
      assert.equal(writes.length, 0);
      await resume.click();
      assert.equal(await card.getAttribute('aria-busy'), 'true');
      assert.equal(await refresh.isEnabled(), false);
      assert.equal(writes.length, 0, '继续应先等待在途查询，避免旧响应覆盖恢复后的状态');
      pollResult.resolve();
      await resumeStarted.promise;
      assert.equal(await card.getByRole('button', { name: '提交中…', exact: true }).first().isEnabled(), false);
      resumeResult.resolve();
      await card.getByRole('heading', { name: '同步聊天资料 · 等待生成记忆', exact: true }).waitFor();
      await card.getByText('已处理 40 / 53 条聊天', { exact: true }).first().waitFor();
      assert.deepEqual(writes, [{ task_id: ids.other, action: 'resume' }]);
    });
  } finally { pollResult.resolve(); resumeResult.resolve(); }
});

test('记忆页默认展示真实中断进度，显式继续并回读，任务详情保持折叠', { timeout: 20000 }, async t => {
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
    await card.getByRole('status').filter({ hasText: /^记忆处理需要继续$/ }).waitFor();
    await card.getByText('已处理 20 / 53 条聊天', { exact: true }).first().waitFor();
    assert.equal(await card.getByText('新增 0 条记忆').count(), 0);
    assert.equal(await card.getByRole('progressbar').count(), 0);
    assert.equal(await card.getByRole('heading').count(), 0);
    assert.equal(await card.getByRole('button', { name: '刷新进度' }).count(), 0);
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    assert.equal(await card.getByRole('progressbar').getAttribute('value'), '20');
    await card.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await card.getByRole('heading').count(), 0);
    assert.equal(writes.length, 0);
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByText('等待处理', { exact: true }).waitFor();
    assert.deepEqual(writes, [{ task_id: ids.work, action: 'resume' }]);
  });
});

test('整体状态覆盖等待、生成、整理、完成和停止，跳过或未知结果不冒充完成', { timeout: 20000 }, async t => {
  let task = { status: 'queued', action: null, reason_code: null }, hasMore = false;
  const f = await fixture(async request => request.path.includes('/memory-processing')
    ? { generation: 1, data: { ...processingPayload(task), has_more: hasMore } }
    : { generation: 1, data: otherResponse(request) });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const cases = [
      [{ status: 'extracting', action: null, reason_code: null }, '正在处理记忆'],
      [{ status: 'organizing', action: null, reason_code: null }, '正在处理记忆'],
      [{ status: 'completed', action: null, reason_code: 'batches_skipped' }, '记忆处理需要继续'],
      [{ status: 'completed', action: null, reason_code: 'processing_outcome_unknown' }, '记忆处理需要继续'],
      [{ status: 'completed', action: null, reason_code: null, processed_count: 53 }, '记忆处理已完成'],
      [{ status: 'stopped', action: 'restart', reason_code: 'task_cancelled' }, '记忆处理已停止'],
      [{ status: 'stopped', action: null, reason_code: 'source_unavailable' }, '记忆处理需要继续'],
      [{ status: 'queued', action: null, reason_code: 'model_configuration_unavailable' }, '记忆处理需要继续'],
    ];
    for (const [next, title] of cases) {
      task = next;
      await card.getByRole('button', { name: '刷新进度', exact: true }).click();
      await card.getByRole('status').filter({ hasText: new RegExp(`^${title}$`) }).waitFor();
    }
    task = { status: 'completed', action: null, reason_code: null };
    hasMore = true;
    await card.getByRole('button', { name: '刷新进度', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: /^状态读取不完整$/ }).waitFor();
    await card.getByText('较早的处理记录未完整读取，暂时无法确认整体状态。', { exact: true }).waitFor();
  });
});

test('恢复结果未确认且任务被删除时保留错误，不把空列表显示为完成', { timeout: 20000 }, async t => {
  let removed = false;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      if (request.method === 'POST') { removed = true; throw new Error('synthetic connection closed'); }
      return { generation: 1, data: removed ? { ...processingPayload(), tasks: [] } : processingPayload() };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByText('操作未确认，请查看详情。', { exact: true }).waitFor();
    assert.equal(await card.getByText('记忆处理已完成', { exact: true }).count(), 0);
    assert.equal(await card.getByRole('button', { name: '继续处理', exact: true }).count(), 0);
  });
});

test('统一继续部分提交失败后回读真实进度，再次继续不重发成功任务或重启停止任务', { timeout: 20000 }, async t => {
  const writes = [], resumed = new Set(); let rejectSecond = true;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      if (request.method === 'POST') {
        writes.push(request.body);
        if (request.body.task_id === ids.other && rejectSecond) throw new Error('synthetic unavailable');
        resumed.add(request.body.task_id);
        return { generation: 1, data: { task_id: request.body.task_id, status: 'queued' } };
      }
      const result = processingPayload();
      result.tasks = [ids.work, ids.other].map(taskId => ({ ...result.tasks[0], task_id: taskId,
        status: resumed.has(taskId) ? 'queued' : 'failed', action: resumed.has(taskId) ? null : 'resume' }));
      result.tasks.push({ ...result.tasks[0], task_id: ids.memory, status: 'stopped', action: 'restart', reason_code: 'task_cancelled' });
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByText('操作未确认，请查看详情。', { exact: true }).waitFor();
    await card.getByRole('status').filter({ hasText: /^记忆处理需要继续$/ }).waitFor();
    rejectSecond = false;
    await card.getByRole('button', { name: '继续处理', exact: true }).click();
    await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    assert.deepEqual(writes, [
      { task_id: ids.work, action: 'resume' }, { task_id: ids.other, action: 'resume' }, { task_id: ids.other, action: 'resume' },
    ]);
  });
});

test('没有任务时不显示等待处理，也不制造已完成状态', { timeout: 20000 }, async t => {
  const f = await fixture(async request => request.path.includes('/memory-processing')
    ? { generation: 1, data: { ...processingPayload(), tasks: [] } }
    : { generation: 1, data: otherResponse(request) });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('navigation', { name: '记忆分类' }).waitFor();
    await page.getByText('正在读取状态…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('region', { name: '记忆处理状态' }).count(), 0);
  });
});

test('来源不可用与执行中并存时，整体栏同时说明仍在处理', { timeout: 20000 }, async t => {
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      const result = processingPayload({ status: 'stopped', action: null, reason_code: 'source_unavailable' });
      result.tasks.push({ ...result.tasks[0], task_id: ids.other, status: 'extracting', reason_code: null });
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByText('部分聊天仍在处理，另有部分来源已不可用。请查看详情。', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '重新开始', exact: true }).count(), 0);
  });
});

test('整体展示停止状态，任务和历史放进详情，重新开始必须显式点击', { timeout: 20000 }, async t => {
  const writes = []; let restarted = false;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      if (request.method === 'POST') { writes.push(request.body); restarted = true; return { generation: 1, data: { task_id: ids.work, status: 'queued' } }; }
      const result = processingPayload({ status: restarted ? 'queued' : 'stopped', action: restarted ? null : 'restart',
        processed_count: null, total_count: null, reason_code: restarted ? null : 'memory_extraction_failed' });
      result.tasks.push({ ...result.tasks[0], task_id: ids.other, status: 'completed', action: null, reason_code: null });
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByText('记忆处理已停止', { exact: true }).waitFor();
    assert.equal(await page.getByRole('group', { name: '处理历史', exact: true }).count(), 0);
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const history = card.getByRole('group', { name: '处理历史', exact: true });
    await history.locator('summary').waitFor();
    assert.equal(await history.getAttribute('open'), null);
    assert.equal(await history.getByRole('button', { name: '重新开始', exact: true }).isVisible(), false);
    await history.locator('summary').click();
    await history.getByRole('heading', { name: '历史导入 · 本次处理完成', exact: true }).waitFor();
    assert.equal(await history.getByText('旧记录，暂无统计', { exact: true }).count(), 2);
    const text = await history.innerText();
    for (const hidden of [ids.work, ids.other, 'memory_extraction_failed', '背景整理', '没有可靠的历史进度统计']) assert.ok(!text.includes(hidden));
    assert.equal(writes.length, 0);
    await history.getByRole('button', { name: '重新开始', exact: true }).click();
    await page.getByRole('region', { name: '记忆处理状态' }).getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    assert.deepEqual(writes, [{ task_id: ids.work, action: 'restart' }]);
    assert.equal(await history.getByRole('heading').count(), 1);
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
    await page.getByRole('button', { name: '修正资料：原有合成偏好。', exact: true }).click();
    const input = page.getByRole('textbox', { name: '资料正文', exact: true });
    await input.fill('尚未保存的人工草稿。');
    advanced = true;
    await card.getByText('已处理 40 / 53 条聊天', { exact: true }).first().waitFor();
    await page.getByText('新生成合成偏好。', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '尚未保存的人工草稿。');
  });
});

test('本人分类仍限定当前联系人任务并显示中文失败原因，读取失败不冒充无任务', { timeout: 20000 }, async t => {
  let fail = false; const writes = [], processingPaths = [];
  const f = await fixture(async request => {
    if (request.method !== 'GET') writes.push(request);
    if (request.path.includes('/memory-processing')) {
      processingPaths.push(request.path);
      if (fail) throw new Error('synthetic unavailable');
      const result = processingPayload({ status: 'failed', reason_code: 'memory_extraction_failed', processed_count: null, total_count: null });
      result.tasks.push({ ...result.tasks[0], task_id: ids.other, status: 'stopped', action: 'restart', reason_code: 'task_cancelled' });
      if (request.path.startsWith('/api/owner/')) Object.assign(result, { scope: 'owner', contact_id: null });
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('navigation', { name: '记忆分类' }).getByRole('button', { name: '我', exact: true }).click();
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByRole('status').filter({ hasText: /^记忆处理需要继续$/ }).waitFor();
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    await card.getByText('上次未能从聊天中生成记忆，具体原因未记录。', { exact: true }).waitFor();
    assert.equal(await card.getByRole('heading').count(), 1);
    assert.equal(await card.getByRole('progressbar').count(), 0);
    assert.ok(!(await card.innerText()).includes('memory_extraction_failed'));
    fail = true;
    await card.getByRole('button', { name: '刷新进度' }).click();
    await card.getByText('处理状态暂时读取失败，请刷新重试。', { exact: true }).waitFor();
    assert.equal(await card.getByText('本次处理完成', { exact: true }).count(), 0);
    assert.equal(writes.length, 0);
    assert.ok(processingPaths.length > 0);
    assert.ok(processingPaths.every(path => path.startsWith(`/api/contacts/${ids.contact}/`)));
  });
});

test('较多历史分页查看，不把所有旧任务展开成长页', { timeout: 20000 }, async t => {
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing')) {
      const result = processingPayload({ status: 'completed', action: null, reason_code: null });
      result.tasks = Array.from({ length: 7 }, (_, index) => ({ ...result.tasks[0],
        task_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
      return { generation: 1, data: result };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '记忆处理状态' });
    await card.getByText('记忆处理已完成', { exact: true }).waitFor();
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const history = card.getByRole('group', { name: '处理历史', exact: true });
    await history.locator('summary').click();
    assert.equal(await history.getByRole('heading').count(), 6);
    await history.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await history.getByRole('heading').count(), 1);
    assert.equal(await page.getByRole('region', { name: '记忆处理状态' }).count(), 1);
  });
});
