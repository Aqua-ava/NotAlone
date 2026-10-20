import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, ids } from '../layered-memory/support.mjs';

import { processingPayload } from './payload.mjs';

test('进度公开桥接读取持久化批次，不启动提取，未知记忆计数保留未知', async () => {
  const requests = [];
  const f = await fixture(async request => { requests.push(request); return { generation: 1, data: processingPayload() }; });
  try {
    const state = await f.bridge.readProcessing({ scope: 'contact', ...f.selection() });
    assert.equal(state.tasks[0].processedCount, 20);
    assert.equal(state.tasks[0].totalCount, 53);
    assert.equal(state.tasks[0].createdCount, null);
    assert.equal(state.tasks[0].status, 'interrupted');
    assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: `/api/contacts/${ids.contact}/memory-processing` }]);
  } finally { f.disconnect(); }
});

test('继续仅允许当前已读取任务，重复提交合并，显式重新处理保留动作区别', async () => {
  const writes = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async request => {
    if (request.method === 'GET') return { generation: 1, data: processingPayload() };
    writes.push(request); await gate; return { generation: 1, data: { task_id: ids.work, status: 'queued' } };
  });
  try {
    const request = { scope: 'contact', ...f.selection() };
    await f.bridge.readProcessing(request);
    await assert.rejects(f.bridge.resumeProcessing({ ...request, taskId: ids.work, action: 'restart' }));
    const first = f.bridge.resumeProcessing({ ...request, taskId: ids.work, action: 'resume' });
    const second = f.bridge.resumeProcessing({ ...request, taskId: ids.work, action: 'resume' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body, { task_id: ids.work, action: 'resume' });
    assert.equal(writes[0].path, `/api/contacts/${ids.contact}/memory-processing/resume`);
    release(); await Promise.all([first, second]);
  } finally { release(); f.disconnect(); }
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

test('切换联系人和卸载取消进度读取，迟到响应不能展示或授权旧范围恢复', async () => {
  let release, signal;
  const f = await fixture(request => { signal = request.signal; return new Promise(resolve => { release = () => resolve({ generation: 1, data: processingPayload() }); }); });
  try {
    const scope = { scope: 'contact', ...f.selection() };
    const reading = f.bridge.readProcessing(scope);
    const rejected = assert.rejects(reading);
    await new Promise(resolve => setImmediate(resolve));
    f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
    assert.equal(signal.aborted, true); release(); await rejected;
    await assert.rejects(f.bridge.resumeProcessing({ ...scope, taskId: ids.work, action: 'resume' }));
    const current = { scope: 'contact', ...f.selection() };
    const another = f.bridge.readProcessing(current); const cancelled = assert.rejects(another);
    await new Promise(resolve => setImmediate(resolve));
    await f.bridge.cancelProcessingRead(current); assert.equal(signal.aborted, true); release(); await cancelled;
  } finally { f.disconnect(); }
});

test('本人范围无需当前联系人并保持全范围标签，跨联系人响应与无效计数拒绝', async () => {
  let data = { ...processingPayload(), scope: 'owner', contact_id: null };
  const paths = [];
  const f = await fixture(async request => { paths.push(request.path); return { generation: 1, data }; }, { noContact: true });
  try {
    const value = await f.bridge.readProcessing({ scope: 'owner' });
    assert.equal(value.scope, 'owner'); assert.equal(value.contactId, null);
    assert.deepEqual(paths, ['/api/owner/memory-processing']);
    await assert.rejects(f.bridge.readProcessing({ scope: 'owner', contactId: ids.contact }));
    data = { ...data, tasks: [{ ...data.tasks[0], processed_count: 54 }] };
    await assert.rejects(f.bridge.readProcessing({ scope: 'owner' }));
  } finally { f.disconnect(); }
  const contact = await fixture(async () => ({ generation: 1, data: { ...processingPayload(), contact_id: ids.other } }));
  try { await assert.rejects(contact.bridge.readProcessing({ scope: 'contact', ...contact.selection() })); }
  finally { contact.disconnect(); }
});

test('点击继续时后台已完成的竞争视为幂等成功，回读真实完成状态', async () => {
  let finished = false;
  const f = await fixture(async request => {
    if (request.method === 'POST') { finished = true; return { generation: 1, data: { task_id: ids.work, status: 'completed' } }; }
    return { generation: 1, data: processingPayload(finished ? { status: 'completed', action: null } : {}) };
  });
  try {
    const scope = { scope: 'contact', ...f.selection() };
    await f.bridge.readProcessing(scope);
    await f.bridge.resumeProcessing({ ...scope, taskId: ids.work, action: 'resume' });
    assert.equal((await f.bridge.readProcessing(scope)).tasks[0].status, 'completed');
  } finally { f.disconnect(); }
});

test('本人进度读取不被联系人切换取消，恢复仍限定任务所属本人', async () => {
  let release, signal;
  const f = await fixture(request => { signal = request.signal; return new Promise(resolve => { release = () => resolve({ generation: 1,
    data: { ...processingPayload(), scope: 'owner', contact_id: null } }); }); });
  try {
    const reading = f.bridge.readProcessing({ scope: 'owner' });
    await new Promise(resolve => setImmediate(resolve));
    f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
    assert.equal(signal.aborted, false);
    release(); assert.equal((await reading).scope, 'owner');
  } finally { f.disconnect(); }
});
