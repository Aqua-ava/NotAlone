import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then((output) => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function fixture({ pendingDeletion = false } = {}) {
  const ports = await portsPromise;
  const contactId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID();
  const controls = { deleteFailure: true, missing: false, sessionId, deleteBarrier: null, operationStatus: 'succeeded', generation: 7, pendingDeletion };
  const calls = [], handlers = new Map();
  const backend = {
    getConnectionGeneration: () => controls.generation,
    onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      if (request.path.startsWith('/api/deletions?')) return { generation: 7, data: { operations: controls.pendingDeletion ? [{ operation_id: operationId, scope_kind: 'discussion', contact_id: contactId, target_id: sessionId, status: 'failed' }] : [] } };
      if (request.method === 'DELETE') {
        if (controls.deleteBarrier) await controls.deleteBarrier;
        if (controls.deleteFailure) throw new ports.BackendRequestFailure('response', 503, 'unavailable');
        controls.missing = true;
        return { generation: 7, data: { session_id: sessionId, state: 'deleted', operation_id: operationId } };
      }
      if (request.path === `/api/deletions/${operationId}`) { controls.operationEntered?.(); if (controls.operationBarrier) await controls.operationBarrier; return { generation: 7, data: { operation_id: operationId, scope_kind: 'discussion', status: controls.operationStatus } }; }
      if (request.path.endsWith('/assistant-sessions') && request.method === 'GET') return { generation: 7, data: {
        sessions: [{ session_id: controls.sessionId, is_current: true }], current_session_id: controls.sessionId } };
      if (request.path.endsWith('/assistant-session/default')) {
        return { generation: 7, data: { session_id: controls.sessionId } };
      }
      if (controls.missing && request.path.endsWith(sessionId)) {
        throw new ports.BackendRequestFailure('response', 404, 'not_found');
      }
      return { generation: 7, data: { mode: 'sqlite', session_id: controls.sessionId, runtime_recovery: 'ready', entries: [] } };
    },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成删除门禁联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, backend, contacts);
  const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args),
    on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await bridge.readSavedSession(scope);
  const remove = () => bridge.deleteSavedSession({ ...scope, sessionId, confirmed: true });
  const generationCalls = () => calls.filter((request) => request.method === 'POST'
    && /\/(?:explorations|replies)(?:\/|$)/.test(request.path));
  return { bridge, contacts, scope, calls, controls, remove, generationCalls, sessionId };
}

test('删除讨论只撤下该段上下文，保留未提交独立想法且不自动重建', async () => {
  const f = await fixture();
  f.contacts.setDraft({ ...f.scope, text: '删除讨论后仍保留的合成独立想法' });
  const readsBefore = f.calls.filter(request => request.path.endsWith('/assistant-session/default')).length;
  f.controls.deleteFailure = false;
  await f.remove();
  const state = await f.bridge.getState();
  assert.equal(state.sessionDeletion, 'deleted');
  assert.equal(f.contacts.getState().draft, '删除讨论后仍保留的合成独立想法');
  assert.equal(state.savedSession.sessionId, null);
  assert.deepEqual(state.savedSession.discussionEntries ?? [], []);
  assert.equal(f.calls.filter(request => request.path.endsWith('/assistant-session/default')).length, readsBefore);
  assert.equal(f.generationCalls().length, 0);
});

test('无成功删除回执的404不能把磁盘清理失败投影为删除完成', async () => {
  const f = await fixture();
  f.controls.missing = true;
  await f.remove();
  assert.equal((await f.bridge.getState()).sessionDeletion, 'failed');
});

test('业务已404但公开operation失败时保留失败，用户明确重试完成后才标记删除', async () => {
  const f = await fixture();
  f.controls.deleteFailure = false; f.controls.operationStatus = 'failed';
  await f.remove();
  assert.equal((await f.bridge.getState()).sessionDeletion, 'failed');
  assert.equal((await f.bridge.getState()).confirmedSessionDeletion, undefined);
  f.controls.operationStatus = 'succeeded';
  await f.remove();
  assert.equal((await f.bridge.getState()).sessionDeletion, 'deleted');
});

test('全新Main和preload先恢复持久失败删除占位，不创建默认讨论，明确重试才完成', async () => {
  const f = await fixture({ pendingDeletion: true });
  const state = await f.bridge.getState();
  assert.equal(state.sessionDeletion, 'failed'); assert.equal(state.savedSession.sessionId, f.sessionId);
  assert.equal(f.calls.some(request => request.path.endsWith('/assistant-session/default')), false);
  f.controls.deleteFailure = false;
  await f.remove();
  assert.equal((await f.bridge.getState()).sessionDeletion, 'deleted');
});

test('公开operation成功迟到跨连接世代时不能确认删除或回填当前视图', async () => {
  const f = await fixture();
  let release, enter;
  f.controls.deleteFailure = false;
  f.controls.operationBarrier = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; }); f.controls.operationEntered = enter;
  const removing = f.remove(); await entered;
  f.controls.generation = 8;
  release(); await removing;
  const state = await f.bridge.getState();
  assert.equal(state.confirmedSessionDeletion, undefined); assert.notEqual(state.sessionDeletion, 'deleted');
});
