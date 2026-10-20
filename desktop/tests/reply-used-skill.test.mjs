import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { candidateVersionProtocol } from './fixtures/assistant-candidate-version-protocol.mjs';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then((output) => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function generate(usedSkill, disabled = false) {
  const ports = await portsPromise;
  const contactId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), bindingId = randomUUID();
  const calls = [], handlers = new Map();
  let input = null, requestKey = null, completed = false;
  const receipt = () => ({ session_id: sessionId, turn_id: turnId, request_key: requestKey,
    input_version_id: result.input_version_id, state: completed ? 'completed' : 'running' });
  const result = { session_id: sessionId, state: 'completed', input_version_id: randomUUID(),
    reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '本次合成明确拒绝。',
      basis: '仅本次明确意图。', citation_ids: [], risk_notes: [] }],
    context_receipt: { evidence_ids: [], },
    ...(usedSkill === undefined ? {} : { used_skill: usedSkill }) };
  const backend = {
    getConnectionGeneration: () => 7,
    onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      if (request.path.endsWith('/replies/prepare')) {
        input = structuredClone(request.body); requestKey = request.body.idempotency_key;
        return { generation: 7, data: receipt() };
      }
      if (request.method === 'POST' && request.path.endsWith('/replies')) {
        completed = true;
        return { generation: 7, data: { ...result, ...receipt() } };
      }
      if (request.path.endsWith('/assistant-sessions')) return { generation: 7,
        data: { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId } };
      if (request.path.endsWith('/assistant-session/default')) return { generation: 7, data: { session_id: sessionId } };
      if (request.path.endsWith('/selections')) return { generation: 7, data: { selection: null } };
      if (request.path.endsWith('/versions')) {
        const candidate = result.candidates[0];
        return { generation: 7, data: { session_id: sessionId, turn_id: turnId, candidate_id: candidate.candidate_id,
          candidate_group_id: result.reply_request_id, candidate_number: 1, default_display_version_id: candidate.candidate_id,
          selected_version_id: null, versions: [{ version_id: candidate.candidate_id, version_number: 0, parent_version_id: null,
            text: candidate.text, messages: [{ message_id: randomUUID(), text: candidate.text }], requirements: null,
            created_at: '2026-10-15T01:00:00+00:00' }] } };
      }
      assert.equal(request.method, 'GET');
      assert(request.path.endsWith(sessionId));
      return { generation: 7, data: { session_id: sessionId, current_input_version_id: input ? result.input_version_id : null,
        turns: input ? [{ ...receipt(), input, reply: completed ? result : null, interruption_reason: null, placeholder: null }] : [],
        inputs: input ? [{ input_version_id: result.input_version_id, type: 'generation', conversation_binding_id: bindingId,
          turn_id: turnId, state: 'active', content: null, placeholder: null }] : [] } };
    },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成实际Skill回执联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, candidateVersionProtocol(backend), contacts);
  const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args),
    on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await bridge.readSavedSession(scope);
  await bridge.setMode({ ...scope, mode: 'initiate_conversation' });
  await bridge.updatePurpose({ ...scope, purpose: '本次明确拒绝，不增加承诺。' });
  if (disabled) await bridge.updateSkill({ ...scope, skill: { mode: 'disabled', versionId: null } });
  await bridge.generate({ ...scope, newRequest: false });
  await replies.beginGenerationClosing(() => {});
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

test('公开候选保留实际执行视图凭证，损坏凭证不能成为有效结果', async () => {
  const receipt = { skill_id: randomUUID(), version_id: randomUUID(), name: '合成已筛选策略', load_state: 'loaded',
    execution_view: { policy_revision: 3, method_ids: [randomUUID()], sha256: 'a'.repeat(64) } };
  const valid = await generate(receipt);
  assert.deepEqual(valid.state.result.usedSkill.executionView, {
    policyRevision: 3, methodIds: receipt.execution_view.method_ids, sha256: 'a'.repeat(64) });
  const invalid = await generate({ ...receipt, execution_view: { ...receipt.execution_view, sha256: 'bad' } });
  assert.notEqual(invalid.state.phase, 'ready');
  assert.equal(invalid.state.result, null);
});

test('实际Skill回执保留后端确认的版本号与精确发布范围', async () => {
  const versionId = randomUUID();
  const scope = { kind: 'scene', contact_id: null, scene: '核对安排' };
  const receipt = { skill_id: randomUUID(), version_id: versionId, name: '合成审核发布Skill', load_state: 'loaded', version_number: 3, scope };
  const { state } = await generate(receipt);
  assert.deepEqual(state.result.usedSkill, { name: receipt.name, versionId, loadState: 'loaded', versionNumber: 3, scope });
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
