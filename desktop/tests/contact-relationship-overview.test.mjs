import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
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
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const ports = compiledModule.exports;
const ids = { contact: '11111111-1111-4111-8111-111111111111', other: '99999999-9999-4999-8999-999999999999',
  previous: '22222222-2222-4222-8222-222222222222', current: '33333333-3333-4333-8333-333333333333',
  manual: '44444444-4444-4444-8444-444444444444', message: '55555555-5555-4555-8555-555555555555',
  source: '66666666-6666-4666-8666-666666666666', manualSource: '77777777-7777-4777-8777-777777777777' };
function memory(overrides = {}) {
  return { memory_id: ids.current, level: 'contact', contact_id: ids.contact, text: '曾约定参加合成读书会。',
    category: 'relationship_note', topic: 'other', source_ids: [ids.message], confidence: 0.9, risk_flags: [],
    status: 'active', adoption_method: 'manual', revision: 2, supersedes_memory_id: ids.previous,
    source_candidate_id: null, valid_at: null, invalid_at: null, event: null,
    timing: { recorded_at: '2026-10-14T11:00:00+08:00', source_started_at: '2026-08-01T10:00:00+08:00',
      source_ended_at: '2026-08-01T10:00:00+08:00', source_time_complete: true,
      current_status: 'current_unverified', current_status_reason: '当时的安排，当前状态未核实。' }, ...overrides };
}
function overview(entries = [], overrides = {}) {
  return { overview: { version: 1, scope_kind: 'contact', contact_id: ids.contact,
    projection_revision: 'a'.repeat(64), memory_revision: 3, built_at: '2026-10-14T12:00:00+08:00', entries, ...overrides } };
}
function sourceEntry(value = memory(), overrides = {}) {
  return { memory: value, is_latest: value.status === 'active', current_leaf: { memory_id: ids.current, revision: 2 },
    provenance: { kind: 'source_supported', references: [{ source_id: ids.source, source_kind: 'source_document',
      message_id: ids.message, source_ref_id: null, locator: '合成记录第1条' }] }, ...overrides };
}
async function fixture(requestJson) {
  let generation = 1;
  let directory = [ids.contact, ids.other];
  const backendListeners = new Set();
  const backend = { getConnectionGeneration: () => generation, requestJson,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); } };
  const contacts = new ports.ContactSession(async () => ({ generation,
    contacts: directory.map((contactId) => ({ contactId, displayName: '合成概览联系人', messageCount: 1, sourceCount: 1 })) }));
  contacts.setConnection(generation); await contacts.refreshContacts();
  contacts.selectContact({ contactId: ids.contact, scopeRevision: contacts.getState().scopeRevision });
  const handlers = new Map(), listeners = new Map();
  const controller = ports.installMemoryBridge({
    handle: (name, handler, role) => handlers.set(name, { handler, role }),
    publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(null, state); },
  }, backend, contacts);
  const bridge = ports.createMemoryBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name).handler(...args)),
    on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeListener: (name, listener) => listeners.get(name)?.delete(listener) });
  const selection = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  return { controller, backend, contacts, bridge, handlers, selection,
    disconnect: () => { generation = undefined; contacts.setConnection(undefined); for (const listener of backendListeners) listener({}); },
    reconnect: async () => { generation = 2; contacts.setConnection(2); await contacts.refreshContacts(); },
    removeContact: async () => { directory = [ids.other]; await contacts.refreshContacts(); } };
}

test('用户查看一位联系人的经历变化，历史与当前未知、真实手录来源和修订可追溯', async () => {
  const past = memory({ memory_id: ids.previous, text: '过去计划参加合成读书会。', revision: 1,
    status: 'invalidated', supersedes_memory_id: null });
  const current = memory();
  const manual = memory({ memory_id: ids.manual, text: '用户手录的合成共同经历。', revision: 1,
    source_ids: [ids.manualSource], supersedes_memory_id: null,
    timing: { recorded_at: '2026-10-14T11:00:00+08:00', source_started_at: null, source_ended_at: null,
      source_time_complete: false, current_status: 'stable', current_status_reason: '用户明确保存的稳定资料。' } });
  const actual = overview([sourceEntry(past), sourceEntry(current), sourceEntry(manual, {
    current_leaf: { memory_id: ids.manual, revision: 1 },
    provenance: { kind: 'manual_entry', references: [{ source_id: ids.manualSource, source_kind: 'manual',
      message_id: null, source_ref_id: null, locator: null }] },
  })]);
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.endsWith('/relationship-overview')
    ? actual : { memories: [current, manual] } }));
  await f.bridge.refresh({ ...f.selection(), section: 'contact' });
  await f.bridge.refreshOverview(f.selection());
  const state = await f.bridge.getState();
  const html = ports.renderToStaticMarkup(ports.createElement(ports.ContactRelationshipOverview, {
    overview: state.overview, memories: state.contact, refresh: async () => {}, openVersions: async () => {},
  }));
  assert.match(html, /联系人经历与关系变化/);
  assert.match(html, /过去计划参加合成读书会/);
  assert.match(html, /历史版本/);
  assert.match(html, /当前未核实/);
  assert.match(html, /当时的安排，当前状态未核实/);
  assert.match(html, /用户手动录入/);
  assert.match(html, /2026年8月1日/);
  assert.match(html, /底层资料版本：2/);
  assert.ok(html.includes(ids.source));
  assert.ok(html.includes(ids.manualSource));
  assert.match(html, /已采纳资料的投影/);
  assert.match(html, /不包含未确认推断/);
  assert.doesNotMatch(html, /刷新联系人概览|>重试<\/button>/);
  assert.equal(state.overview.value.entries[0].currentLeaf.memoryId, ids.current);
  assert.equal(f.handlers.get('memory:refresh-overview').role, 'manager');
});

test('后台记忆处理进度变化后自动更新概览，加载失败仅显示重试并可恢复', async () => {
  let current = memory(), failed = false;
  const f = await fixture(async (request) => {
    if (request.path.endsWith('/relationship-overview')) {
      if (failed) throw new Error('合成概览读取失败');
      return { generation: 1, data: overview([sourceEntry(current)]) };
    }
    return { generation: 1, data: { memories: [current] } };
  });
  const render = () => {
    const state = f.controller.getState();
    return ports.renderToStaticMarkup(ports.createElement(ports.ContactRelationshipOverview, {
      overview: state.overview, memories: state.contact, refresh: async () => {}, openVersions: async () => {},
    }));
  };
  await f.bridge.refresh({ ...f.selection(), section: 'contact' });
  await f.bridge.refreshOverview(f.selection());
  current = memory({ text: '后台整理后新增的合成经历。' });
  await f.bridge.refreshProcessingResults({ scope: 'contact', ...f.selection() });
  assert.match(render(), /后台整理后新增的合成经历/);
  assert.doesNotMatch(render(), /刷新联系人概览|>重试<\/button>/);

  failed = true;
  await assert.rejects(f.bridge.refreshProcessingResults({ scope: 'contact', ...f.selection() }));
  assert.match(render(), /概览加载失败/);
  assert.match(render(), /<button class="button">重试<\/button>/);
  assert.doesNotMatch(render(), /后台整理后新增的合成经历/);
  failed = false;
  await f.bridge.refreshOverview(f.selection());
  assert.match(render(), /后台整理后新增的合成经历/);
  assert.doesNotMatch(render(), />重试<\/button>/);
});

test('用户修正底层资料时撤下旧概览，核对完成后呈现新的人工版本', async () => {
  const original = memory();
  const corrected = memory({ memory_id: ids.manual, revision: 3, text: '人工修正：当时未确定参加。',
    supersedes_memory_id: ids.current });
  let committed = false, finishWrite, announceWrite;
  const started = new Promise((resolve) => { announceWrite = resolve; });
  const f = await fixture(async (request) => {
    if (request.method === 'POST') {
      announceWrite();
      return new Promise((resolve) => { finishWrite = () => { committed = true; resolve({ generation: 1, data: {} }); }; });
    }
    return { generation: 1, data: request.path.endsWith('/relationship-overview')
      ? overview([sourceEntry(committed ? corrected : original, {
        current_leaf: { memory_id: committed ? ids.manual : ids.current, revision: committed ? 3 : 2 },
      })], { projection_revision: (committed ? 'b' : 'a').repeat(64), memory_revision: committed ? 4 : 3 })
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [committed ? corrected : original] } };
  });
  await f.bridge.refresh({ ...f.selection(), section: 'contact' });
  await f.bridge.refreshOverview(f.selection());
  const writing = f.bridge.correct({ ...f.selection(), level: 'contact', memoryId: ids.current, revision: 2,
    text: corrected.text, category: corrected.category });
  await started;
  try {
    assert.equal((await f.bridge.getState()).overview.value, null);
    await assert.rejects(f.bridge.refreshOverview(f.selection()), /正在/);
  } finally { finishWrite(); await writing; }
  const state = await f.bridge.getState();
  assert.equal(state.mutation.phase, 'success');
  assert.equal(state.overview.value.entries[0].memory.text, corrected.text);
  assert.equal(state.overview.value.entries[0].memory.adoptionMethod, 'manual');
  assert.equal(state.overview.value.entries[0].currentLeaf.revision, 3);
  assert.equal(state.overview.value.memoryRevision, 4);
  assert.equal(state.overview.value.projectionRevision, 'b'.repeat(64));
});

test('参与概览的本人资料被修正或删除时撤缓存，来源事件仍等待人工写入复验', async () => {
  for (const action of ['correct', 'remove']) for (const outcome of ['success', 'unknown-response']) {
    const owner = memory({ level: 'owner', contact_id: null, memory_id: ids.manual, revision: 1 });
    let committed = false, finishWrite, announceWrite, overviewReads = 0;
    const started = new Promise((resolve) => { announceWrite = resolve; });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') {
        announceWrite();
        return new Promise((resolve, reject) => { finishWrite = () => {
          committed = true;
          if (outcome === 'unknown-response') reject(new ports.BackendRequestFailure('connection'));
          else resolve({ generation: 1, data: {} });
        }; });
      }
      if (request.path.endsWith('/relationship-overview')) {
        overviewReads++;
        return { generation: 1, data: overview([sourceEntry()], { projection_revision: (committed ? 'b' : 'a').repeat(64) }) };
      }
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : request.path.endsWith('/sources') ? { sources: [] }
          : { memories: request.path.endsWith('/owner-memories') ? (committed && action === 'remove' ? [] : [owner]) : [memory()] } };
    });
    await f.bridge.refresh(f.selection()); await f.bridge.refreshOverview(f.selection());
    const request = { ...f.selection(), level: 'owner', memoryId: owner.memory_id, revision: 1 };
    const writing = action === 'correct' ? f.bridge.correct({ ...request,
      text: '本人的新人工决定。', category: owner.category }) : f.bridge.remove(request);
    await started;
    try {
      assert.equal(f.controller.getState().overview.value, null);
      await f.controller.revalidateDeletedSource(ids.other);
      assert.equal(f.controller.getState().overview.value, null);
      assert.equal(overviewReads, 1, '来源事件不能读取人工写入仍未复验的旧概览。');
    } finally { finishWrite(); await writing; }
    const state = await f.bridge.getState();
    assert.equal(state.mutation.phase, outcome === 'success' ? 'success' : 'error');
    assert.equal(state.overview.value.projectionRevision, 'b'.repeat(64));
    assert.deepEqual(state.overview.value.entries.map((entry) => entry.memory.memoryId), [ids.current]);
  }
});

test('底层历史确认已失效时撤下并重建概览，普通连接异常保留尚无删除证据的资料', async () => {
  for (const failure of [404, 409, 'connection']) {
    let unavailable = false;
    const f = await fixture(async (request) => {
      if (request.path.endsWith('/versions')) {
        unavailable = failure !== 'connection';
        throw new ports.BackendRequestFailure(failure === 'connection' ? 'connection' : 'response',
          typeof failure === 'number' ? failure : undefined);
      }
      return { generation: 1, data: request.path.endsWith('/relationship-overview')
        ? overview(unavailable ? [] : [sourceEntry()]) : { memories: [memory()] } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'contact' }); await f.bridge.refreshOverview(f.selection());
    await f.bridge.openVersions({ ...f.selection(), level: 'contact', memoryId: ids.current, revision: 2 });
    const state = await f.bridge.getState();
    assert.equal(state.history.phase, 'error');
    assert.equal(state.overview.phase, 'ready');
    assert.equal(state.overview.value.entries.length, failure === 'connection' ? 1 : 0);
  }
});

test('来源删除清除已呈现或未完成的概览，旧响应不能复活正文', async () => {
  for (const timing of ['already-visible', 'still-reading']) {
    let deleted = false, reads = 0, releaseLate, lateSignal;
    const f = await fixture(async (request) => {
      if (request.path.endsWith('/relationship-overview')) {
        reads++;
        if (timing === 'still-reading' && reads === 2) {
          lateSignal = request.signal;
          return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1,
            data: overview([sourceEntry()]) }); });
        }
        return { generation: 1, data: overview(deleted ? [] : [sourceEntry()], {
          projection_revision: (deleted ? 'c' : 'a').repeat(64), memory_revision: deleted ? 4 : 3,
        }) };
      }
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : request.path.endsWith('/sources') ? { sources: [] } : { memories: deleted ? [] : [memory()] } };
    });
    await f.bridge.refreshOverview(f.selection());
    const late = timing === 'still-reading' ? f.bridge.refreshOverview(f.selection()) : undefined;
    if (late) await new Promise(setImmediate);
    deleted = true;
    const checking = f.controller.revalidateDeletedSource(ids.contact);
    assert.equal(f.controller.getState().overview.value, null);
    try { await checking; }
    finally { if (releaseLate) { releaseLate(); await late; } }
    const state = await f.bridge.getState();
    assert.equal(state.overview.phase, 'ready');
    assert.deepEqual(state.overview.value.entries, []);
    if (lateSignal) assert.equal(lateSignal.aborted, true);
    const html = ports.renderToStaticMarkup(ports.createElement(ports.ContactRelationshipOverview, {
      overview: state.overview, memories: state.contact, refresh: async () => {}, openVersions: async () => {},
    }));
    assert.ok(!html.includes(memory().text));
    await f.controller.revalidateDeletedSource(ids.contact);
    assert.deepEqual((await f.bridge.getState()).overview.value.entries, []);
  }
});

test('修正响应未知时重新读取权威概览，保留操作待核对状态而不猜测提交结果', async () => {
  for (const outcome of ['committed', 'not-committed']) {
    let changed = false;
    const corrected = memory({ memory_id: ids.manual, revision: 3, text: '响应未知后的实际人工资料。' });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') { changed = outcome === 'committed'; throw new Error('合成传输响应未知'); }
      const item = changed ? corrected : memory();
      return { generation: 1, data: request.path.endsWith('/relationship-overview')
        ? overview([sourceEntry(item, { current_leaf: { memory_id: item.memory_id, revision: item.revision } })])
        : { memories: [item] } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'contact' });
    await f.bridge.refreshOverview(f.selection());
    await f.bridge.correct({ ...f.selection(), level: 'contact', memoryId: ids.current, revision: 2,
      text: corrected.text, category: corrected.category });
    const state = await f.bridge.getState();
    assert.equal(state.mutation.phase, 'error');
    assert.equal(state.overview.phase, 'ready');
    assert.equal(state.overview.value.entries[0].memory.text, changed ? corrected.text : memory().text);
  }
});

test('资料删除与来源事件交错时保持提交复验门，成功或响应未知都不能回填旧概览', async () => {
  for (const order of ['record-first', 'source-first', 'source-first-unknown']) {
    let removed = false, sourceDeleted = false, announceWrite, finishWrite;
    const started = new Promise((resolve) => { announceWrite = resolve; });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') {
        announceWrite();
        return new Promise((resolve, reject) => { finishWrite = () => {
          removed = true;
          if (order === 'source-first-unknown') reject(new Error('合成删除响应未知'));
          else resolve({ generation: 1, data: {} });
        }; });
      }
      const items = removed || sourceDeleted ? [] : [memory()];
      return { generation: 1, data: request.path.endsWith('/relationship-overview')
        ? overview(items.map((item) => sourceEntry(item)))
        : request.path.endsWith('/memory-candidates') ? { candidates: [] }
          : request.path.endsWith('/sources') ? { sources: [] }
            : request.path.endsWith('/owner-memories') ? { memories: [] } : { memories: items } };
    });
    await f.bridge.refresh({ ...f.selection(), section: 'contact' });
    await f.bridge.refreshOverview(f.selection());
    const deleting = f.bridge.remove({ ...f.selection(), level: 'contact', memoryId: ids.current, revision: 2 });
    await started;
    try {
      if (order === 'record-first') { finishWrite(); await deleting; }
      sourceDeleted = true;
      await f.controller.revalidateDeletedSource(ids.contact);
      if (order !== 'record-first') {
        assert.equal(f.controller.getState().overview.value, null);
        assert.equal(f.controller.getState().mutation.phase, 'working');
        await assert.rejects(f.bridge.refreshOverview(f.selection()), /正在/);
      }
    } finally { if (order !== 'record-first') { finishWrite(); await deleting; } }
    const state = await f.bridge.getState();
    assert.deepEqual(state.overview.value.entries, []);
    assert.deepEqual(state.contact.items, []);
    assert.equal(state.mutation.phase, order === 'source-first-unknown' ? 'error' : order === 'record-first' ? 'idle' : 'success');
  }
});

test('提交后的概览核对被来源事件取消时结束等待，专用刷新能恢复且不回填旧来源', async () => {
  for (const level of ['contact', 'owner']) for (const response of ['success', 'unknown-response']) {
    const owner = memory({ level: 'owner', contact_id: null, memory_id: ids.manual, revision: 1 });
    const corrected = memory({ memory_id: ids.manual, revision: 3, text: '提交后核对的合成资料。' });
    let committed = false, sourceChanged = false, overviewReads = 0, heldSignal, announceHeld;
    const held = new Promise((resolve) => { announceHeld = resolve; });
    const f = await fixture(async (request) => {
      if (request.method === 'POST') {
        committed = true;
        if (response === 'unknown-response') throw new ports.BackendRequestFailure('connection');
        return { generation: 1, data: {} };
      }
      if (request.path.endsWith('/relationship-overview')) {
        overviewReads++;
        if (overviewReads === 2) {
          heldSignal = request.signal;
          announceHeld();
          return new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new ports.BackendRequestFailure('cancelled')), { once: true });
          });
        }
        return { generation: 1, data: overview(sourceChanged ? [] : [sourceEntry()]) };
      }
      return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] }
        : request.path.endsWith('/sources') ? { sources: [] }
          : { memories: sourceChanged ? [] : request.path.endsWith('/owner-memories') ? [owner] : [committed ? corrected : memory()] } };
    });
    await f.bridge.refresh(f.selection()); await f.bridge.refreshOverview(f.selection());
    const previous = level === 'owner' ? owner : memory();
    const writing = f.bridge.correct({ ...f.selection(), level, memoryId: previous.memory_id,
      revision: previous.revision, text: corrected.text, category: corrected.category });
    await held;
    assert.equal(committed, true);
    assert.equal(f.controller.getState().mutation.phase, 'working');
    sourceChanged = true;
    // 来源事件此后没有终态回调，界面仍须可以由用户显式重试。
    await f.controller.revalidateDeletedSource(ids.contact); await writing;
    const settled = await f.bridge.getState();
    assert.equal(heldSignal.aborted, true);
    assert.equal(settled.mutation.phase, 'error');
    assert.deepEqual(settled.overview, { phase: 'error', value: null });
    const html = ports.renderToStaticMarkup(ports.createElement(ports.ContactRelationshipOverview, {
      overview: settled.overview, memories: settled.contact, refresh: async () => {}, openVersions: async () => {},
      busy: settled.mutation.phase === 'working',
    }));
    assert.match(html, /<button class="button">重试<\/button>/);
    assert.doesNotMatch(html, /刷新联系人概览/);
    assert.match(html, /概览加载失败/);
    assert.ok(!html.includes('正在核对概览与来源'));
    assert.ok(!html.includes(memory().text));
    assert.ok(!html.includes(corrected.text));
    await f.bridge.refreshOverview(f.selection());
    const recovered = await f.bridge.getState();
    assert.equal(recovered.mutation.phase, 'error');
    assert.equal(recovered.overview.phase, 'ready');
    assert.deepEqual(recovered.overview.value.entries, []);
  }
});

test('概览读取失败撤下旧内容，显式重试之后忽略更早的成功或失败', async () => {
  for (const oldResult of ['success', 'failure']) {
    let mode = 'original', releaseLate;
    const f = await fixture(async (request) => {
      if (mode === 'unavailable') throw new Error('合成连接读取失败');
      if (mode === 'late') return new Promise((resolve, reject) => { releaseLate = () => {
        if (oldResult === 'failure') reject(new Error('合成迟到失败'));
        else resolve({ generation: 1, data: overview([sourceEntry()]) });
      }; });
      return { generation: 1, data: overview(mode === 'original' ? [sourceEntry()] : []) };
    });
    await f.bridge.refreshOverview(f.selection());
    mode = 'unavailable';
    await f.bridge.refreshOverview(f.selection());
    assert.deepEqual((await f.bridge.getState()).overview, { phase: 'error', value: null });
    mode = 'late';
    const late = f.bridge.refreshOverview(f.selection());
    await new Promise(setImmediate);
    mode = 'deleted';
    try { await f.bridge.refreshOverview(f.selection()); }
    finally { releaseLate(); await late; }
    assert.deepEqual((await f.bridge.getState()).overview.value.entries, []);
  }
});

test('切换联系人、断连恢复或目录移除都清概览与未决响应，旧范围不被恢复', async () => {
  for (const change of ['switch', 'disconnect', 'directory-removal']) {
    let lateMode = false, releaseLate, lateSignal;
    const f = await fixture(async (request) => {
      if (lateMode) {
        lateMode = false;
        lateSignal = request.signal;
        return new Promise((resolve) => { releaseLate = () => resolve({ generation: 1, data: overview([sourceEntry()]) }); });
      }
      const nextContact = request.path.includes(ids.other) ? ids.other : ids.contact;
      return { generation: f.backend.getConnectionGeneration(), data: overview(nextContact === ids.contact ? [sourceEntry()] : [],
        { contact_id: nextContact }) };
    });
    await f.bridge.refreshOverview(f.selection());
    const oldSelection = f.selection();
    lateMode = true;
    const late = f.bridge.refreshOverview(oldSelection);
    await new Promise(setImmediate);
    if (change === 'switch') f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
    else if (change === 'disconnect') f.disconnect();
    else await f.removeContact();
    assert.deepEqual(f.controller.getState().overview, { phase: 'idle', value: null });
    releaseLate(); await late;
    assert.equal(lateSignal.aborted, true);
    await assert.rejects(f.bridge.refreshOverview(oldSelection), /范围已失效/);
    if (change === 'disconnect') {
      await f.reconnect();
      assert.equal(f.contacts.getState().selectedContactId, null);
      assert.deepEqual(f.controller.getState().overview, { phase: 'idle', value: null });
    }
    if (f.selection().contactId !== ids.other) f.contacts.selectContact({ contactId: ids.other, scopeRevision: f.selection().scopeRevision });
    await f.bridge.refreshOverview(f.selection());
    const state = await f.bridge.getState();
    assert.equal(state.overview.value.contactId, ids.other);
    assert.deepEqual(state.overview.value.entries, []);
  }
});

test('历史条目只导航到已核对的当前叶；缺叶或当前列表修订不同不使用旧ID操作', async () => {
  for (const leaf of [null, { memory_id: ids.current, revision: 3 }, { memory_id: ids.current, revision: 2 }]) {
    const past = memory({ memory_id: ids.previous, status: 'invalidated', revision: 1, supersedes_memory_id: null });
    const f = await fixture(async (request) => ({ generation: 1,
      data: request.path.endsWith('/relationship-overview') ? overview([sourceEntry(past, { current_leaf: leaf })]) : { memories: [memory()] } }));
    await f.bridge.refresh({ ...f.selection(), section: 'contact' });
    await f.bridge.refreshOverview(f.selection());
    const state = await f.bridge.getState();
    const html = ports.renderToStaticMarkup(ports.createElement(ports.ContactRelationshipOverview, {
      overview: state.overview, memories: state.contact, refresh: async () => {}, openVersions: async () => {},
    }));
    assert.equal(html.includes(`查看变化依据：${past.text}`), leaf?.revision === 2);
    assert.ok(!html.includes(`修正资料：${past.text}`));
    assert.match(html, /历史版本/);
  }
});

test('概览的联系人、原始来历或叶修订不可核对时拒绝响应并撤下旧内容', async () => {
  const wrong = [overview([sourceEntry()], { contact_id: ids.other }),
    overview([sourceEntry(memory({ contact_id: ids.other }))]),
    overview([sourceEntry(memory(), { provenance: { kind: 'manual_entry', references: sourceEntry().provenance.references } })]),
    overview([sourceEntry(memory(), { current_leaf: { memory_id: ids.current, revision: 99 } })]),
    overview([sourceEntry(memory(), { current_leaf: null })]),
    overview([sourceEntry(memory(), { provenance: { kind: 'source_supported', references: [] } })])];
  for (const unavailable of wrong) {
    let result = overview([sourceEntry()]);
    const f = await fixture(async () => ({ generation: 1, data: result }));
    await f.bridge.refreshOverview(f.selection());
    result = unavailable;
    await f.bridge.refreshOverview(f.selection());
    assert.deepEqual((await f.bridge.getState()).overview, { phase: 'error', value: null });
  }
});

test('联系人概览页面组经过现有两层有限启动校验，不放宽未知或重复范围', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  const parser = source.slice(source.indexOf('function parse(args)'), source.indexOf('async function run(options)'));
  assert.equal(JSON.stringify(runInNewContext(`${parser}; parse(args)`, {
    args: ['--case', 'contact-relationship-overview', '--timeout-seconds', '180'],
  })), JSON.stringify({ names: ['contact-relationship-overview'], timeout: 180 }));
  for (const args of [['--case', 'unknown-page', '--timeout-seconds', '180'],
    ['--case', 'contact-relationship-overview', '--case', 'contact-relationship-overview', '--timeout-seconds', '180']]) {
    assert.throws(() => runInNewContext(`${parser}; parse(args)`, { args }), /page_test_arguments/);
  }
  const runner = await readFile('tests/headless/run.ts', 'utf8');
  const guard = runner.slice(runner.indexOf('if (!Array.isArray(cases)'), runner.indexOf('let browser:'));
  assert.doesNotThrow(() => runInNewContext(guard, { cases: ['contact-relationship-overview'] }));
  assert.throws(() => runInNewContext(guard, { cases: ['unknown-page'] }), /page_test_arguments/);
  assert.match(runner, /import \{ contactRelationshipOverview \} from '\.\/contact-relationship-overview';/);
  assert.match(runner, /name === 'contact-relationship-overview' \? contactRelationshipOverview/);
});

test('概览页面仅透传本组显式证据目录，其他产品环境仍由现行隔离规则清除', async () => {
  const source = await readFile('scripts/test-pages.mjs', 'utf8');
  assert.match(source, /function pageFixtureEnvironment\(options, environment\)/);
  const helper = source.slice(source.indexOf('function pageFixtureEnvironment('), source.indexOf('async function run(options)'));
  const environment = { NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR: '/private/tmp/overview-evidence',
    NOTALONE_OWNER_ID: ids.contact, NOTALONE_DATABASE_URL: 'sensitive-local-value', DEEPSEEK_API_KEY: 'blocked' };
  const invoke = (options, input = environment) => runInNewContext(`${helper}; pageFixtureEnvironment(options, environment)`,
    { options, environment: input, path, desktop: '/opt/notalone/desktop' });
  assert.equal(JSON.stringify(invoke({ names: ['contact-relationship-overview'] })),
    JSON.stringify({ NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR: environment.NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR }));
  assert.equal(JSON.stringify(invoke({ names: ['memory-current-status'] })), '{}');
  for (const directory of [undefined, 'relative-evidence', '/opt/notalone/desktop/evidence', '/opt/notalone']) {
    assert.throws(() => invoke({ names: ['contact-relationship-overview'] },
      { NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR: directory }), /page_test_environment/);
  }
  assert.match(source, /\.\.\.fixtureEnvironment/);
});
