import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

async function adapter() {
  const output = await build({ entryPoints: ['src/main/reply/assistant-session-catalog.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}
function transport(data) {
  const calls = [];
  return { calls, requestJson: async (request) => { calls.push(request); return { generation: 7, data }; } };
}

test('空目录只有 GET，没有隐式创建或候选正文', async () => {
  const { listAssistantSessions } = await adapter();
  const backend = transport({ sessions: [], current_session_id: null }), contactId = randomUUID();
  assert.deepEqual(await listAssistantSessions(backend, contactId, new AbortController().signal),
    { items: [], currentSessionId: null, generation: 7 });
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].method, 'GET');
  assert.equal(backend.calls[0].path, `/api/contacts/${contactId}/assistant-sessions`);
});

test('显式新开与选择只发送空对象并核验返回的会话 ID', async () => {
  const { newAssistantSession, selectAssistantSession } = await adapter();
  const contactId = randomUUID(), sessionId = randomUUID(), signal = new AbortController().signal;
  const backend = transport({ session_id: sessionId });
  assert.deepEqual(await newAssistantSession(backend, contactId, signal), { sessionId, generation: 7 });
  assert.deepEqual(await selectAssistantSession(backend, contactId, sessionId, signal), { sessionId, generation: 7 });
  assert.deepEqual(backend.calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'POST', path: `/api/contacts/${contactId}/assistant-sessions`, body: {} },
    { method: 'POST', path: `/api/contacts/${contactId}/assistant-sessions/${sessionId}/select`, body: {} },
  ]);
  await assert.rejects(selectAssistantSession(transport({ session_id: randomUUID() }), contactId, sessionId, signal));
});

test('目录拒绝重复 ID、多个 current、错指针与意外正文', async () => {
  const { listAssistantSessions } = await adapter(), one = randomUUID(), two = randomUUID();
  const invalid = [
    { sessions: [{ session_id: one, is_current: false }, { session_id: one, is_current: false }], current_session_id: null },
    { sessions: [{ session_id: one, is_current: true }, { session_id: two, is_current: true }], current_session_id: one },
    { sessions: [{ session_id: one, is_current: true }], current_session_id: two },
    { sessions: [{ session_id: one, is_current: false }], current_session_id: one },
    { sessions: [{ session_id: one, is_current: false, title: '不应展示的正文' }], current_session_id: null },
    { sessions: [], current_session_id: null, text: '不应展示的正文' },
  ];
  for (const data of invalid) await assert.rejects(listAssistantSessions(transport(data), randomUUID(), new AbortController().signal));
});
