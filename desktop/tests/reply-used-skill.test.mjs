import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then((output) => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function generate(usedSkill, disabled = false) {
  const ports = await portsPromise;
  const contactId = randomUUID(), sessionId = randomUUID();
  const calls = [], handlers = new Map();
  const result = { session_id: sessionId, state: 'completed', input_version_id: randomUUID(),
    reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '本次合成明确拒绝。',
      basis: '仅本次明确意图。', citation_ids: [], risk_notes: [] }],
    context_receipt: { evidence_ids: [], style_sample_ids: [] },
    ...(usedSkill === undefined ? {} : { used_skill: usedSkill }) };
  const backend = {
    getConnectionGeneration: () => 7,
    onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      if (request.method === 'POST' && request.path.endsWith('/replies')) return { generation: 7, data: result };
      if (request.path.endsWith('/assistant-sessions')) return { generation: 7,
        data: { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId } };
      if (request.path.endsWith('/assistant-session/default')) return { generation: 7, data: { session_id: sessionId } };
      assert.equal(request.method, 'GET');
      assert(request.path.endsWith(sessionId));
      return { generation: 7, data: { session_id: sessionId, current_input_version_id: null, turns: [], inputs: [] } };
    },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成实际Skill回执联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, backend, contacts);
  const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args),
    on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await bridge.readSavedSession(scope);
  await bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await bridge.updatePurpose({ ...scope, purpose: '本次明确拒绝，不增加承诺。' });
  if (disabled) await bridge.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
  await bridge.generate({ ...scope, newRequest: false });
  const generationCalls = calls.filter((request) => request.method === 'POST' && request.path.endsWith('/replies'));
  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].path, `/api/contacts/${contactId}/assistant-sessions/${sessionId}/replies`);
  assert.equal(generationCalls[0].body.content.purpose, '本次明确拒绝，不增加承诺。');
  return { state: await bridge.getState(), request: generationCalls[0], result };
}

test('公开候选状态保留后端实际Skill名称、不可变版本与加载状态', async () => {
  const versionId = randomUUID();
  const receipt = { skill_id: randomUUID(), version_id: versionId, name: '合成表达Skill', load_state: 'loaded' };
  const { state, result } = await generate(receipt);
  assert.equal(state.phase, 'ready');
  assert.equal(state.result.replyRequestId, result.reply_request_id);
  assert.deepEqual(state.result.usedSkill, { name: receipt.name, versionId, loadState: 'loaded' });
});

test('实际Skill部分资源失败仍保留原版本和状态，不显示为成功加载', async () => {
  const versionId = randomUUID();
  const receipt = { skill_id: randomUUID(), version_id: versionId, name: '合成部分资源Skill', load_state: 'resource_failed' };
  const { state } = await generate(receipt);
  assert.equal(state.phase, 'ready');
  assert.deepEqual(state.result.usedSkill, { name: receipt.name, versionId, loadState: 'resource_failed' });
});

test('显式关闭Skill的实际null回执保持通用流程，不补选策略', async () => {
  const { state, request } = await generate(null, true);
  assert.equal(request.body.skill_disabled, true);
  assert.equal(state.phase, 'ready');
  assert.equal(state.result.usedSkill, null);
});

test('无实际Skill字段的旧回执仍可读取，不推断已使用策略', async () => {
  const { state } = await generate(undefined);
  assert.equal(state.phase, 'ready');
  assert.equal(state.result.usedSkill, undefined);
});

test('实际Skill版本身份无效时拒绝整份结果，不静默丢弃metadata后发布候选', async () => {
  const receipt = { skill_id: randomUUID(), version_id: 'invalid', name: '合成无效身份Skill', load_state: 'loaded' };
  const { state } = await generate(receipt);
  assert.equal(state.phase, 'failed');
  assert.equal(state.result, null);
});
