import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

async function adapter(path) {
  const output = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

test('公开读取适配器保留纯讨论与当前输入 UUID，不生成候选', async () => {
  const { readAssistantSession } = await adapter('src/main/reply/assistant-sessions.ts');
  const sessionId = randomUUID(), inputId = randomUUID(), bindingId = randomUUID();
  const content = { type: 'purpose_exploration', purpose_hint: '合成旧讨论', correction: '', requirements: '不作承诺',
    answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null };
  const backend = { requestJson: async () => ({ generation: 3, data: {
    session_id: sessionId, current_input_version_id: inputId, turns: [], inputs: [{
      input_version_id: inputId, type: 'purpose_exploration', conversation_binding_id: bindingId,
      turn_id: null, state: 'active', content, placeholder: null,
    }],
  } }) };
  const saved = await readAssistantSession(backend, randomUUID(), sessionId, new AbortController().signal);
  assert.equal(saved.currentInputVersionId, inputId);
  assert.equal(saved.inputs[0].content.purposeHint, '合成旧讨论');
  assert.equal(saved.inputs[0].content.requirements, '不作承诺');
  assert.deepEqual(saved.turns, []);
});

function discussionSnapshot() {
  const inputId = randomUUID();
  return { session_id: randomUUID(), current_input_version_id: inputId, turns: [], inputs: [{
    input_version_id: inputId, type: 'response_exploration', conversation_binding_id: randomUUID(),
    turn_id: null, state: 'active', content: { type: 'response_exploration', target_message_id: randomUUID(),
      correction: '', requirements: '', answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null }, placeholder: null,
  }] };
}
function transport(data) { return { requestJson: async () => ({ generation: 3, data }) }; }
test('只读输入拒绝外来会话、未知 current、重复输入与删除后正文', async () => {
  const { readAssistantSession } = await adapter('src/main/reply/assistant-sessions.ts');
  for (const change of [
    (value) => { value.current_input_version_id = randomUUID(); },
    (value) => { value.inputs.push(value.inputs[0]); },
    (value) => { value.inputs[0].conversation_binding_id = 'invalid'; },
    (value) => { value.inputs[0].content.target_message_id = 'invalid'; },
    (value) => { value.inputs[0].state = 'redacted'; value.inputs[0].placeholder = '相关来源已删除'; },
    (value) => { value.inputs[0].turn_id = randomUUID(); },
  ]) {
    const data = discussionSnapshot(); change(data);
    await assert.rejects(readAssistantSession(transport(data), randomUUID(), data.session_id, new AbortController().signal));
  }
  const data = discussionSnapshot();
  await assert.rejects(readAssistantSession(transport(data), randomUUID(), randomUUID(), new AbortController().signal));
});
test('已删除和不可用输入只返回占位，不恢复原讨论正文', async () => {
  const { readAssistantSession } = await adapter('src/main/reply/assistant-sessions.ts');
  for (const state of ['redacted', 'unavailable']) {
    const data = discussionSnapshot(), input = data.inputs[0];
    input.state = state; input.content = null; input.placeholder = state === 'redacted' ? '相关来源已删除' : '相关来源不可用';
    const read = await readAssistantSession(transport(data), randomUUID(), data.session_id, new AbortController().signal);
    assert.equal(read.inputs[0].state, state); assert.equal(read.inputs[0].content, null);
    assert.equal(read.inputs[0].placeholder, input.placeholder); assert.deepEqual(read.turns, []);
  }
});
test('严格只读输入拒绝意外协议字段', async () => {
  const { readAssistantSession } = await adapter('src/main/reply/assistant-sessions.ts');
  const data = discussionSnapshot(); data.inputs[0].owner_id = randomUUID();
  await assert.rejects(readAssistantSession(transport(data), randomUUID(), data.session_id, new AbortController().signal));
});
test('generation 输入与轮次一一关联，来源删除状态不能伪装 active', async () => {
  const { readAssistantSession } = await adapter('src/main/reply/assistant-sessions.ts');
  const data = discussionSnapshot(), inputId = data.inputs[0].input_version_id, turnId = randomUUID();
  data.turns = [{ turn_id: turnId, input_version_id: inputId, request_key: randomUUID(), state: 'redacted',
    input: null, reply: null, placeholder: '相关来源已删除' }];
  data.inputs[0] = { ...data.inputs[0], type: 'generation', turn_id: turnId, state: 'redacted', content: null, placeholder: '相关来源已删除' };
  const read = await readAssistantSession(transport(data), randomUUID(), data.session_id, new AbortController().signal);
  assert.equal(read.inputs[0].turnId, read.turns[0].turnId); assert.equal(read.inputs[0].content, null);
  data.inputs[0].state = 'active'; data.inputs[0].placeholder = null;
  await assert.rejects(readAssistantSession(transport(data), randomUUID(), data.session_id, new AbortController().signal));
});
