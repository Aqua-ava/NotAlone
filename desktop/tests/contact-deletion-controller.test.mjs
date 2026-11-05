import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const temporary = await mkdtemp(path.join(tmpdir(), 'notalone-contact-deletion-controller-'));
after(() => rm(temporary, { recursive: true, force: true }));
const output = await build({ stdin: { contents: `
export {ContactDeletionController} from './src/main/contact-deletion/controller';
export {ContactDeletionQuiet} from './src/main/contacts/deletion-quiet';
export {installContactDeletionBridge} from './src/main/contact-deletion/bridge';
export {createContactDeletionBridge} from './src/preload/contact-deletion';
export {BackendRequestFailure, requestTimeoutLimitMs} from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(temporary, 'controller.mjs'), output.outputFiles[0].text);
const { ContactDeletionController, ContactDeletionQuiet, installContactDeletionBridge, createContactDeletionBridge, BackendRequestFailure, requestTimeoutLimitMs } = await import(path.join(temporary, 'controller.mjs'));
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const opId = '33333333-3333-4333-8333-333333333333';
const owner = '44444444-4444-4444-8444-444444444444';
const publicOperation = (phase = 'completed', contactId = a) => ({ operation_id: opId, scope_kind: 'contact',
  state: phase, status: phase === 'completed' ? 'succeeded' : phase === 'blocked' ? 'failed' : 'running',
  ...(phase === 'completed' ? {} : { contact_id: contactId }),
  finished_at: phase === 'completed' ? '2026-11-01T00:00:00Z' : null, error_code: null,
  checks: [{ kind: 'final_recheck', result: phase === 'completed' ? 'passed' : 'blocked', proof: 'synthetic' }] });

async function fixture(t, options = {}) {
  const requests = [], notifications = [], listeners = new Set();
  let generation = 1, ownerId = owner, serverOperation = options.recovered ?? null, statusFailures = options.statusFailures ?? 0, listFails = false;
  let statusReads = 0, retryTimedOut = false, deleteTimedOut = false, retryBusy = false;
  let transientStatusFailures = options.transientStatusFailures ?? 0, statusConflictFailures = options.statusConflictFailures ?? 0;
  let selection = { revision: 1, scopeRevision: 7, directoryPhase: 'ready', selectedContactId: a,
    contacts: [{ contactId: a, displayName: '合成甲' }, { contactId: b, displayName: '合成乙' }] };
  let lostDelete = options.lostDelete ?? false;
  const refreshes = { full: 0, background: 0 };
  const reconcile = () => {
    if (!serverOperation) return;
    selection = { ...selection, contacts: selection.contacts.filter(item => item.contactId !== a),
      ...(selection.selectedContactId === a ? { selectedContactId: null, scopeRevision: selection.scopeRevision + 1 } : {}) };
  };
  const contacts = {
    getState: () => structuredClone(selection),
    removeContact(contactId) {
      if (!selection.contacts.some(item => item.contactId === contactId)) return;
      selection = { ...selection, contacts: selection.contacts.filter(item => item.contactId !== contactId),
        ...(selection.selectedContactId === contactId ? { selectedContactId: null, draft: '', scopeRevision: selection.scopeRevision + 1 } : {}) };
    },
    async refreshContacts() { refreshes.full++; reconcile(); },
    async refreshContactsInBackground() {
      refreshes.background++;
      if (options.backgroundRefreshFails) return false;
      reconcile();
      return true;
    },
  };
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    async requestJson(request) {
      const accepted = generation; requests.push(request);
      if (request.path === '/api/setup/status') return { generation: accepted, data: { runtime_owner_configured: true, owner_id: ownerId } };
      if (request.path === '/api/deletions') {
        if (listFails) throw new Error('synthetic_list_unavailable');
        // 已完成任务不返回联系人标识，发现路径只能看到未完成原任务。
        const visible = serverOperation && serverOperation.state !== 'completed' && !options.hideDiscovery
          && (!options.discoverAfterTimeout || deleteTimedOut);
        return { generation: accepted, data: { operations: visible ? [serverOperation] : [] } };
      }
      if (request.method === 'DELETE') {
        if (options.beforeDelete) await options.beforeDelete();
        const timeoutOnce = options.transportTimeout === true && !deleteTimedOut;
        if (timeoutOnce) deleteTimedOut = true;
        serverOperation = publicOperation(timeoutOnce ? 'cleaning' : options.finalPhase ?? 'completed');
        if (lostDelete) { lostDelete = false; throw new Error('synthetic_lost_response'); }
        if (options.rejectDelete) throw options.rejectDelete;
        if (timeoutOnce) throw new BackendRequestFailure('connection');
        return { generation: accepted, data: { operation_id: opId, state: 'completed' } };
      }
      if (request.method === 'POST') {
        if (options.retryBusyOnce && !retryBusy) {
          retryBusy = true; serverOperation = publicOperation('cleaning');
          throw new BackendRequestFailure('response', 409, 'deletion_busy');
        }
        if (options.retryBlocked && options.retryBlocked-- > 0) { serverOperation = publicOperation('blocked'); return { generation: accepted, data: serverOperation }; }
        if (options.retryTransportTimeout && !retryTimedOut) {
          retryTimedOut = true; serverOperation = publicOperation('cleaning');
          throw new BackendRequestFailure('connection');
        }
        serverOperation = publicOperation();
        return { generation: accepted, data: serverOperation };
      }
      if (statusConflictFailures-- > 0) throw new BackendRequestFailure('response', 409, 'deletion_busy');
      if (transientStatusFailures-- > 0) throw new BackendRequestFailure('connection');
      if (statusFailures-- > 0) throw new Error('synthetic_status_unavailable');
      if (serverOperation?.state === 'cleaning' && options.completeAfterStatusReads !== undefined
        && statusReads++ >= options.completeAfterStatusReads) {
        serverOperation = publicOperation('completed');
      }
      return { generation: accepted, data: options.unverified ? { ...serverOperation, checks: [] }
        : options.foreignStatus ? publicOperation('blocked', b) : serverOperation };
    },
  };
  // 合成时序：超时发现/轮询用毫秒级预算，避免测试等待生产有界等待窗口。
  const timing = { operationWaitMs: 200, operationPollMs: 1, discoverPollMs: 1, discoverTimeoutMs: 20 };
  const quiet = options.quiet ?? new ContactDeletionQuiet();
  const controller = new ContactDeletionController(backend, contacts,
    () => { notifications.push('started'); return () => notifications.push('settled'); }, id => notifications.push(id), quiet,
    { ...timing, ...(options.auto ?? { autoRetryDelaysMs: [], autoResume: false, contactPollMs: 0 }), ...(options.controller ?? {}) });
  t.after(() => controller.dispose());
  await controller.refresh();
  for (let i = 0; i < 100 && controller.getState().phase === 'loading'; i++) await new Promise(resolve => setImmediate(resolve));
  return { controller, backend, contacts, requests, notifications, refreshes, quiet,
    setListFails(value) { listFails = value; },
    select(contactId) { selection = { ...selection, selectedContactId: contactId, scopeRevision: selection.scopeRevision + 1 }; },
    reconnect({ differentOwner = false, failList = false } = {}) {
      listFails = failList;
      if (differentOwner) ownerId = b;
      ++generation; for (const fn of listeners) fn();
    },
    request: () => ({ contactId: a, scopeRevision: selection.scopeRevision, confirmed: true }) };
}

test('打开和刷新删除状态只读任务，没有明确确认不能删除或指定其他联系人', async t => {
  const f = await fixture(t);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  const before = f.requests.length;
  for (const value of [{ ...f.request(), confirmed: false }, { ...f.request(), contactId: b }, { ...f.request(), scopeRevision: 0 }]) {
    await assert.rejects(f.controller.delete(value), /联系人已变化/);
  }
  assert.equal(f.requests.length, before);
});

test('删除选中联系人消费权威终态，清除当前选择且其他联系人保持可用', async t => {
  const f = await fixture(t);
  await f.controller.delete(f.request());
  const mutations = f.requests.filter(request => request.method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, `/api/contacts/${a}`);
  assert.deepEqual(mutations[0].body, { confirmed: true, confirm_contact_id: a });
  assert.equal(f.requests.at(-1).path, `/api/deletions/${opId}`);
  const state = f.controller.getState();
  assert.equal(state.busyId, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(state.operations[0].displayName, null);
  assert.equal(state.operations[0].contactId, null);
  assert.equal(f.contacts.getState().selectedContactId, null);
  assert.deepEqual(f.contacts.getState().contacts.map(item => item.contactId), [b]);
  assert.deepEqual(f.notifications, ['started', a, 'settled']);
});

test('202回执写completed也不能越过原任务的blocked状态或缺失的最终复核', async t => {
  for (const options of [{ finalPhase: 'blocked' }, { unverified: true }]) {
    const f = await fixture(t, options);
    await f.controller.delete(f.request());
    assert.notEqual(f.controller.getState().operations[0].phase, 'completed');
  }
});

test('联系人已离开目录时保留删除任务；读取失败后只重试原任务而不删除新选择', async t => {
  const f = await fixture(t, { statusFailures: 1 });
  await f.controller.delete(f.request());
  assert.equal(f.contacts.getState().selectedContactId, null);
  const unknown = f.controller.getState().operations[0];
  assert.equal(unknown.phase, 'unconfirmed');
  assert.equal(unknown.operationId, opId);
  f.select(b);
  await f.controller.retry({ id: unknown.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  const mutations = f.requests.filter(request => request.method !== 'GET');
  assert.deepEqual(mutations.map(request => [request.method, request.path]), [['DELETE', `/api/contacts/${a}`], ['POST', `/api/deletions/${opId}/retry`]]);
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
  assert.equal(f.contacts.getState().selectedContactId, b);
});

test('删除回执丢失不推断成功，用户重试只重放最初确认的旧联系人ID', async t => {
  const f = await fixture(t, { lostDelete: true });
  await f.controller.delete(f.request());
  let unknown = f.controller.getState().operations[0];
  assert.equal(unknown.operationId, null);
  await f.controller.refresh();
  unknown = f.controller.getState().operations[0];
  assert.equal(unknown.phase, 'unconfirmed');
  f.select(b);
  await f.controller.retry({ id: unknown.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.deepEqual(f.requests.filter(request => request.method === 'DELETE').map(request => request.path), [`/api/contacts/${a}`, `/api/contacts/${a}`]);
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
});

test('旧连接的迟到删除回执不写入新连接状态，也不会自动重放删除', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeDelete: () => wait });
  const deleting = f.controller.delete(f.request());
  f.reconnect();
  release(); await deleting;
  await f.controller.refresh();
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(f.requests.some(request => request.path === `/api/deletions/${opId}`), false);
  assert.equal(f.controller.getState().busyId, null);
  assert.equal(f.controller.getState().operations[0].phase, 'unconfirmed');
});

test('重连只读恢复未完成联系人任务；重试不要求被删联系人仍在目录', async t => {
  const f = await fixture(t, { recovered: publicOperation('blocked') });
  f.select(b);
  const recovered = f.controller.getState().operations[0];
  assert.equal(recovered.displayName, null);
  await assert.rejects(f.controller.retry({ id: recovered.id, scopeRevision: -1, confirmed: true }), /任务已变化/);
  await f.controller.retry({ id: recovered.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
});

test('同本人重连后的名单失败保留未知删除意图，仍可明确重放原旧ID', async t => {
  const f = await fixture(t, { lostDelete: true });
  await f.controller.delete(f.request());
  const pending = f.controller.getState().operations[0];
  f.reconnect({ failList: true });
  await f.controller.refresh();
  assert.equal(f.controller.getState().operations[0].id, pending.id);
  assert.equal(f.controller.getState().operations[0].phase, 'unconfirmed');
  f.select(b);
  await f.controller.retry({ id: pending.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.deepEqual(f.requests.filter(request => request.method === 'DELETE').map(request => request.path), [`/api/contacts/${a}`, `/api/contacts/${a}`]);
});

test('换本人连接不公开旧删除姓名和任务，也不能重试旧意图', async t => {
  const f = await fixture(t, { lostDelete: true });
  await f.controller.delete(f.request());
  const oldId = f.controller.getState().operations[0].id;
  f.reconnect({ differentOwner: true });
  await f.controller.refresh();
  assert.deepEqual(f.controller.getState().operations, []);
  await assert.rejects(f.controller.retry({ id: oldId, scopeRevision: f.controller.getState().scopeRevision, confirmed: true }), /任务已变化/);
});

test('其他联系人的错误任务回执不会成为后续POST重试的权限', async t => {
  const f = await fixture(t, { foreignStatus: true });
  await f.controller.delete(f.request());
  const pending = f.controller.getState().operations[0];
  assert.equal(pending.phase, 'unconfirmed');
  assert.equal(pending.operationId, null);
  await f.controller.retry({ id: pending.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.ok(f.requests.filter(request => request.method === 'DELETE').every(request => request.path === `/api/contacts/${a}`));
});

test('确认一次后后台自动续跑原任务直至完成，不需要用户再点任何按钮', async t => {
  const f = await fixture(t, { finalPhase: 'cleaning', retryBlocked: 1, auto: { autoRetryDelaysMs: [0, 0, 0], autoResume: false, contactPollMs: 0 } });
  await f.controller.delete(f.request());
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.deepEqual(posts.map(request => request.path), [`/api/deletions/${opId}/retry`, `/api/deletions/${opId}/retry`]);
  assert.ok(posts.every(request => request.body.confirmed === true));
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
  assert.equal(f.controller.getState().busyId, null);
});

test('自动续跑次数有限，仍未完成时保留原任务交给用户明确重试', async t => {
  const f = await fixture(t, { finalPhase: 'blocked', retryBlocked: 99, auto: { autoRetryDelaysMs: [0, 0], autoResume: false, contactPollMs: 0 } });
  await f.controller.delete(f.request());
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 2);
  const state = f.controller.getState();
  assert.equal(state.operations[0].phase, 'blocked');
  assert.equal(state.operations[0].operationId, opId);
  assert.equal(state.busyId, null);
});

test('重连或重开后自动续跑已有任务编号的未完成任务，每个连接只续跑一次且不重放删除', async t => {
  const f = await fixture(t, { recovered: publicOperation('cleaning'), auto: { autoRetryDelaysMs: [], autoResume: true, contactPollMs: 0 } });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests.filter(request => request.method === 'POST').map(request => request.path), [`/api/deletions/${opId}/retry`]);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
  await f.controller.refresh();
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('没有回执的删除意图不会被自动重放', async t => {
  const f = await fixture(t, { lostDelete: true, auto: { autoRetryDelaysMs: [0, 0], autoResume: true, contactPollMs: 0 } });
  await f.controller.delete(f.request());
  await f.controller.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(f.controller.getState().operations[0].phase, 'unconfirmed');
});

test('删除请求发出即从内存目录撤下目标联系人，不等名单服务恢复', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let atRequest;
  const f = await fixture(t, { beforeDelete: () => { atRequest = f.contacts.getState(); }, auto: { autoRetryDelaysMs: [], autoResume: false, contactPollMs: 0 } });
  const deleting = f.controller.delete(f.request());
  for (let i = 0; i < 100 && !f.requests.some(request => request.method === 'DELETE'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(f.requests.some(request => request.method === 'DELETE'));
  // 删除请求还在等待清理回执时，目录已撤下这一位联系人。
  assert.deepEqual(atRequest.contacts.map(contact => contact.contactId), [b]);
  assert.equal(atRequest.selectedContactId, null);
  release(); await deleting;
});

test('删除请求期间的名单读取与收尾都走失败保留的后台刷新，不使用会清空目录的路径', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeDelete: () => wait, backgroundRefreshFails: true,
    auto: { autoRetryDelaysMs: [], autoResume: false, contactPollMs: 5 } });
  const deleting = f.controller.delete(f.request());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(f.refreshes.background >= 2, `期间应反复后台读取，实际 ${f.refreshes.background} 次`);
  assert.equal(f.refreshes.full, 0, '轮询不能使用会清空界面的完整刷新');
  release(); await deleting;
  assert.equal(f.refreshes.full, 0, '收尾也必须使用保留式后台刷新');
  assert.ok(f.refreshes.background >= 3);
  assert.deepEqual(f.contacts.getState().contacts.map(contact => contact.contactId), [b], '名单读取失败仍保留本地撤下结果');
  assert.equal(f.contacts.getState().selectedContactId, null);
});

test('删除运行期间开启名单服务窗口，完成后恢复无关读取并补读一次', async t => {
  let duringRequest;
  const flushes = [];
  const f = await fixture(t, { beforeDelete: () => {
    duringRequest = f.quiet.deleting;
    f.quiet.defer(() => flushes.push('read'));
  } });
  assert.equal(f.quiet.deleting, false);
  await f.controller.delete(f.request());
  assert.equal(duringRequest, true, '删除请求期间应处于名单服务不可用窗口');
  assert.equal(f.quiet.deleting, false, '任务完成后窗口结束');
  assert.deepEqual(flushes, ['read'], '窗口结束补读一次');
});

test('删除未完成时保持名单服务窗口，任务完成后才恢复读取', async t => {
  const f = await fixture(t, { finalPhase: 'blocked', auto: { autoRetryDelaysMs: [], autoResume: false, contactPollMs: 0 } });
  await f.controller.delete(f.request());
  assert.equal(f.controller.getState().operations[0].phase, 'blocked');
  assert.equal(f.quiet.deleting, true, '未完成任务期间继续关闭名单服务窗口');
  const flushes = [];
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  const pending = f.controller.getState().operations[0];
  await f.controller.retry({ id: pending.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
  assert.equal(f.quiet.deleting, false, '确认全部完成后窗口结束');
  assert.deepEqual(flushes, ['read']);
});

test('重连读取删除状态完成前保持窗口，确认无未完成任务后才恢复读取', async t => {
  const f = await fixture(t, { auto: { autoRetryDelaysMs: [], autoResume: false, contactPollMs: 0 } });
  const flushes = [];
  f.reconnect();
  assert.equal(f.quiet.deleting, true, '重连探针期间保持窗口');
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  for (let i = 0; i < 200 && f.quiet.deleting; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.quiet.deleting, false, '删除状态确认无未完成任务后恢复读取');
  assert.deepEqual(flushes, ['read']);
});

test('重连保留未确认删除意图期间继续关闭窗口，重试完成后补读', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeDelete: () => wait, auto: { autoRetryDelaysMs: [], autoResume: false, contactPollMs: 0 } });
  const deleting = f.controller.delete(f.request());
  for (let i = 0; i < 100 && !f.requests.some(request => request.method === 'DELETE'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  f.reconnect();
  release();
  await deleting;
  const pending = f.controller.getState().operations[0];
  assert.equal(pending.phase, 'unconfirmed');
  assert.equal(f.quiet.deleting, true, '同本人未确认意图保留期间窗口不提前结束');
  const flushes = [];
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  f.select(b);
  await f.controller.retry({ id: pending.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
  assert.equal(f.quiet.deleting, false);
  assert.deepEqual(flushes, ['read']);
});

test('删除请求在运输层超时后找回原任务并轮询到完成，不误报结果未知', async t => {
  const f = await fixture(t, { transportTimeout: true, completeAfterStatusReads: 2 });
  await f.controller.delete(f.request());
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.busyId, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(state.operations[0].operationId, opId);
  // 同一确认只发出一次删除；超时后靠原任务轮询收尾，不重复删除。
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.ok(f.requests.some(request => request.method === 'GET' && request.path === '/api/deletions'));
  assert.ok(f.requests.some(request => request.path === `/api/deletions/${opId}`));
  assert.ok(f.requests.every(request => request.timeoutMs === undefined || request.timeoutMs <= requestTimeoutLimitMs),
    '删除请求不能超过运输层单次时限');
});

test('删除请求超时但名单里找不到原任务时保守标记未知，重试只重放原旧联系人ID', async t => {
  const f = await fixture(t, { transportTimeout: true, hideDiscovery: true });
  await f.controller.delete(f.request());
  let unknown = f.controller.getState().operations[0];
  assert.equal(unknown.phase, 'unconfirmed');
  assert.equal(unknown.operationId, null);
  f.select(b);
  await f.controller.retry({ id: unknown.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.deepEqual(f.requests.filter(request => request.method === 'DELETE').map(request => request.path), [`/api/contacts/${a}`, `/api/contacts/${a}`]);
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
});

test('轮询期间状态读取的连接中断按瞬时失败重试，最终确认完成', async t => {
  const f = await fixture(t, { transportTimeout: true, transientStatusFailures: 2, completeAfterStatusReads: 1 });
  await f.controller.delete(f.request());
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.busyId, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
});

test('轮询期间压缩造成的瞬时409按瞬时失败重试，不误报未知', async t => {
  const f = await fixture(t, { transportTimeout: true, statusConflictFailures: 1, completeAfterStatusReads: 1 });
  await f.controller.delete(f.request());
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.operations[0].phase, 'completed');
});

test('后端明确拒绝删除时立即保守标记未知，不等待发现窗口', async t => {
  const started = Date.now();
  const f = await fixture(t, { rejectDelete: new BackendRequestFailure('response', 400, 'deletion_confirmation_required'),
    controller: { discoverTimeoutMs: 5_000 } });
  await f.controller.delete(f.request());
  const state = f.controller.getState();
  assert.equal(state.operations[0].phase, 'unconfirmed');
  assert.equal(state.operations[0].operationId, null);
  assert.equal(state.operations[0].errorCode, 'deletion_confirmation_required');
  assert.ok(state.error);
  assert.ok(Date.now() - started < 1_000, '明确拒绝不应等待发现窗口');
});

test('重试原任务的请求超时后同样按原任务轮询到完成，不重放删除', async t => {
  const f = await fixture(t, { recovered: publicOperation('blocked'), retryTransportTimeout: true, completeAfterStatusReads: 1 });
  f.select(b);
  const recovered = f.controller.getState().operations[0];
  await f.controller.retry({ id: recovered.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.ok(f.requests.every(request => request.timeoutMs === undefined || request.timeoutMs <= requestTimeoutLimitMs),
    '续跑请求不能超过运输层单次时限');
});

test('有界轮询到期后保留清理态与继续入口，不误报结果未知', async t => {
  const f = await fixture(t, { transportTimeout: true, completeAfterStatusReads: 1_000_000,
    controller: { operationWaitMs: 40, operationPollMs: 1 } });
  await f.controller.delete(f.request());
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.busyId, null);
  assert.equal(state.operations[0].phase, 'cleaning');
  assert.equal(state.operations[0].operationId, opId);
  // 到期时任务可能仍由后端推进，不用额外续跑请求制造并发。
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0);
  assert.ok(f.requests.some(request => request.path === `/api/deletions/${opId}`));
});

test('超时前名单读不到、超时后才可发现原任务时仍自动完成', async t => {
  const f = await fixture(t, { transportTimeout: true, discoverAfterTimeout: true, completeAfterStatusReads: 1 });
  await f.controller.delete(f.request());
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.busyId, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
});

test('自动续跑请求超时后转入原任务轮询，不静默停在旧阶段', async t => {
  const f = await fixture(t, { recovered: publicOperation('blocked'), retryBlocked: 1, retryTransportTimeout: true,
    completeAfterStatusReads: 1, auto: { autoRetryDelaysMs: [0, 0], autoResume: false, contactPollMs: 0 } });
  f.select(b);
  const recovered = f.controller.getState().operations[0];
  await f.controller.retry({ id: recovered.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 2);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
});

test('续跑遇到409 busy按瞬时失败继续轮询原任务', async t => {
  const f = await fixture(t, { recovered: publicOperation('blocked'), retryBusyOnce: true, completeAfterStatusReads: 1 });
  f.select(b);
  const recovered = f.controller.getState().operations[0];
  await f.controller.retry({ id: recovered.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  const state = f.controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.operations[0].phase, 'completed');
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('删除预加载与正式IPC拒绝隐式确认、跨范围字段和额外身份参数', async () => {
  const handlers = new Map(), roles = new Map(), calls = [];
  const commands = { handle(name, fn, role) { handlers.set(name, fn); roles.set(name, role); }, publish() {} };
  const controller = installContactDeletionBridge(commands, { getConnectionGeneration: () => undefined, onStateChanged() {} },
    { getState: () => ({ contacts: [] }) }, () => () => {}, () => {});
  const preload = createContactDeletionBridge({ invoke: async (...args) => calls.push(args) });
  for (const invalid of [{ contactId: a, scopeRevision: 1 }, { contactId: a, scopeRevision: 1, confirmed: false },
    { contactId: a, scopeRevision: 1, confirmed: true, ownerId: 'injected' }]) {
    assert.throws(() => handlers.get('contact-deletion:delete')(invalid));
    await assert.rejects(preload.delete(invalid));
  }
  assert.equal(calls.length, 0);
  assert.ok([...roles.values()].every(role => role === 'manager'));
  await preload.delete({ contactId: a, scopeRevision: 1, confirmed: true });
  assert.equal(calls.at(-1)[0], 'contact-deletion:delete');
  controller.dispose();
});

test('删除窗口打开后删除状态读取照常发起，不被窗口阻止', async t => {
  const f = await fixture(t);
  const flushes = [];
  const finish = f.quiet.begin();
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  const before = f.requests.length;
  await f.controller.refresh();
  assert.ok(f.requests.length > before, '窗口内仍发起删除状态读取，而不是被 defer 阻止');
  assert.equal(f.controller.getState().phase, 'ready');
  finish();
  assert.deepEqual(flushes, ['read'], '窗口结束仍执行登记的补读');
});

test('本地未知回执经有界结算探针确认后端无未完成任务后结束窗口并补读', async t => {
  const f = await fixture(t, { lostDelete: true, controller: { settleProbeDelaysMs: [1, 1] } });
  const flushes = [];
  await f.controller.delete(f.request());
  const unknown = f.controller.getState().operations[0];
  assert.equal(unknown.operationId, null);
  assert.equal(unknown.phase, 'unconfirmed');
  assert.equal(f.quiet.deleting, true, '回执丢失时先保持窗口');
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  for (let i = 0; i < 500 && f.quiet.deleting; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.quiet.deleting, false, '探针确认后端无未完成任务后结束窗口');
  assert.deepEqual(flushes, ['read'], '窗口结束补读一次');
  assert.equal(f.controller.getState().operations[0].phase, 'unconfirmed', '本地未知意图仍保留供用户明确重试');
});

test('重连后已知未完成删除任务继续保持窗口，重试完成后结束并补读', async t => {
  const f = await fixture(t, { recovered: publicOperation('blocked') });
  assert.equal(f.quiet.deleting, true, '已知未完成任务一出现即保持窗口');
  const flushes = [];
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  f.reconnect();
  for (let i = 0; i < 200 && f.controller.getState().phase !== 'ready'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.quiet.deleting, true, '重连后已知未完成任务继续保持窗口');
  const pending = f.controller.getState().operations.find(item => item.phase !== 'completed');
  await f.controller.retry({ id: pending.id, scopeRevision: f.controller.getState().scopeRevision, confirmed: true });
  assert.equal(f.controller.getState().operations[0].phase, 'completed');
  assert.equal(f.quiet.deleting, false, '任务完成后结束窗口');
  assert.deepEqual(flushes, ['read']);
});

test('重连后本地未知回执经有界结算探针确认后结束窗口并补读', async t => {
  const f = await fixture(t, { lostDelete: true, controller: { settleProbeDelaysMs: [1, 1] } });
  await f.controller.delete(f.request());
  assert.equal(f.controller.getState().operations[0].operationId, null);
  assert.equal(f.quiet.deleting, true);
  const flushes = [];
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  f.reconnect();
  for (let i = 0; i < 500 && f.quiet.deleting; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.quiet.deleting, false, '重连的权威读取与结算探针共同确认后结束窗口');
  assert.deepEqual(flushes, ['read'], '窗口结束补读一次');
});

test('本地未知回执的结算探针在读取失败用尽后强制结束窗口并补读', async t => {
  const f = await fixture(t, { lostDelete: true, controller: { settleProbeDelaysMs: [1] } });
  await f.controller.delete(f.request());
  assert.equal(f.quiet.deleting, true);
  const flushes = [];
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  f.setListFails(true);
  for (let i = 0; i < 500 && f.quiet.deleting; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.quiet.deleting, false, '结算探针用尽后强制结束窗口，不无限期保持');
  assert.deepEqual(flushes, ['read'], '强制结束也补读一次');
});

test('删除窗口超过 quietMaxMs 兜底强制结束并补读，任务入口仍保留', async t => {
  const f = await fixture(t, { finalPhase: 'blocked', controller: { quietMaxMs: 5 } });
  await f.controller.delete(f.request());
  assert.equal(f.controller.getState().operations[0].phase, 'blocked');
  assert.equal(f.quiet.deleting, true, '已知未完成任务保持窗口');
  const flushes = [];
  assert.equal(f.quiet.defer(() => flushes.push('read')), true);
  for (let i = 0; i < 500 && f.quiet.deleting; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.quiet.deleting, false, '兜底超时后强制结束窗口');
  assert.deepEqual(flushes, ['read'], '兜底结束也补读一次');
  assert.equal(f.controller.getState().operations[0].phase, 'blocked', '受阻任务仍保留用户重试入口');
});
