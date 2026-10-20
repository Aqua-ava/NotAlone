import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, readyPayload, payload, ids } from './support.mjs';

async function timers(run) {
  const saved = { setTimeout, clearTimeout };
  const pending = new Set();
  globalThis.setTimeout = fn => { const timer = { fn, unref() {} }; pending.add(timer); return timer; };
  globalThis.clearTimeout = timer => pending.delete(timer);
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const tick = async () => { const due = [...pending]; pending.clear(); for (const timer of due) timer.fn(); await settle(); };
  try { await run({ pending, tick, settle }); }
  finally { Object.assign(globalThis, saved); }
}

test('记忆页释放停止轮询，来源删除仍清空资料，重入重新读取权威状态', () => timers(async ({ pending, tick, settle }) => {
  let calls = 0, resolveLate;
  const f = await fixture(async () => ({ generation: 1, data: ++calls === 2
    ? await new Promise(resolve => { resolveLate = resolve; }) : readyPayload() }));
  const observed = [];
  const off = f.bridge.onStateChanged(state => observed.push(state));
  try {
    await f.bridge.readLayeredMemory(f.selection());
    assert.equal(pending.size, 1);
    await tick();
    assert.equal(calls, 2);
    await f.bridge.releaseLayeredMemory(f.selection());
    assert.equal(pending.size, 0);
    f.controller.sourceDeletionChanged('started');
    assert.equal(f.controller.getState().layeredMemory.value, null);
    resolveLate(readyPayload({ purpose: '迟到资料' }));
    await settle();
    assert.equal(f.controller.getState().layeredMemory.value, null);
    f.controller.sourceDeletionChanged('settled');
    for (let i = 0; i < 60; i++) await tick();
    assert.equal(calls, 2);
    assert.equal(pending.size, 0);
    await f.bridge.readLayeredMemory(f.selection());
    assert.equal(calls, 3);
    assert.equal(f.controller.getState().layeredMemory.phase, 'ready');
    assert.equal(pending.size, 1);
    const selection = f.selection();
    // 旧页面清理不能取消新联系人的读取。
    f.contacts.selectContact({ contactId: '99999999-9999-4999-8999-999999999999', scopeRevision: selection.scopeRevision });
    f.controller.synchronizeScope();
    await f.bridge.releaseLayeredMemory(selection);
    assert.equal(f.controller.getState().contactId, '99999999-9999-4999-8999-999999999999');
    f.disconnect();
    assert.equal(pending.size, 0);
  } finally { off(); f.disconnect(); }
}));

for (const action of ['add', 'manage']) test(`本人${action}写入期间离页再重入，结算后权威刷新底层资料`, () => timers(async ({ pending, settle }) => {
  let finishWrite, factsReads = 0;
  const data = readyPayload({ scope_kind: 'owner', contact_id: null });
  const f = await fixture(async request => {
    if (request.method === 'POST') return await new Promise(resolve => { finishWrite = resolve; });
    if (request.path === '/api/memories/owner') { ++factsReads; return { generation: 1, data: { memories: [] } }; }
    return { generation: 1, data };
  });
  try {
    await f.bridge.readOwnerMemories();
    await f.bridge.readOwnerLayeredMemory({});
    const writing = action === 'add' ? f.bridge.addOwnerMemory({ text: '合成补充', category: 'common_fact' })
      : f.bridge.manageOwnerLayeredMemory({ action: 'pause', settingsGeneration: 1, workRevision: 1 });
    await settle();
    await f.bridge.releaseOwnerLayeredMemory();
    await assert.rejects(f.bridge.readOwnerMemories());
    assert.equal(factsReads, 1, '写入尚未结算时登记读取意图');
    finishWrite({ generation: 1, data });
    await writing;
    assert.equal(factsReads, 2);
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).memories.phase, 'ready');
    await f.bridge.releaseOwnerLayeredMemory();
    assert.equal(pending.size, 0);
  } finally { f.disconnect(); }
}));

for (const action of ['add', 'manage']) test(`联系人${action}写入期间离页再重入，结算后恢复资料复验`, () => timers(async ({ pending, settle }) => {
  let finishWrite, layeredReads = 0;
  const f = await fixture(async request => {
    if (request.method === 'POST') return await new Promise(resolve => { finishWrite = resolve; });
    if (request.path.includes('/layered-memory')) { ++layeredReads; return { generation: 1, data: readyPayload() }; }
    return { generation: 1, data: request.path.endsWith('/memory-candidates') ? { candidates: [] } : request.path.endsWith('/sources') ? { sources: [] } : { memories: [] } };
  });
  try {
    const selection = f.selection();
    await f.bridge.readLayeredMemory(selection);
    const writing = action === 'add' ? f.bridge.add({ ...selection, level: 'contact', text: '合成补充', category: 'common_fact' })
      : f.bridge.manageLayeredMemory({ ...selection, action: 'pause', settingsGeneration: 1, workRevision: 1 });
    await settle();
    await f.bridge.releaseLayeredMemory(selection);
    await assert.rejects(f.bridge.readLayeredMemory(selection));
    finishWrite({ generation: 1, data: readyPayload() });
    await writing;
    assert.equal(f.controller.getState().mutation.phase, 'success');
    assert.equal(layeredReads, 2);
    assert.equal(f.controller.getState().layeredMemory.phase, 'ready');
    assert.equal(pending.size, 1);
  } finally { f.disconnect(); }
}));

for (const scope of ['contact', 'owner']) test(`${scope}删除期间重入保留意图，结算后才权威读取`, () => timers(async ({ pending, settle }) => {
  let calls = 0;
  const f = await fixture(async () => { ++calls; return { generation: 1, data: readyPayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact }) }; });
  const read = () => scope === 'owner' ? f.bridge.readOwnerLayeredMemory({}) : f.bridge.readLayeredMemory(f.selection());
  try {
    await read();
    if (scope === 'owner') await f.bridge.releaseOwnerLayeredMemory(); else await f.bridge.releaseLayeredMemory(f.selection());
    f.controller.sourceDeletionChanged('started');
    await assert.rejects(read());
    assert.equal(calls, 1, '删除门禁未解除时不能读取');
    f.controller.sourceDeletionChanged('settled');
    await settle();
    assert.equal(calls, 2);
    assert.equal(pending.size, 1);
  } finally { f.disconnect(); }
}));

for (const scope of ['contact', 'owner']) test(`${scope}离页保留已提交写入的权威复读`, () => timers(async ({ pending, settle }) => {
  let writing = false, finishRead, verifyingSignal;
  const data = readyPayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact });
  const f = await fixture(async request => {
    if (request.method === 'POST') { writing = true; return { generation: 1, data: {} }; }
    const verifying = scope === 'contact' ? request.path.includes('/layered-memory') : request.path === '/api/memories/owner';
    if (writing && verifying) { verifyingSignal = request.signal; return await new Promise(resolve => { finishRead = resolve; }); }
    return { generation: 1, data: request.path.includes('/layered-memory') ? data
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : request.path.endsWith('/sources') ? { sources: [] } : { memories: [] } };
  });
  try {
    if (scope === 'owner') await f.bridge.readOwnerMemories(); else await f.bridge.readLayeredMemory(f.selection());
    const saving = scope === 'owner' ? f.bridge.addOwnerMemory({ text: '合成写入', category: 'common_fact' })
      : f.bridge.add({ ...f.selection(), level: 'contact', text: '合成写入', category: 'common_fact' });
    await settle();
    assert.equal(typeof finishRead, 'function');
    if (scope === 'owner') await f.bridge.releaseOwnerLayeredMemory(); else await f.bridge.releaseLayeredMemory(f.selection());
    assert.equal(verifyingSignal.aborted, false);
    finishRead({ generation: 1, data: scope === 'contact' ? data : { memories: [] } });
    await saving;
    const state = scope === 'contact' ? f.controller.getState() : await f.bridge.getOwnerLayeredMemoryState();
    assert.equal(state.mutation.phase, 'success');
    assert.equal(pending.size, 0);
  } finally { f.disconnect(); }
}));

test('旧联系人释放不会停掉新范围轮询，停用及断连仍按原规则停止', () => timers(async ({ pending, tick }) => {
  let enabled = true, calls = 0;
  const f = await fixture(async request => {
    ++calls;
    const id = request.path.includes(ids.other) ? ids.other : ids.contact;
    return { generation: 1, data: enabled ? readyPayload({ contact_id: id }) : payload({ contact_id: id }) };
  });
  try {
    const old = f.selection();
    await f.bridge.readLayeredMemory(old);
    assert.equal(pending.size, 1);
    f.contacts.selectContact({ contactId: ids.other, scopeRevision: old.scopeRevision });
    await f.bridge.readLayeredMemory(f.selection());
    await f.bridge.releaseLayeredMemory(old);
    assert.equal(pending.size, 1);
    await tick();
    assert.equal(calls, 3);
    enabled = false;
    await f.bridge.readLayeredMemory(f.selection());
    assert.equal(pending.size, 0);
    assert.equal(f.handlers.get('memory:release-layered-memory').role, 'manager');
    assert.equal(f.handlers.get('memory:release-owner-layered').role, 'manager');
    await assert.rejects(f.bridge.releaseLayeredMemory({ ...f.selection(), section: 'contact' }));
    await assert.rejects(f.bridge.releaseOwnerLayeredMemory({ contactId: ids.contact }));
    enabled = true;
    await f.bridge.readLayeredMemory(f.selection());
    f.disconnect();
    assert.equal(pending.size, 0);
  } finally { f.disconnect(); }
}));

test('本人页离开取消自动读取，写入继续结算且不会重新开启后台轮询', () => timers(async ({ pending, tick, settle }) => {
  let calls = 0, finishWrite, signal;
  const data = readyPayload({ scope_kind: 'owner', contact_id: null });
  const f = await fixture(async request => {
    ++calls;
    if (request.method === 'POST') { signal = request.signal; return await new Promise(resolve => { finishWrite = resolve; }); }
    return { generation: 1, data };
  });
  try {
    await f.bridge.readOwnerLayeredMemory({});
    assert.equal(pending.size, 1);
    await f.bridge.releaseOwnerLayeredMemory();
    assert.equal(pending.size, 0);
    f.controller.sourceDeletionChanged('started'); f.controller.sourceDeletionChanged('settled');
    for (let i = 0; i < 60; i++) await tick();
    assert.equal(calls, 1);
    await f.bridge.readOwnerLayeredMemory({});
    assert.equal(calls, 2);
    const writing = f.bridge.manageOwnerLayeredMemory({ action: 'pause', settingsGeneration: 1, workRevision: 1 });
    await settle();
    assert.equal(typeof finishWrite, 'function');
    await f.bridge.releaseOwnerLayeredMemory();
    assert.equal(signal.aborted, false);
    finishWrite({ generation: 1, data });
    await writing;
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).mutation.phase, 'success');
    assert.equal(pending.size, 0);
    for (let i = 0; i < 60; i++) await tick();
    assert.equal(calls, 3);
  } finally { f.disconnect(); }
}));
