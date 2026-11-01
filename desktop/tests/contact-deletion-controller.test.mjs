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
export {installContactDeletionBridge} from './src/main/contact-deletion/bridge';
export {createContactDeletionBridge} from './src/preload/contact-deletion';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(temporary, 'controller.mjs'), output.outputFiles[0].text);
const { ContactDeletionController, installContactDeletionBridge, createContactDeletionBridge } = await import(path.join(temporary, 'controller.mjs'));
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
  let selection = { revision: 1, scopeRevision: 7, directoryPhase: 'ready', selectedContactId: a,
    contacts: [{ contactId: a, displayName: '合成甲' }, { contactId: b, displayName: '合成乙' }] };
  let lostDelete = options.lostDelete ?? false;
  const contacts = {
    getState: () => structuredClone(selection),
    async refreshContacts() {
      if (serverOperation) selection = { ...selection, contacts: selection.contacts.filter(item => item.contactId !== a),
        ...(selection.selectedContactId === a ? { selectedContactId: null, scopeRevision: selection.scopeRevision + 1 } : {}) };
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
        return { generation: accepted, data: { operations: serverOperation ? [serverOperation] : [] } };
      }
      if (request.method === 'DELETE') {
        if (options.beforeDelete) await options.beforeDelete();
        serverOperation = publicOperation(options.finalPhase ?? 'completed');
        if (lostDelete) { lostDelete = false; throw new Error('synthetic_lost_response'); }
        return { generation: accepted, data: { operation_id: opId, state: 'completed' } };
      }
      if (request.method === 'POST') {
        serverOperation = publicOperation();
        return { generation: accepted, data: serverOperation };
      }
      if (statusFailures-- > 0) throw new Error('synthetic_status_unavailable');
      return { generation: accepted, data: options.unverified ? { ...serverOperation, checks: [] }
        : options.foreignStatus ? publicOperation('blocked', b) : serverOperation };
    },
  };
  const controller = new ContactDeletionController(backend, contacts,
    () => { notifications.push('started'); return () => notifications.push('settled'); }, id => notifications.push(id));
  t.after(() => controller.dispose());
  await controller.refresh();
  return { controller, backend, contacts, requests, notifications,
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
