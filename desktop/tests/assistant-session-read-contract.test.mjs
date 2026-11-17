import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';

const output = await build({ entryPoints: ['src/main/reply/assistant-sessions.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false });
const { readAssistantSession } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const snapshot = () => ({ mode: 'sqlite', session_id: randomUUID(), runtime_recovery: 'unchecked', entries: [
  { entry_id: randomUUID(), position: '1', role: 'user', text: '当时明确输入的合成要求', request_id: randomUUID(), call_id: null, content_state: 'available' },
  { entry_id: randomUUID(), position: '2', role: 'assistant', text: '当时模型实际说出的合成发言', request_id: randomUUID(), call_id: randomUUID(), content_state: 'available' },
] });
function backend(data) {
  const calls = [];
  return { calls, getConnectionGeneration: () => 3,
    requestJson: async request => { calls.push(request); return { generation: 3, data }; } };
}

test('历史会话只读取实际发言，不加载旧生成轮次或改变当前会话', async () => {
  const value = snapshot(), transport = backend(value), contactId = randomUUID();
  const saved = await readAssistantSession(transport, contactId, value.session_id, new AbortController().signal);
  assert.deepEqual(saved.discussionEntries.map(entry => entry.text), value.entries.map(entry => entry.text));
  assert.equal(saved.runtimeRecovery, 'unchecked');
  assert.deepEqual(Object.keys(saved).sort(), ['discussionEntries', 'generation', 'runtimeRecovery', 'sessionId']);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].method, 'GET');
  assert.equal(transport.calls[0].path, `/api/contacts/${contactId}/assistant-sessions/${value.session_id}`);
});

test('会话读取拒绝旧turns/inputs及分片信封，不回落到另一套历史协议', async () => {
  const sessionId = randomUUID();
  for (const value of [
    { session_id: sessionId, turns: [], inputs: [], current_input_version_id: null },
    { session_id: sessionId, read_id: 'synthetic', payload_fragment: '{}', next_part: null },
    { ...snapshot(), session_id: sessionId, turns: [] },
  ]) {
    const transport = backend(value);
    await assert.rejects(readAssistantSession(transport, randomUUID(), sessionId, new AbortController().signal));
    assert.equal(transport.calls.length, 1);
  }
});

test('历史发言拒绝错误会话、重复条目和被清除后残留的正文或调用身份', async () => {
  for (const change of [
    value => { value.session_id = randomUUID(); },
    value => { value.entries[1].entry_id = value.entries[0].entry_id; },
    value => { value.entries[1].content_state = 'cleared'; },
    value => { value.entries[1].content_state = 'cleared'; value.entries[1].text = null; },
    value => { value.entries[1].position = '1'; },
    value => { value.owner_id = randomUUID(); },
  ]) {
    const value = snapshot(), sessionId = value.session_id; change(value);
    await assert.rejects(readAssistantSession(backend(value), randomUUID(), sessionId, new AbortController().signal));
  }
  const value = snapshot(); Object.assign(value.entries[1], { content_state: 'cleared', text: null, call_id: null });
  const saved = await readAssistantSession(backend(value), randomUUID(), value.session_id, new AbortController().signal);
  assert.deepEqual(saved.discussionEntries[1], { entryId: value.entries[1].entry_id, position: '2', role: 'assistant',
    text: null, requestId: value.entries[1].request_id, callId: null, contentState: 'cleared' });
});

test('连接身份不可用时不发起历史读取', async () => {
  const value = snapshot(), transport = backend(value); transport.getConnectionGeneration = () => undefined;
  await assert.rejects(readAssistantSession(transport, randomUUID(), value.session_id, new AbortController().signal),
    error => error.kind === 'cancelled');
  assert.equal(transport.calls.length, 0);
});
