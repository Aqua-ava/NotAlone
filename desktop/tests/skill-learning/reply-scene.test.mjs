import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { candidateVersionProtocol } from '../fixtures/assistant-candidate-version-protocol.mjs';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function replySceneFixture() {
  const ports = await portsPromise;
  const contactId = randomUUID(), otherContactId = randomUUID(), sessionId = randomUUID(), bindingId = randomUUID();
  const records = { generation: 1, calls: [], entries: [], discussions: [], executionBarrier: null, executionEntered: null, failExecution: false };
  const backendListeners = new Set(), handlers = new Map();
  const receipt = entry => ({ session_id: sessionId, turn_id: entry.turnId, request_key: entry.key,
    input_version_id: entry.inputId, state: entry.completed ? 'completed' : 'running' });
  const backend = {
    getConnectionGeneration: () => records.generation,
    onStateChanged: listener => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages: observer => observer.connected(),
    requestJson: async request => {
      records.calls.push(request);
      const generation = records.generation;
      if (request.path.endsWith('/assistant-session/default')) return { generation, data: { session_id: sessionId } };
      if (request.path.endsWith('/assistant-sessions')) return { generation, data: { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId } };
      if (request.path.endsWith('/selections')) return { generation, data: { selection: null } };
      if (request.path.endsWith('/continue/prepare') || request.path.endsWith('/retry-interrupted/prepare')) {
        const recovering = request.path.endsWith('/retry-interrupted/prepare');
        const key = recovering ? request.body.request_key : request.body.idempotency_key;
        let entry = records.entries.find(item => item.key === key);
        if (!entry) {
          const original = recovering ? records.entries.find(item => item.turnId === request.body.original_turn_id)
            : records.entries.find(item => item.inputId === request.body.expected_input_version_id);
          entry = { key, turnId: randomUUID(), inputId: randomUUID(), completed: false, input: structuredClone(original.input),
            reply: { reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '合成继续或恢复候选',
              basis: '原场景与明确本次意图', citation_ids: [], risk_notes: [] }], context_receipt: { evidence_ids: [], style_sample_ids: [] } } };
          if (recovering) entry.input.continuation = { recovery: { original_turn_id: request.body.original_turn_id,
            original_input_version_id: request.body.original_input_version_id } };
          else entry.continuation = { candidate_group_id: request.body.displayed_group.candidate_group_id,
            candidate_id: null, version_id: null, effective_requirements: [], effective_intent: { source: 'purpose' } };
          records.entries.push(entry);
        }
        return { generation, data: receipt(entry) };
      }
      if (request.path.endsWith('/continue') || request.path.endsWith('/retry-interrupted')) {
        const entry = records.entries.find(item => item.key === (request.body.request_key ?? request.body.idempotency_key));
        entry.completed = true;
        return { generation, data: { ...receipt(entry), ...entry.reply, ...(entry.continuation
          ? { continuation: entry.continuation, effective_input: entry.input.content, effective_scene: entry.input.scene ?? null }
          : { restored_input: entry.input }) } };
      }
      if (request.path.endsWith('/replies/prepare') || request.path.endsWith('/replace/prepare')) {
        const body = request.body.replacement ?? request.body;
        let entry = records.entries.find(item => item.key === body.idempotency_key);
        if (!entry) {
          entry = { key: body.idempotency_key, turnId: randomUUID(), inputId: randomUUID(), completed: false,
            input: { ...body, content: { ...body.content, ...(body.content.type === 'initiate_conversation' ? { purpose_source: 'direct_input' } : {}) },
              skill_disabled: body.skill_disabled ?? false, skill_version_id: body.skill_version_id ?? null },
            reply: { reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '合成当前候选',
              basis: '用户明确本次意图', citation_ids: [], risk_notes: [] }], context_receipt: { evidence_ids: [], style_sample_ids: [] } } };
          records.entries.push(entry);
        }
        return { generation, data: receipt(entry) };
      }
      if (request.path.endsWith('/replies') && request.method === 'POST') {
        const entry = records.entries.find(item => item.key === request.body.idempotency_key);
        if (records.executionBarrier) {
          const barrier = records.executionBarrier; records.executionBarrier = null;
          records.executionEntered?.resolve(); await barrier.promise;
        }
        if (records.failExecution) { records.failExecution = false; throw new ports.BackendRequestFailure('connection'); }
        entry.completed = true;
        return { generation, data: { ...receipt(entry), ...entry.reply } };
      }
      if (request.path.endsWith('/versions')) {
        const entry = records.entries.find(item => request.path.includes(item.reply.candidates[0].candidate_id));
        const candidate = entry.reply.candidates[0];
        return { generation, data: { session_id: sessionId, turn_id: entry.turnId, candidate_id: candidate.candidate_id,
          candidate_group_id: entry.reply.reply_request_id, candidate_number: 1, default_display_version_id: candidate.candidate_id,
          selected_version_id: null, versions: [{ version_id: candidate.candidate_id, version_number: 0, parent_version_id: null,
            text: candidate.text, messages: [{ message_id: randomUUID(), text: candidate.text }], requirements: null,
            created_at: '2026-10-15T01:00:00+00:00' }] } };
      }
      if (request.path.endsWith('/explorations')) {
        const inputId = randomUUID();
        records.discussions.push({ input_version_id: inputId, type: request.body.content.type, conversation_binding_id: bindingId,
          turn_id: null, state: 'active', placeholder: null, content: { ...request.body.content, answer: '', confirmed_intent: '' } });
        return { generation, data: { kind: 'directions', session_id: sessionId,
        exploration_id: randomUUID(), input_version_id: inputId, understanding: '合成理解', ambiguities: [], evidence: [],
        options: ['合成方向甲', '合成方向乙'].map(label => ({ suggestion_id: randomUUID(), label, intent: label,
          reason: '由用户选择', citation_ids: [], recommended: false, pause: false })), citation_ids: [], question: null,
        question_id: null, confirmed_intent: null, current_step: '', tradeoffs: [], used_skill: null, skill_choices: [] } };
      }
      assert.equal(request.method, 'GET'); assert.equal(request.path.endsWith(sessionId), true);
      return { generation, data: { session_id: sessionId, current_input_version_id: records.discussions.at(-1)?.input_version_id ?? records.entries.at(-1)?.inputId ?? null,
        turns: records.entries.map(entry => ({ turn_id: entry.turnId, input_version_id: entry.inputId, request_key: entry.key,
          state: entry.interrupted ? 'failed' : entry.completed ? 'completed' : 'running', interruption_reason: entry.interrupted ? 'app_quit' : null, placeholder: null, input: entry.input,
          reply: entry.completed ? entry.reply : null })),
        inputs: [...records.entries.map(entry => ({ input_version_id: entry.inputId, type: 'generation', conversation_binding_id: bindingId,
          turn_id: entry.turnId, state: 'active', content: null, placeholder: null })), ...records.discussions] } };
    },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: records.generation,
    contacts: [contactId, otherContactId].map(id => ({ contactId: id, displayName: '合成场景联系人', messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const replies = ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} },
    candidateVersionProtocol(backend), contacts);
  const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args), on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  await bridge.readSavedSession(scope());
  await bridge.setMode({ ...scope(), mode: 'initiate_conversation' });
  await bridge.updatePurpose({ ...scope(), purpose: '先核对安排，不增加承诺。' });
  return { records, bridge, replies, contacts, backendListeners, contactId, otherContactId, scope };
}

test('明确场景通过生产回复桥冻结进prepare与执行，同次重试沿原场景而新场景产生新输入', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    f.records.failExecution = true;
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    assert.equal(f.replies.getState().phase, 'failed');
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    const requests = f.records.calls.filter(request => request.path.endsWith('/replies'));
    assert.equal(requests[0].body.scene, '核对安排');
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    const latest = f.records.calls.filter(request => request.path.endsWith('/replies')).at(-1);
    assert.equal(latest.body.scene, '问候近况');
    assert.notEqual(latest.body.idempotency_key, requests[0].body.idempotency_key);
    assert.equal(f.replies.getState().result.input.scene, '问候近况');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

for (const transition of ['编辑场景', '切换联系人', '后端重连']) {
  test(`${transition}后旧场景的迟到生成不能进入当前候选`, async () => {
    const f = await replySceneFixture();
    const barrier = Promise.withResolvers(), entered = Promise.withResolvers();
    try {
      await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
      f.records.executionBarrier = barrier; f.records.executionEntered = entered;
      const generating = f.bridge.generate({ ...f.scope(), newRequest: false });
      await entered.promise;
      if (transition === '编辑场景') await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
      else if (transition === '切换联系人') f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
      else { f.records.generation = 2; for (const listener of f.backendListeners) listener(); }
      barrier.resolve(); await generating;
      assert.equal(f.replies.getState().result, null);
      assert.equal(f.replies.getState().scene, transition === '编辑场景' ? '问候近况' : '');
    } finally { barrier.resolve(); await f.replies.beginGenerationClosing(() => {}); }
  });
}

test('重读已保存方向讨论保留原精确场景，旧无场景记录继续可读', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.explore(f.scope());
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.explore(f.scope());
    await f.bridge.readSavedSession(f.scope());
    const saved = f.replies.getState().savedSession;
    assert.equal(saved.phase, 'ready');
    assert.equal(saved.inputs.at(-1).content.skillScene, '核对安排');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('中断重试重建权威原场景并保留当前新输入，恢复请求不能夹带编辑场景', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    const original = f.records.entries[0]; original.completed = false; original.interrupted = true;
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    await f.bridge.retryInterruptedGeneration({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId,
      turnId: original.turnId, inputVersionId: original.inputId });
    assert.equal(f.replies.getState().phase, 'ready');
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    assert.equal(f.replies.getState().scene, '问候近况');
    const recovering = f.records.calls.filter(request => request.path.includes('/retry-interrupted'));
    assert.equal(recovering.length, 2);
    assert(recovering.every(request => !Object.hasOwn(request.body, 'scene')));
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('连续修改沿权威原场景生成并展示，当前新场景不会套到旧输入', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    await f.bridge.continueSession({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId, instruction: '简短一点' });
    assert.equal(f.replies.getState().continuation.phase, 'completed');
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    assert.equal(f.replies.getState().scene, '问候近况');
    const continuing = f.records.calls.filter(request => request.path.includes('/continue'));
    assert.equal(continuing.length, 2);
    assert(continuing.every(request => !Object.hasOwn(request.body, 'scene')));
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('联系人往返恢复各自精确场景，后端重连先清缓存且未声明场景保持缺省行为', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    assert.equal(Object.hasOwn(f.records.calls.find(request => request.path.endsWith('/replies')).body, 'scene'), false);
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '');
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '核对安排');
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '问候近况');
    f.records.generation = 2;
    for (const listener of f.backendListeners) listener();
    assert.equal(f.replies.getState().scene, '');
    await assert.rejects(f.bridge.updateScene({ ...f.scope(), scene: '核对安排', owner_id: f.contactId }));
    await assert.rejects(f.bridge.updateScene({ ...f.scope(), scene: '长'.repeat(257) }));
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('方向探索使用独立精确场景声明，编辑场景使旧探索失效且不把模式当适用范围', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.explore(f.scope());
    const first = f.records.calls.find(request => request.path.endsWith('/explorations'));
    assert.equal(first.body.content.skill_scene, '核对安排');
    assert.equal(first.body.content.type, 'purpose_exploration');
    assert.equal(f.replies.getState().exploration.phase, 'ready');
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    assert.equal(f.replies.getState().exploration.result, null);
    await f.bridge.explore(f.scope());
    const second = f.records.calls.filter(request => request.path.endsWith('/explorations')).at(-1);
    assert.equal(second.body.content.skill_scene, '问候近况');
    assert.notEqual(second.body.operation_key, first.body.operation_key);
    assert.equal(second.body.previous_id, null);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('甲任务在乙展示时完成，往返恢复甲的原场景及权威结果且不重复生成', async () => {
  const f = await replySceneFixture(), barrier = Promise.withResolvers(), entered = Promise.withResolvers();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    f.records.executionBarrier = barrier; f.records.executionEntered = entered;
    const generating = f.bridge.generate({ ...f.scope(), newRequest: false });
    await entered.promise;
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    barrier.resolve(); await generating;
    assert.equal(f.replies.getState().result, null);
    assert.equal(f.replies.getState().scene, '问候近况');
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '核对安排');
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    assert.equal(f.records.calls.filter(request => request.path.endsWith('/replies/prepare')).length, 1);
    assert.equal(f.records.calls.filter(request => request.path.endsWith('/replies')).length, 1);
  } finally { barrier.resolve(); await f.replies.beginGenerationClosing(() => {}); }
});
