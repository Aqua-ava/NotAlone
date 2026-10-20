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

async function fixture() {
  const ports = await portsPromise;
  const contactId = randomUUID(), sessionId = randomUUID();
  const controls = { deleteFailure: true, missing: false, sessionId, deleteBarrier: null };
  const calls = [], handlers = new Map();
  const backend = {
    getConnectionGeneration: () => 7,
    onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      if (request.method === 'DELETE') {
        if (controls.deleteBarrier) await controls.deleteBarrier;
        if (controls.deleteFailure) throw new ports.BackendRequestFailure('response', 503, 'unavailable');
        controls.missing = true;
        return { generation: 7, data: { session_id: sessionId, state: 'deleted' } };
      }
      if (request.path.endsWith('/assistant-session/default')) {
        return { generation: 7, data: { session_id: controls.sessionId } };
      }
      if (request.path.endsWith('/explorations') || request.path.endsWith('/replies')) {
        throw new ports.BackendRequestFailure('response', 503, 'controlled_generation_failure');
      }
      if (controls.missing && request.path.endsWith(sessionId)) {
        throw new ports.BackendRequestFailure('response', 404, 'not_found');
      }
      return { generation: 7, data: { session_id: controls.sessionId,
        current_input_version_id: null, turns: [], inputs: [] } };
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
  await bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await bridge.updatePurpose({ ...scope, purpose: '询问合成测试安排。' });
  const remove = () => bridge.deleteSavedSession({ ...scope, sessionId, confirmed: true });
  const generationCalls = () => calls.filter((request) => request.method === 'POST'
    && /\/(?:explorations|replies)(?:\/|$)/.test(request.path));
  return { bridge, scope, calls, controls, remove, generationCalls, sessionId };
}

for (const action of ['explore', 'changeDirections']) {
  test(`删除传输失败且同 SID 仍可读取时，${action} 不得打开策略生成入口`, async () => {
    const f = await fixture();
    await f.remove();
    assert.equal((await f.bridge.getState()).sessionDeletion, 'failed');
    const error = await f.bridge[action](f.scope).then(() => undefined, (failure) => failure);
    assert.equal(f.generationCalls().length, 0);
    assert.match(error?.message ?? '', /删除结果/);
    await f.bridge.retryExploration(f.scope);
    assert.equal(f.generationCalls().length, 0);
  });
}

test('删除尚在传输时，切换聊天模式后也不能打开策略入口', async () => {
  const f = await fixture();
  let release;
  f.controls.deleteBarrier = new Promise((resolve) => { release = resolve; });
  const deleting = f.remove();
  try {
    assert.equal((await f.bridge.getState()).sessionDeletion, 'deleting');
    const error = await f.bridge.explore(f.scope).then(() => undefined, (failure) => failure);
    assert.equal(f.generationCalls().length, 0);
    assert.match(error?.message ?? '', /删除结果/);
  } finally { release(); await deleting; }
});

test('删除失败仍允许精确重试和读取，确认旧 SID 不存在后新会话可以探索', async () => {
  const f = await fixture();
  await f.remove();
  await f.bridge.readSavedSession(f.scope);
  assert.equal((await f.bridge.getState()).sessionDeletion, 'failed');
  f.controls.deleteFailure = false;
  await f.remove();
  assert.equal((await f.bridge.getState()).sessionDeletion, 'deleted');
  f.controls.sessionId = randomUUID();
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.setMode({ ...f.scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...f.scope, purpose: '新会话中的合成安排。' });
  await f.bridge.explore(f.scope);
  assert.equal(f.generationCalls().length, 1);
  assert(f.generationCalls()[0].path.includes(f.controls.sessionId));
  assert(!f.generationCalls()[0].path.includes(f.sessionId));
});

test('删除工作区讨论后保留空白输入入口，不自动重建会话或保留上下文', async () => {
  const f = await fixture();
  await f.bridge.enterWorkspace(f.scope);
  const before = await f.bridge.getState();
  await f.bridge.updateOptions({ ...f.scope, options: { ...before.options,
    tone: 'polite', instruction: '删除时清除的合成要求。', includeRelationshipContext: true,
    contextText: '删除时清除的合成聊天。' } });
  const readsBefore = f.calls.filter(request => request.path.endsWith('/assistant-session/default')).length;
  f.controls.deleteFailure = false;
  await f.remove();
  const state = await f.bridge.getState();
  assert.equal(state.sessionDeletion, 'deleted');
  assert.equal(state.mode, 'rewrite_draft');
  assert.equal(state.options.inputKind, 'workspace');
  assert.equal(state.options.tone, 'original');
  assert.equal(state.options.instruction, '');
  assert.equal(state.options.includeRelationshipContext, false);
  assert.equal(state.options.contextText, undefined);
  assert.equal(state.savedSession.sessionId, null);
  assert.deepEqual(state.savedSession.turns, []);
  assert.equal(state.result, null);
  assert.equal(f.calls.filter(request => request.path.endsWith('/assistant-session/default')).length, readsBefore);
  assert.equal(f.generationCalls().length, 0);
});
