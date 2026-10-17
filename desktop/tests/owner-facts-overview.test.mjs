import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installMemoryBridge } from './src/main/memory/bridge';
  export { createMemoryBridge } from './src/preload/memory';
  export { BackendRequestFailure } from './src/main/backend/json-client';
  export * from './src/renderer/MemoryPage';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const ports = compiledModule.exports;
const ids = { contact: '11111111-1111-4111-8111-111111111111', other: '99999999-9999-4999-8999-999999999999',
  previous: '22222222-2222-4222-8222-222222222222', current: '33333333-3333-4333-8333-333333333333',
  manual: '44444444-4444-4444-8444-444444444444', message: '55555555-5555-4555-8555-555555555555',
  source: '66666666-6666-4666-8666-666666666666' };
function memory(overrides = {}) {
  return { memory_id: ids.current, level: 'owner', text: '本人明确偏好合成无糖饮品。',
    category: 'preference', topic: 'other', source_ids: [ids.source], confidence: 1, risk_flags: [],
    status: 'active', adoption_method: 'manual', revision: 1, supersedes_memory_id: null,
    source_candidate_id: null, valid_at: null, invalid_at: null, event: null,
    timing: { recorded_at: '2026-10-14T03:00:00Z', source_started_at: null, source_ended_at: null,
      source_time_complete: false, current_status: 'stable', current_status_reason: '用户明确保存的偏好。' }, ...overrides };
}
function entry(value = memory(), overrides = {}) {
  return { memory: value, is_latest: value.status === 'active',
    current_leaf: { memory_id: ids.current, revision: 1 }, provenance: { kind: 'manual_entry', references: [{
      source_id: ids.source, source_kind: 'manual', message_id: null, source_ref_id: null, locator: null, contact_id: null }] }, ...overrides };
}
function overview(entries = [], overrides = {}) {
  return { overview: { version: 1, scope_kind: 'owner', contact_id: null, projection_revision: 'a'.repeat(64),
    memory_revision: 2, built_at: '2026-10-14T04:00:00Z', entries, ...overrides } };
}
async function fixture(requestJson) {
  let generation = 1, directory = [ids.contact, ids.other];
  const backendListeners = new Set();
  const backend = { getConnectionGeneration: () => generation, requestJson,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); } };
  const contacts = new ports.ContactSession(async () => ({ generation,
    contacts: directory.map((contactId) => ({ contactId, displayName: '合成本人概览联系人', messageCount: 1, sourceCount: 1 })) }));
  contacts.setConnection(generation); await contacts.refreshContacts();
  contacts.selectContact({ contactId: ids.contact, scopeRevision: contacts.getState().scopeRevision });
  const handlers = new Map(), listeners = new Map();
  const controller = ports.installMemoryBridge({ handle: (name, handler, role) => handlers.set(name, { handler, role }),
    publish: (name, state) => { for (const listener of listeners.get(name) ?? []) listener(null, state); } }, backend, contacts);
  const bridge = ports.createMemoryBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name).handler(...args)),
    on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeListener: (name, listener) => listeners.get(name)?.delete(listener) });
  return { controller, backend, contacts, bridge, handlers,
    selection: () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision }),
    disconnect: () => { generation = undefined; contacts.setConnection(undefined); for (const listener of backendListeners) listener({}); },
    reconnect: async () => { generation = 2; contacts.setConnection(2); await contacts.refreshContacts(); },
    removeContact: async () => { directory = [ids.other]; await contacts.refreshContacts(); } };
}
const render = (state, contactId = ids.contact) => ports.renderToStaticMarkup(ports.createElement(ports.OwnerFactsOverview, {
  overview: state.ownerOverview, memories: state.owner, contactId, refresh: async () => {}, openVersions: async () => {},
  busy: state.mutation.phase === 'working', trace: () => {},
}));

test('本人独立概览沿生产桥查看真实手录偏好、来源与版本，不改变联系人四区', async () => {
  const f = await fixture(async (request) => ({ generation: 1,
    data: request.path === '/api/memories/owner/overview' ? overview([entry()]) : { memories: [memory()] } }));
  await f.bridge.refresh({ ...f.selection(), section: 'owner' });
  await f.bridge.refreshOwnerOverview(f.selection());
  const state = await f.bridge.getState();
  assert.equal(state.ownerOverview.phase, 'ready');
  assert.equal(state.ownerOverview.value.scopeKind, 'owner');
  assert.equal(state.ownerOverview.value.contactId, null);
  assert.equal(state.ownerOverview.value.entries[0].memory.level, 'owner');
  const html = render(state);
  assert.match(html, /本人事实与偏好概览/);
  assert.match(html, /本人明确偏好合成无糖饮品/);
  assert.match(html, /用户手动录入/);
  assert.match(html, /底层资料版本：1/);
  assert.match(html, /通过下方本人记忆修正或删除/);
  assert.ok(html.includes(ids.source));
  assert.deepEqual(state.overview, { phase: 'idle', value: null });
  assert.deepEqual(state.contact, { phase: 'idle', items: [] });
  assert.equal(f.handlers.get('memory:refresh-owner-overview').role, 'manager');
});

test('本人修正开始撤旧概览，成功和未知响应都权威复读本人列表与概览并保留操作错误', async () => {
  for (const outcome of ['success', 'committed-unknown', 'not-committed-unknown']) {
    let committed = false, finishWrite, announceWrite;
    const started = new Promise((resolve) => { announceWrite = resolve; });
    const corrected = memory({ memory_id: ids.manual, text: '本人明确改为合成低糖饮品。', revision: 2,
      supersedes_memory_id: ids.current });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') {
        announceWrite();
        return new Promise((resolve, reject) => { finishWrite = () => {
          committed = outcome !== 'not-committed-unknown';
          if (outcome === 'success') resolve({ generation: 1, data: {} });
          else reject(new ports.BackendRequestFailure('connection'));
        }; });
      }
      const item = committed ? corrected : memory();
      return { generation: 1, data: request.path === '/api/memories/owner/overview'
        ? overview([entry(item, { current_leaf: { memory_id: item.memory_id, revision: item.revision } })])
        : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [item] } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'owner' }); await f.bridge.refreshOwnerOverview(f.selection());
    const writing = f.bridge.correct({ ...f.selection(), level: 'owner', memoryId: ids.current, revision: 1,
      text: corrected.text, category: corrected.category });
    await started;
    try {
      assert.equal((await f.bridge.getState()).ownerOverview.value, null);
      await assert.rejects(f.bridge.refreshOwnerOverview(f.selection()), /正在/);
    } finally { finishWrite(); await writing; }
    const state = await f.bridge.getState();
    assert.equal(state.mutation.phase, outcome === 'success' ? 'success' : 'error');
    assert.equal(state.ownerOverview.phase, 'ready');
    assert.equal(state.ownerOverview.value.entries[0].memory.text, committed ? corrected.text : memory().text);
    assert.equal(state.owner.items[0].text, committed ? corrected.text : memory().text);
  }
});

test('来源事件取消本人提交后GET时结束loading，专用重试为空且保留操作错误', async () => {
  for (const response of ['success', 'unknown-response']) {
    let committed = false, deleted = false, reads = 0, heldSignal, announceHeld, releaseHeld;
    const held = new Promise((resolve) => { announceHeld = resolve; });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') {
        committed = true;
        if (response === 'unknown-response') throw new ports.BackendRequestFailure('connection');
        return { generation: 1, data: {} };
      }
      if (request.path === '/api/memories/owner/overview') {
        if (++reads === 2) {
          heldSignal = request.signal; announceHeld();
          return new Promise((resolve, reject) => {
            releaseHeld = () => reject(new ports.BackendRequestFailure('cancelled'));
            request.signal.addEventListener('abort', releaseHeld, { once: true });
          });
        }
        return { generation: 1, data: overview(deleted ? [] : [entry()]) };
      }
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : request.path.endsWith('/sources') ? { sources: [] } : { memories: deleted ? [] : [memory()] } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'owner' }); await f.bridge.refreshOwnerOverview(f.selection());
    const writing = f.bridge.correct({ ...f.selection(), level: 'owner', memoryId: ids.current, revision: 1,
      text: '本人更正的合成偏好。', category: 'preference' });
    await held;
    try {
      assert.equal(committed, true);
      deleted = true;
      await f.controller.revalidateDeletedSource(ids.other);
      assert.equal(heldSignal.aborted, true);
    } finally { releaseHeld(); await writing; }
    const state = await f.bridge.getState();
    assert.equal(state.mutation.phase, 'error');
    assert.deepEqual(state.ownerOverview, { phase: 'error', value: null });
    assert.ok(!/<button[^>]*disabled=""[^>]*>刷新本人概览<\/button>/.test(render(state)));
    assert.ok(!render(state).includes('正在核对本人概览与来源'));
    await f.bridge.refreshOwnerOverview(f.selection());
    assert.equal((await f.bridge.getState()).mutation.phase, 'error');
    assert.deepEqual((await f.bridge.getState()).ownerOverview.value.entries, []);
  }
});

test('本人补充遭遇来源事件时维持未决写入门，迟到提交后权威复读且可专用刷新', async () => {
  let added = false, announceWrite, finishWrite;
  const started = new Promise((resolve) => { announceWrite = resolve; });
  const f = await fixture(async (request) => {
    if (request.method === 'POST') {
      announceWrite();
      return new Promise((resolve) => { finishWrite = () => { added = true; resolve({ generation: 1, data: {} }); }; });
    }
    return { generation: 1, data: request.path === '/api/memories/owner/overview' ? overview(added ? [entry()] : [])
      : request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : request.path.endsWith('/sources') ? { sources: [] } : { memories: added ? [memory()] : [] } };
  });
  await f.bridge.refresh(f.selection()); await f.bridge.refreshOwnerOverview(f.selection());
  const writing = f.bridge.add({ ...f.selection(), level: 'owner', text: memory().text, category: 'preference' });
  await started;
  try {
    await f.controller.revalidateDeletedSource(ids.other);
    assert.equal((await f.bridge.getState()).mutation.phase, 'working');
    await assert.rejects(f.bridge.refreshOwnerOverview(f.selection()), /正在/);
  } finally { finishWrite(); await writing; }
  const state = await f.bridge.getState();
  assert.equal(state.mutation.phase, 'success');
  assert.equal(state.owner.items[0].text, memory().text);
  assert.equal(state.ownerOverview.value.entries[0].memory.text, memory().text);
  assert.equal(state.pending.phase, 'ready');
});

test('本人版本读取确认404或409时撤下失效概览，权威空结果不恢复旧叶', async () => {
  for (const status of [404, 409]) {
    let changed = false;
    const f = await fixture(async (request) => {
      if (request.path.endsWith('/versions')) { changed = true; throw new ports.BackendRequestFailure('response', status); }
      return { generation: 1, data: request.path === '/api/memories/owner/overview' ? overview(changed ? [] : [entry()]) : { memories: [memory()] } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'owner' }); await f.bridge.refreshOwnerOverview(f.selection());
    await f.bridge.openVersions({ ...f.selection(), level: 'owner', memoryId: ids.current, revision: 1 });
    const state = await f.bridge.getState();
    assert.equal(state.history.phase, 'error');
    assert.deepEqual(state.owner.items, []);
    assert.equal(state.ownerOverview.phase, 'ready');
    assert.deepEqual(state.ownerOverview.value.entries, []);
    assert.ok(!render(state).includes(memory().text));
  }
});

test('本人删除与来源事件的两种提交顺序及重复通知都不复活正文，未知提交保留错误', async () => {
  for (const order of ['memory-first', 'source-first', 'source-first-unknown']) {
    let removed = false, deleted = false, finishWrite, announceWrite;
    const started = new Promise((resolve) => { announceWrite = resolve; });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') {
        announceWrite(); return new Promise((resolve, reject) => { finishWrite = () => {
          removed = true;
          if (order.endsWith('unknown')) reject(new ports.BackendRequestFailure('connection'));
          else resolve({ generation: 1, data: {} });
        }; });
      }
      const items = removed || deleted ? [] : [memory()];
      return { generation: 1, data: request.path === '/api/memories/owner/overview' ? overview(items.map((item) => entry(item)))
        : request.path.endsWith('/memory-candidates') ? { candidates: [] } : request.path.endsWith('/sources') ? { sources: [] }
          : request.path === '/api/memories/owner' ? { memories: items } : { memories: [] } };
    });
    await f.bridge.refresh(f.selection()); await f.bridge.refreshOwnerOverview(f.selection());
    const deleting = f.bridge.remove({ ...f.selection(), level: 'owner', memoryId: ids.current, revision: 1 });
    await started;
    try {
      assert.equal((await f.bridge.getState()).ownerOverview.value, null);
      if (order === 'memory-first') { finishWrite(); await deleting; }
      deleted = true;
      await f.controller.revalidateDeletedSource(ids.other);
      if (order !== 'memory-first') assert.equal((await f.bridge.getState()).mutation.phase, 'working');
    } finally { if (order !== 'memory-first') { finishWrite(); await deleting; } }
    const settled = await f.bridge.getState();
    assert.deepEqual(settled.ownerOverview.value.entries, []);
    assert.deepEqual(settled.owner.items, []);
    assert.equal(settled.mutation.phase, order.endsWith('unknown') ? 'error' : order === 'memory-first' ? 'idle' : 'success');
    await f.controller.revalidateDeletedSource(ids.other);
    await f.bridge.refreshOwnerOverview(f.selection());
    if (order.endsWith('unknown')) assert.equal((await f.bridge.getState()).mutation.phase, 'error');
    assert.deepEqual((await f.bridge.getState()).ownerOverview.value.entries, []);
    await assert.rejects(f.bridge.remove({ ...f.selection(), level: 'owner', memoryId: ids.current, revision: 1 }), /版本已失效/);
    assert.ok(!render(await f.bridge.getState()).includes(memory().text));
  }
});

test('本人概览失败可专用重试；更早的成功与失败都不能回填已删除条目', async () => {
  for (const outcome of ['success', 'failure']) {
    let mode = 'original', release;
    const f = await fixture(async () => {
      if (mode === 'failure') throw new ports.BackendRequestFailure('connection');
      if (mode === 'late') return new Promise((resolve, reject) => { release = () => outcome === 'failure'
        ? reject(new ports.BackendRequestFailure('connection')) : resolve({ generation: 1, data: overview([entry()]) }); });
      return { generation: 1, data: overview(mode === 'original' ? [entry()] : []) };
    });
    await f.bridge.refreshOwnerOverview(f.selection());
    mode = 'failure'; await f.bridge.refreshOwnerOverview(f.selection());
    assert.deepEqual((await f.bridge.getState()).ownerOverview, { phase: 'error', value: null });
    mode = 'late'; const late = f.bridge.refreshOwnerOverview(f.selection()); await new Promise(setImmediate);
    mode = 'deleted'; await f.bridge.refreshOwnerOverview(f.selection()); release(); await late;
    assert.deepEqual((await f.bridge.getState()).ownerOverview.value.entries, []);
  }
});

test('联系人切换、断连恢复及目录移除清本人缓存与迟到结果，须重新确认管理范围', async () => {
  for (const change of ['switch', 'disconnect', 'directory-removal']) {
    let lateMode = false, release, signal;
    const f = await fixture(async (request) => {
      if (lateMode) { lateMode = false; signal = request.signal;
        return new Promise((resolve) => { release = () => resolve({ generation: 1, data: overview([entry()]) }); }); }
      return { generation: f.backend.getConnectionGeneration(), data: overview([]) };
    });
    const oldSelection = f.selection();
    lateMode = true; const late = f.bridge.refreshOwnerOverview(oldSelection); await new Promise(setImmediate);
    if (change === 'switch') f.contacts.selectContact({ contactId: ids.other, scopeRevision: oldSelection.scopeRevision });
    else if (change === 'disconnect') f.disconnect();
    else await f.removeContact();
    assert.deepEqual((await f.bridge.getState()).ownerOverview, { phase: 'idle', value: null });
    release(); await late;
    assert.equal(signal.aborted, true);
    await assert.rejects(f.bridge.refreshOwnerOverview(oldSelection), /范围已失效/);
    if (change === 'disconnect') { await f.reconnect(); assert.equal(f.contacts.getState().selectedContactId, null); }
    if (f.selection().contactId !== ids.other) f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
    await f.bridge.refreshOwnerOverview(f.selection());
    assert.deepEqual((await f.bridge.getState()).ownerOverview.value.entries, []);
    assert.ok(!render(await f.bridge.getState(), ids.other).includes(memory().text));
  }
});

test('本人来源只显示真实标识，原关系全部吻合才开放过程；未知状态与历史原样显示', async () => {
  for (const sourceContacts of [[ids.contact], [ids.other], [ids.contact, ids.other]]) {
    const item = memory({ source_ids: [ids.message], revision: 2,
      timing: { ...memory().timing, current_status: 'current_unverified', current_status_reason: '当前情况尚未知。' } });
    const f = await fixture(async () => ({ generation: 1, data: overview([entry(item, {
      current_leaf: { memory_id: ids.current, revision: 2 }, provenance: { kind: 'source_supported', references: sourceContacts.map((contact) => ({
        source_id: ids.source, source_kind: 'source_document', message_id: ids.message, source_ref_id: null, locator: null, contact_id: contact })) },
    })]) }));
    await f.bridge.refreshOwnerOverview(f.selection());
    const html = render(await f.bridge.getState());
    assert.match(html, /当前未核实/);
    assert.match(html, /当前情况尚未知/);
    assert.equal(html.includes('查看本人概览提取过程：'), sourceContacts.every((contact) => contact === ids.contact));
    assert.match(html, /请先明确选择该联系人/);
    assert.ok(!html.includes('合成本人概览联系人'));
  }
});

test('历史本人条目只导航已核对当前叶，缺叶或列表修订不同保留回看', async () => {
  for (const leaf of [null, { memory_id: ids.current, revision: 2 }, { memory_id: ids.current, revision: 1 }]) {
    const past = memory({ memory_id: ids.previous, status: 'invalidated', text: '本人过去的合成偏好。' });
    const f = await fixture(async (request) => ({ generation: 1, data: request.path === '/api/memories/owner/overview'
      ? overview([entry(past, { current_leaf: leaf })]) : { memories: [memory()] } }));
    await f.bridge.refresh({ ...f.selection(), section: 'owner' }); await f.bridge.refreshOwnerOverview(f.selection());
    const html = render(await f.bridge.getState());
    assert.match(html, /历史版本/);
    assert.equal(html.includes('查看本人变化依据：'), leaf?.revision === 1);
    assert.ok(!html.includes('修正资料：本人过去'));
  }
});

test('本人概览拒绝contact条目、范围混合、越界分类及不可信来源，错误后撤下旧内容', async () => {
  const wrong = [overview([entry()], { scope_kind: 'contact', contact_id: ids.contact }),
    overview([entry()], { contact_id: ids.contact }), overview([entry(memory({ level: 'contact', contact_id: ids.contact }))]),
    overview([entry(memory({ contact_id: ids.contact }))]),
    ...['recent_state', 'relationship_note'].map((category) => overview([entry(memory({ category }))])),
    overview([entry(memory(), { current_leaf: { memory_id: ids.current, revision: 9 } })]),
    overview([entry(memory(), { provenance: { kind: 'manual_entry', references: [{ ...entry().provenance.references[0], contact_id: ids.other }] } })]),
    overview([entry(memory(), { provenance: { kind: 'source_supported', references: [{ source_id: ids.source,
      source_kind: 'source_document', message_id: ids.message, source_ref_id: null, contact_id: null, locator: null }] } })]),
    overview([entry(memory(), { provenance: { kind: 'manual_entry', references: [{ ...entry().provenance.references[0], locator: '另一关系私人定位' }] } })])];
  for (const value of wrong) {
    let response = overview([entry()]);
    const f = await fixture(async () => ({ generation: 1, data: response }));
    await f.bridge.refreshOwnerOverview(f.selection()); response = value;
    await f.bridge.refreshOwnerOverview(f.selection());
    assert.deepEqual((await f.bridge.getState()).ownerOverview, { phase: 'error', value: null });
    assert.ok(!render(await f.bridge.getState()).includes(memory().text));
  }
});

test('本人概览仅manager公开能力，拒绝额外字段、目录未确认和旧scope，刷新不写资料', async () => {
  const requests = [];
  const f = await fixture(async (request) => { requests.push(request); return { generation: 1, data: overview([]) }; });
  await assert.rejects(f.bridge.refreshOwnerOverview({ ...f.selection(), section: 'owner' }), /不可用/);
  await assert.rejects(f.bridge.refreshOwnerOverview({ ...f.selection(), ownerId: ids.other }), /不可用/);
  await assert.rejects(f.bridge.refreshOwnerOverview({ ...f.selection(), scopeRevision: -1 }), /不可用/);
  await f.bridge.refreshOwnerOverview(f.selection());
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [['GET', '/api/memories/owner/overview']]);
  assert.equal(f.handlers.get('memory:refresh-owner-overview').role, 'manager');
});
