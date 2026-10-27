import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids } from '../layered-memory/support.mjs';
import { lifecyclePayload, otherResponse } from './payload.mjs';
import { withMemoryPage } from '../layered-memory/react-support.mjs';

test('真实记忆页保留一张主卡，旧后台任务有数据也不重复显示处理入口', { timeout: 20000 }, async t => {
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/memory-processing')
    ? lifecyclePayload() : otherResponse(request) }));
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    await card.getByText('暂无待处理资料。', { exact: true }).waitFor();
    assert.equal(await card.count(), 1);
    assert.equal(await page.getByRole('region', { name: '当前联系人后台任务', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '继续处理', exact: true }).count(), 0);
  });
});

test('本人入口无需联系人，使用本人状态合同且不读取全部联系人任务', { timeout: 20000 }, async t => {
  const paths = [];
  const f = await fixture(async request => { paths.push(request.path); return { generation: 1, data: request.path.includes('/memory-processing')
    ? lifecyclePayload({ scope: 'owner', contact_id: null }) : otherResponse(request) }; }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('button', { name: '我', exact: true }).click();
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
    assert.ok(paths.includes('/api/owner/memory-processing/state'));
    assert.equal(paths.some(path => path.startsWith('/api/tasks') || path.startsWith('/api/contacts/')), false);
    assert.equal(await page.getByRole('region', { name: '资料范围未确认' }).count(), 0);
  });
});

test('页面五态采用权威当前状态，处理量单独计数，技术编号和旧失败留在折叠历史', { timeout: 20000 }, async t => {
  let status = 'processing';
  const old = { task_id: ids.work, round_id: null, contact_id: ids.contact, task_type: 'observation', status: 'failed',
    phase: 'extract_memory', processed_count: null, total_count: null, unit: null,
    updated_at: '2026-10-20T02:00:00Z', reason_code: 'synthetic_old_failure', attribution: 'legacy' };
  const f = await fixture(async request => ({ generation: 1, data: request.path.includes('/memory-processing')
    ? lifecyclePayload({ current: { ...lifecyclePayload().current, status, phase: 'topics', processed_count: 2, total_count: 3,
      unit: 'memories', pending_count: 4, reason: status === 'blocked' ? '来源核验未完成，请查看详情。' : null,
      reason_code: 'synthetic_current_reason', has_usable_results: true }, history: { entries: [old], next_cursor: 'older-page' } })
    : otherResponse(request) }));
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^处理中$/ }).waitFor();
    await card.getByText('整理主题', { exact: true }).waitFor();
    await card.getByText('已处理 2 / 3 条记忆', { exact: true }).waitFor();
    await card.getByText('另有 4 条聊天等待处理', { exact: true }).waitFor();
    assert.equal(await card.getByText(/synthetic_|66666666/).count(), 0);
    assert.equal(await card.getByRole('progressbar').count(), 0);
    for (const [next, title] of [['paused', '已暂停'], ['blocked', '处理受阻'], ['waiting', '等待处理'], ['completed', '已完成']]) {
      status = next;
      await card.getByRole('button', { name: '刷新状态', exact: true }).click();
      await card.getByRole('status').filter({ hasText: new RegExp(`^${title}$`) }).waitFor();
    }
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const history = card.getByRole('group', { name: '处理历史' });
    assert.equal(await history.getAttribute('open'), null);
    await history.locator('summary').click();
    await history.getByText('旧记录的轮次归属尚无法核实，保留原结果，不据此自动继续。', { exact: true }).waitFor();
    await history.getByText('原始原因：synthetic_old_failure', { exact: true }).waitFor();
    assert.equal(await card.getByRole('status').innerText(), '已完成', '历史截断或旧失败不能覆盖当前完成');
  });
});

test('状态读取失败隐藏业务状态并可刷新，历史失败不改变当前状态且可重试分页', { timeout: 20000 }, async t => {
  let failState = false, failHistory = true;
  const entry = { task_id: ids.work, round_id: null, contact_id: ids.contact, task_type: 'import', status: 'succeeded',
    phase: 'verify', processed_count: 53, total_count: 53, unit: 'messages', updated_at: '2026-10-20T02:00:00Z', reason_code: null, attribution: 'legacy' };
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing/history')) {
      if (failHistory) throw new Error('synthetic_history_failure');
      return { generation: 1, data: { scope: 'contact', contact_id: ids.contact, entries: [entry], next_cursor: null } };
    }
    if (request.path.includes('/memory-processing')) {
      if (failState) throw new Error('synthetic_state_failure');
      return { generation: 1, data: lifecyclePayload({ current: { ...lifecyclePayload().current, status: 'completed' }, history: { entries: [], next_cursor: 'older-page' } }) };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^已完成$/ }).waitFor();
    failState = true;
    await card.getByRole('button', { name: '刷新状态', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: /^状态暂不可用$/ }).waitFor();
    assert.equal(await card.getByRole('status').count(), 0);
    failState = false;
    await card.getByRole('button', { name: '刷新状态', exact: true }).click();
    await card.getByRole('status').filter({ hasText: /^已完成$/ }).waitFor();
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const history = card.getByRole('group', { name: '处理历史' });
    await history.locator('summary').click();
    await history.getByRole('button', { name: '加载更多历史' }).click();
    await history.getByRole('alert').waitFor();
    assert.equal(await card.getByRole('status').innerText(), '已完成');
    failHistory = false;
    await history.getByRole('button', { name: '加载更多历史' }).click();
    await history.getByText('已处理 53 / 53 条聊天', { exact: true }).waitFor();
    assert.equal(await history.getByRole('button', { name: '加载更多历史' }).count(), 0);
    assert.equal(await history.getByRole('alert').count(), 0);
  });
});

test('连接更换立即清空本人快照，迟到历史失败不污染新连接且分页仍可用', { timeout: 20000 }, async t => {
  const oldHistory = Promise.withResolvers(), historyStarted = Promise.withResolvers(), newState = Promise.withResolvers();
  let generation = 1, stateReads = 0;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing/history')) {
      historyStarted.resolve(); return oldHistory.promise;
    }
    if (request.path.includes('/memory-processing')) {
      stateReads++;
      if (generation === 2) return newState.promise;
      return { generation, data: lifecyclePayload({ scope: 'owner', contact_id: null,
        current: { ...lifecyclePayload().current, status: 'completed' }, history: { entries: [], next_cursor: 'older-page' } }) };
    }
    return { generation, data: otherResponse(request) };
  }, { noContact: true });
  try {
    await withMemoryPage(f, t.signal, async page => {
      await page.getByRole('button', { name: '我', exact: true }).click();
      const card = page.getByRole('region', { name: '关系资料处理状态' });
      await card.getByRole('status').filter({ hasText: /^已完成$/ }).waitFor();
      await card.getByRole('button', { name: '查看详情', exact: true }).click();
      const history = card.getByRole('group', { name: '处理历史' });
      await history.locator('summary').click();
      await history.getByRole('button', { name: '加载更多历史' }).click();
      await historyStarted.promise;
      generation = 2; f.changeConnection(2);
      await card.getByRole('status').filter({ hasText: /^正在读取状态…$/ }).waitFor();
      newState.resolve({ generation: 2, data: lifecyclePayload({ scope: 'owner', contact_id: null,
        history: { entries: [], next_cursor: 'newer-page' } }) });
      await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
      oldHistory.reject(new Error('synthetic_old_connection_failure'));
      const loadMore = history.getByRole('button', { name: '加载更多历史' });
      await loadMore.waitFor();
      assert.equal(await loadMore.isEnabled(), true);
      assert.equal(await history.getByRole('alert').count(), 0);
      assert.ok(stateReads >= 2);
    });
  } finally { oldHistory.resolve({ generation: 1, data: {} }); newState.resolve({ generation: 2, data: {} }); }
});

test('首屏历史失败保留权威当前状态，展开历史可独立重试', { timeout: 20000 }, async t => {
  const requests = [];
  const f = await fixture(async request => {
    requests.push(request.path);
    if (request.path.endsWith('/history')) return { generation: 1, data: { scope: 'contact', contact_id: ids.contact, entries: [], next_cursor: null } };
    return { generation: 1, data: request.path.includes('/memory-processing')
      ? lifecyclePayload({ current: { ...lifecyclePayload().current, status: 'completed' },
        history: { entries: [], next_cursor: null, error: '处理历史暂不可用，请刷新重试。' } }) : otherResponse(request) };
  });
  await withMemoryPage(f, t.signal, async page => {
    const card = page.getByRole('region', { name: '关系资料处理状态' });
    await card.getByRole('status').filter({ hasText: /^已完成$/ }).waitFor();
    await card.getByRole('button', { name: '查看详情', exact: true }).click();
    const history = card.getByRole('group', { name: '处理历史' });
    await history.locator('summary').click();
    await history.getByRole('alert').filter({ hasText: '处理历史暂不可用' }).waitFor();
    await history.getByRole('button', { name: '重新读取历史' }).click();
    await history.getByText('暂无处理历史。', { exact: true }).waitFor();
    assert.ok(requests.includes(`/api/contacts/${ids.contact}/memory-processing/history`));
    assert.equal(await card.getByRole('status').innerText(), '已完成');
  });
});


test('页面重复点击只接纳一个动作，回执不会替代权威状态，读取失败撤下动作', { timeout: 20000 }, async t => {
  const acknowledgement = Promise.withResolvers(), accepted = Promise.withResolvers();
  const authoritative = Promise.withResolvers(), reading = Promise.withResolvers();
  let posted = false, failState = false;
  const actions = [];
  const f = await fixture(async request => {
    if (request.method === 'POST' && request.path.endsWith('/pause')) {
      actions.push(request); posted = true; accepted.resolve(); return acknowledgement.promise;
    }
    if (request.path.includes('/memory-processing')) {
      if (failState) throw new Error('synthetic_state_failure');
      if (posted) { reading.resolve(); return authoritative.promise; }
      return { generation: 1, data: lifecyclePayload({ current: { ...lifecyclePayload().current, actions: ['pause'] } }) };
    }
    return { generation: 1, data: otherResponse(request) };
  });
  try {
    await withMemoryPage(f, t.signal, async page => {
      const card = page.getByRole('region', { name: '关系资料处理状态' });
      const pause = card.getByRole('button', { name: '暂停处理', exact: true });
      await pause.waitFor();
      await pause.evaluate(button => { button.click(); button.click(); });
      await accepted.promise;
      assert.equal(actions.length, 1);
      assert.equal(await pause.isDisabled(), true);
      acknowledgement.resolve({ generation: 1, data: { accepted: true, operation_id: actions[0].body.operation_id,
        action: 'pause', action_version: 1, control_generation: 1, replayed: false } });
      await reading.promise;
      assert.equal(await card.getByRole('status').filter({ hasText: /^等待处理$/ }).count(), 1);
      assert.equal(await card.getByRole('status').filter({ hasText: /^已暂停$|^已完成$/ }).count(), 0);
      assert.equal(await card.getByRole('button', { name: '继续处理', exact: true }).count(), 0);
      authoritative.resolve({ generation: 1, data: lifecyclePayload({ control_generation: 1, action_version: 1,
        current: { ...lifecyclePayload().current, status: 'paused', actions: ['continue'], has_usable_results: true,
          reason: '来源核验未完成，已有结果仍保留。' } }) });
      await card.getByRole('status').filter({ hasText: /^已暂停$/ }).waitFor();
      await card.getByText('来源核验未完成，已有结果仍保留。', { exact: true }).waitFor();
      await card.getByText('已保存的合法记忆与画像仍可查看和使用。', { exact: true }).waitFor();
      const resume = card.getByRole('button', { name: '继续处理', exact: true });
      await resume.waitFor();
      failState = true;
      await card.getByRole('button', { name: '刷新状态', exact: true }).click();
      await card.getByRole('alert').filter({ hasText: /^状态暂不可用$/ }).waitFor();
      assert.equal(await resume.count(), 0);
      assert.equal(await pause.count(), 0);
    });
  } finally { acknowledgement.resolve({ generation: 1, data: {} }); authoritative.resolve({ generation: 1, data: {} }); }
});

for (const change of ['contact', 'selection', 'connection']) test(`${change} 改变撤销动作资格，迟到动作回执不污染新范围`, { timeout: 20000 }, async t => {
  const acknowledgement = Promise.withResolvers(), posted = Promise.withResolvers(), settled = Promise.withResolvers();
  let generation = 1, action;
  const f = await fixture(async request => {
    if (request.method === 'POST') { action = request; posted.resolve(); try { return await acknowledgement.promise; } finally { settled.resolve(); } }
    const contactId = request.path.includes(ids.other) ? ids.other : ids.contact;
    return { generation, data: request.path.includes('/memory-processing')
      ? lifecyclePayload({ contact_id: contactId, current: { ...lifecyclePayload().current, actions: ['pause'] } }) : otherResponse(request) };
  });
  try {
    await withMemoryPage(f, t.signal, async page => {
      const card = page.getByRole('region', { name: '关系资料处理状态' });
      await card.getByRole('button', { name: '暂停处理', exact: true }).click(); await posted.promise;
      if (change === 'connection') {
        generation = 2; f.changeConnection(2); await f.contacts.refreshContacts();
        f.contacts.selectContact({ contactId: ids.contact, scopeRevision: f.selection().scopeRevision });
      }
      else {
        f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
        if (change === 'selection') f.contacts.selectContact({ contactId: ids.contact, scopeRevision: f.selection().scopeRevision });
      }
      assert.equal(action.signal.aborted, true);
      await card.getByRole('button', { name: '暂停处理', exact: true }).click({ trial: true });
      await card.getByRole('status').filter({ hasText: /^等待处理$/ }).waitFor();
      acknowledgement.resolve({ generation: 1, data: { accepted: true, operation_id: action.body.operation_id,
        action: 'pause', action_version: 1, control_generation: 1, replayed: false } });
      await settled.promise;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await card.getByRole('status').filter({ hasText: /^等待处理$/ }).count(), 1);
      assert.equal(await card.getByRole('alert').count(), 0);
      assert.equal(await card.getByRole('button', { name: '暂停处理', exact: true }).isEnabled(), true);
    });
  } finally { acknowledgement.resolve({ generation: 1, data: {} }); }
});


test('范围动作撤销在途历史读取后，历史仍可独立重试', { timeout: 20000 }, async t => {
  const oldHistory = Promise.withResolvers(), started = Promise.withResolvers();
  let paused = false, historySignal;
  const f = await fixture(async request => {
    if (request.path.includes('/memory-processing/history')) { historySignal = request.signal; started.resolve(); return oldHistory.promise; }
    if (request.method === 'POST') {
      paused = true;
      return { generation: 1, data: { accepted: true, operation_id: request.body.operation_id, action: 'pause',
        action_version: 1, control_generation: 1, replayed: false } };
    }
    return { generation: 1, data: request.path.includes('/memory-processing') ? lifecyclePayload({ control_generation: paused ? 1 : 0, action_version: paused ? 1 : 0,
      current: { ...lifecyclePayload().current, status: paused ? 'paused' : 'waiting', actions: [paused ? 'continue' : 'pause'] },
      history: { entries: [], next_cursor: 'older-page' } }) : otherResponse(request) };
  });
  try {
    await withMemoryPage(f, t.signal, async page => {
      const card = page.getByRole('region', { name: '关系资料处理状态' });
      await card.getByRole('button', { name: '查看详情', exact: true }).click();
      const history = card.getByRole('group', { name: '处理历史' });
      await history.locator('summary').click();
      await history.getByRole('button', { name: '加载更多历史', exact: true }).click(); await started.promise;
      await card.getByRole('button', { name: '暂停处理', exact: true }).click();
      await card.getByRole('status').filter({ hasText: /^已暂停$/ }).waitFor();
      assert.equal(historySignal.aborted, true);
      assert.equal(await history.getByRole('button', { name: '加载更多历史', exact: true }).isEnabled(), true);
    });
  } finally { oldHistory.resolve({ generation: 1, data: { scope: 'contact', contact_id: ids.contact, entries: [], next_cursor: null } }); }
});
