import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids } from '../layered-memory/support.mjs';
import { lifecyclePayload } from './payload.mjs';

test('生产具名桥接读取权威五态合同，不从历史首屏推测状态', async () => {
  const requests = [];
  const f = await fixture(async request => { requests.push(request); return { generation: 1, data: lifecyclePayload({
    current: { ...lifecyclePayload().current, status: 'completed' }, history: { entries: [], next_cursor: 'older-page' },
  }) }; });
  try {
    const value = await f.bridge.readProcessing({ scope: 'contact', ...f.selection() });
    assert.equal(value.current.status, 'completed');
    assert.equal(value.history.nextCursor, 'older-page');
    assert.equal(value.controlGeneration, 0);
    assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: `/api/contacts/${ids.contact}/memory-processing/state` },
    ]);
  } finally { f.disconnect(); }
});

for (const scope of ['contact', 'owner']) test(`${scope} 进度变化静默刷新已展示记忆，不发布清空状态，且不发起生成`, async () => {
  const memory = { memory_id: ids.memory, level: scope, ...(scope === 'contact' ? { contact_id: ids.contact } : {}), text: '合成偏好。', category: 'preference', topic: 'other',
    source_ids: [ids.memory], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
    supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
    timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
  let changed = false; const methods = [];
  const f = await fixture(async request => { methods.push(request.method); return { generation: 1, data: { memories: [memory,
    ...(changed ? [{ ...memory, memory_id: ids.other, text: '新增合成偏好。' }] : [])] } }; });
  try {
    await f.bridge.refresh({ ...f.selection(), section: scope });
    assert.equal((await f.bridge.getState())[scope].items.length, 1);
    const states = []; const unsubscribe = f.bridge.onStateChanged(state => states.push(state[scope]));
    changed = true; await f.bridge.refreshProcessingResults(scope === 'owner' ? { scope } : { scope, ...f.selection() });
    unsubscribe();
    assert.equal((await f.bridge.getState())[scope].items.length, 2);
    assert.ok(states.every(state => state.phase === 'ready' && state.items.length > 0));
    assert.ok(methods.every(method => method === 'GET'));
  } finally { f.disconnect(); }
});


test('本人状态无须联系人，拒绝联系人任务伪装为本人历史，且未授权逐任务恢复', async () => {
  let data = lifecyclePayload({ scope: 'owner', contact_id: null });
  const requests = [];
  const f = await fixture(async request => { requests.push(request); return { generation: 1, data }; }, { noContact: true });
  try {
    assert.equal((await f.bridge.readProcessing({ scope: 'owner' })).scope, 'owner');
    assert.equal(requests[0].path, '/api/owner/memory-processing/state');
    await assert.rejects(f.bridge.resumeProcessing({ scope: 'owner', taskId: ids.work, action: 'resume' }));
    data = { ...data, history: { entries: [historyEntry()], next_cursor: null } };
    await assert.rejects(f.bridge.readProcessing({ scope: 'owner' }));
    assert.ok(requests.every(request => request.method === 'GET'));
  } finally { f.disconnect(); }
});

function historyEntry(overrides = {}) {
  return { task_id: ids.work, round_id: null, contact_id: ids.contact, task_type: 'observation', status: 'failed',
    phase: 'extract_memory', processed_count: null, total_count: null, unit: null,
    updated_at: '2026-10-20T02:00:00Z', reason_code: 'synthetic_failure', attribution: 'legacy', ...overrides };
}

test('历史具名分页只读当前范围，跨联系人响应和伪造动作拒绝', async () => {
  let data = { scope: 'contact', contact_id: ids.contact, entries: [historyEntry()], next_cursor: null };
  const requests = [];
  const f = await fixture(async request => { requests.push(request); return { generation: 1, data }; });
  try {
    const request = { scope: 'contact', ...f.selection(), cursor: 'older-page' };
    assert.equal((await f.bridge.readProcessingHistory(request)).entries[0].taskId, ids.work);
    assert.equal(requests[0].path, `/api/contacts/${ids.contact}/memory-processing/history?cursor=older-page`);
    data.entries[0].contact_id = ids.other;
    await assert.rejects(f.bridge.readProcessingHistory(request));
    await assert.rejects(f.bridge.readProcessingHistory({ ...request, cursor: '../tasks' }));
    data = lifecyclePayload(); data.current.actions.push({ kind: 'resume' });
    await assert.rejects(f.bridge.readProcessing({ scope: 'contact', ...f.selection() }));
  } finally { f.disconnect(); }
});

for (const change of ['contact', 'selection', 'connection', 'cancel']) test(`${change} 改变后迟到状态与历史不能回填`, async () => {
  const state = Promise.withResolvers(), history = Promise.withResolvers();
  const signals = [];
  const f = await fixture(request => {
    signals.push(request.signal);
    return request.path.includes('/history') ? history.promise : state.promise;
  });
  try {
    const request = { scope: 'contact', ...f.selection() };
    const reading = f.bridge.readProcessing(request), paging = f.bridge.readProcessingHistory({ ...request, cursor: 'older-page' });
    const rejected = [assert.rejects(reading), assert.rejects(paging)];
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'contact') f.contacts.selectContact({ contactId: ids.other, scopeRevision: request.scopeRevision });
    if (change === 'selection') {
      f.contacts.selectContact({ contactId: ids.other, scopeRevision: request.scopeRevision });
      f.contacts.selectContact({ contactId: ids.contact, scopeRevision: f.selection().scopeRevision });
    }
    if (change === 'connection') f.changeConnection(2);
    if (change === 'cancel') await f.bridge.cancelProcessingRead(request);
    assert.ok(signals.every(signal => signal.aborted));
    state.resolve({ generation: 1, data: lifecyclePayload() });
    history.resolve({ generation: 1, data: { scope: 'contact', contact_id: ids.contact, entries: [], next_cursor: null } });
    await Promise.all(rejected);
  } finally { f.disconnect(); }
});

test('本人读取不会被联系人选择变化取消，无效计数或未指定单位拒绝', async () => {
  const result = Promise.withResolvers(); let signal;
  const f = await fixture(request => { signal = request.signal; return result.promise; });
  try {
    const reading = f.bridge.readProcessing({ scope: 'owner' });
    await new Promise(resolve => setImmediate(resolve));
    f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
    assert.equal(signal.aborted, false);
    result.resolve({ generation: 1, data: lifecyclePayload({ scope: 'owner', contact_id: null }) });
    assert.equal((await reading).scope, 'owner');
  } finally { f.disconnect(); }
  for (const fields of [{ processed_count: -1, unit: 'messages' }, { processed_count: 5, total_count: 4, unit: 'messages' }, { processed_count: 4, unit: null }]) {
    const invalid = await fixture(async () => ({ generation: 1, data: lifecyclePayload({ current: { ...lifecyclePayload().current, ...fields } }) }));
    try { await assert.rejects(invalid.bridge.readProcessing({ scope: 'contact', ...invalid.selection() })); }
    finally { invalid.disconnect(); }
  }
});
