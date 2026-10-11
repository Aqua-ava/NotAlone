import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { candidateVersionProtocol } from '../fixtures/assistant-candidate-version-protocol.mjs';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { StyleSampleController } from './src/main/style-samples/controller';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then((output) => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

// 只替换HTTP传输；会话、版本解析、具名桥接与样本来源控制均运行生产实现。
async function fixture() {
  const ports = await portsPromise;
  const contactId = randomUUID(), sessionId = randomUUID(), candidateId = randomUUID(), versionId = randomUUID();
  const turnId = randomUUID(), inputVersionId = randomUUID(), requestId = randomUUID();
  const firstMessageId = randomUUID(), secondMessageId = randomUUID();
  const records = {
    history: { session_id: sessionId, turn_id: turnId, candidate_id: candidateId,
      candidate_group_id: requestId, candidate_number: 1, default_display_version_id: versionId,
      selected_version_id: versionId, versions: [
        { version_id: candidateId, version_number: 0, parent_version_id: null,
          text: '这次不参加。\n\n感谢邀请。',
          messages: [{ message_id: firstMessageId, text: '这次不参加。' }, { message_id: secondMessageId, text: '感谢邀请。' }],
          requirements: null, created_at: '2026-10-11T01:00:00+00:00' },
        { version_id: versionId, version_number: 1, parent_version_id: candidateId,
          text: '这次不参加。\n\n谢谢理解。',
          messages: [{ message_id: firstMessageId, text: '这次不参加。' }, { message_id: secondMessageId, text: '谢谢理解。' }],
          requirements: '仍然拒绝，改成短句。', created_at: '2026-10-11T01:01:00+00:00' },
      ] },
    selection: { selection_id: randomUUID(), selection_number: 1, session_id: sessionId,
      candidate_id: candidateId, version_id: versionId },
    saved: { session_id: sessionId, current_input_version_id: inputVersionId,
      turns: [{ turn_id: turnId, input_version_id: inputVersionId, request_key: randomUUID(), state: 'completed',
        input: { content: { type: 'rewrite_draft', draft_text: '这次不参加。' } }, placeholder: null,
        reply: { reply_request_id: requestId,
          candidates: [{ candidate_id: candidateId, text: '这次不参加。\n\n感谢邀请。',
            messages: [{ message_id: firstMessageId, text: '这次不参加。' }, { message_id: secondMessageId, text: '感谢邀请。' }],
            basis: '保留本次明确拒绝。', citation_ids: [], risk_notes: [] }], context_receipt: { evidence_ids: [] } } }],
      inputs: [{ input_version_id: inputVersionId, type: 'generation', conversation_binding_id: randomUUID(),
        turn_id: turnId, state: 'active', content: null, placeholder: null }],
    },
    samples: [],
  };
  const calls = [], handlers = new Map();
  const backend = {
    getConnectionGeneration: () => 7,
    onStateChanged: () => () => {},
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      let data;
      if (request.path.endsWith('/assistant-session/default')) data = { session_id: sessionId };
      else if (request.method === 'POST' && request.path.endsWith('/replies/prepare')) {
        const turn = records.saved.turns[0];
        turn.request_key = request.body.idempotency_key;
        data = { session_id: sessionId, turn_id: turnId, request_key: turn.request_key,
          input_version_id: inputVersionId, state: turn.state };
      }
      else if (request.method === 'POST' && request.path.endsWith('/replies')) {
        const turn = records.saved.turns[0];
        turn.request_key = request.body.idempotency_key;
        data = { ...turn.reply, session_id: sessionId, turn_id: turnId, input_version_id: inputVersionId, state: 'completed' };
      }
      else if (request.path.endsWith('/versions')) {
        await records.beforeVersionResponse?.(request);
        if (records.versionFailure) throw records.versionFailure;
        data = records.extraHistories?.find((history) => request.path.includes(`/${history.candidate_id}/`)) ?? records.history;
      } else if (request.path.endsWith('/selections')) data = request.method === 'POST' ? records.selection : { selection: records.selection };
      else if (request.path.endsWith('/style-samples')) {
        if (request.method === 'POST') {
          const sample = { sample_id: randomUUID(), text: request.body.text, origin_kind: request.body.origin.kind,
            origin_id: request.body.origin.id ?? null, source_ids: [], saved_at: '2026-10-11T01:02:00+00:00', sending_status: 'unknown' };
          records.samples.push(sample);
          data = { sample };
        } else data = { samples: records.samples };
      } else if (request.path.endsWith('/evidence')) data = { reply_request_id: requestId, evidence: [] };
      else {
        assert.equal(request.method, 'GET');
        assert.equal(request.path, `/api/contacts/${contactId}/assistant-sessions/${sessionId}`);
        data = records.saved;
      }
      return { generation: 7, data: structuredClone(data) };
    },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: 7,
    contacts: [{ contactId, displayName: '合成版本来源联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, candidateVersionProtocol(backend), contacts);
  const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args),
    on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await bridge.readSavedSession(scope);
  const samples = new ports.StyleSampleController(backend, contacts, replies);
  return { ...ports, bridge, replies, contacts, backend, samples, records, calls, scope,
    sessionId, candidateId, versionId, turnId, requestId, secondMessageId };
}

function pasteVersionMessage(f, text = '谢谢理解。') {
  f.samples.noteCandidateCopy({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text });
  const { pasteId } = f.samples.noteManualPaste({ ...f.scope, text });
  f.samples.updateManualText({ ...f.scope, text, pasteId, pastedText: text });
}

test('恢复后已保存编辑版的组内消息可主动保存样本且保留候选来源', async () => {
  const f = await fixture();
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.turns[0].reply.replyRequestId, f.requestId);
  assert.equal(state.candidateVersions.items[0].history.versions[1].messages[1].text, '谢谢理解。');
  assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
  pasteVersionMessage(f);
  f.samples.updateManualText({ ...f.scope, text: '谢谢理解。先这样。' });
  await f.samples.saveManual({ ...f.scope, text: '谢谢理解。先这样。' });
  assert.deepEqual(f.samples.getState().samples.map(({ text, originKind, originId, sendingStatus }) =>
    ({ text, originKind, originId, sendingStatus })), [{ text: '谢谢理解。先这样。',
    originKind: 'candidate', originId: f.candidateId, sendingStatus: 'unknown' }]);
  const writes = f.calls.filter((request) => request.method === 'POST' && request.path.endsWith('/style-samples'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.origin, { kind: 'candidate', id: f.candidateId });
});

test('本轮原候选与完成历史并存时仍能复验同候选的已保存编辑消息', async () => {
  const f = await fixture();
  await f.bridge.setMode({ ...f.scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...f.scope, purpose: '本次拒绝参加，不新增承诺。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.result.replyRequestId, f.requestId);
  assert.equal(state.result.candidates[0].editedText, '这次不参加。\n\n感谢邀请。');
  assert.equal(state.savedSession.turns[0].reply.replyRequestId, f.requestId);
  pasteVersionMessage(f);
  await f.samples.saveManual({ ...f.scope, text: '谢谢理解。' });
  assert.equal(f.samples.getState().samples[0].originKind, 'candidate');
  assert.equal(f.samples.getState().samples[0].originId, f.candidateId);
});

test('可信版本的轮次或请求与实际完成候选不符时拒绝保存且不降为manual', async (t) => {
  for (const field of ['turn_id', 'candidate_group_id']) await t.test(field, async () => {
    const f = await fixture();
    f.records.history[field] = randomUUID();
    await f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId });
    assert.equal((await f.bridge.getState()).candidateVersions.phase, 'ready');
    assert.throws(() => pasteVersionMessage(f), /复制来历已失效/);
    assert.throws(() => f.samples.noteManualPaste({ ...f.scope, text: '谢谢理解。' }), /无法核验粘贴来源/);
    await assert.rejects(f.samples.saveManual({ ...f.scope, text: '谢谢理解。' }));
    assert.equal(f.records.samples.length, 0);
    f.samples.updateManualText({ ...f.scope, text: '' });
    f.samples.updateManualText({ ...f.scope, text: '新独立键入的合成表达。' });
    await f.samples.saveManual({ ...f.scope, text: '新独立键入的合成表达。' });
    assert.equal(f.samples.getState().samples[0].originKind, 'manual');
  });
});

test('A确认版本来源失效后清除未保存表达来历并拒绝旧片段', async () => {
  const f = await fixture();
  pasteVersionMessage(f);
  f.samples.updateManualText({ ...f.scope, text: '谢谢理解。先这样。' });
  const before = f.samples.getState().erasureRevision;
  const turn = f.records.saved.turns[0];
  f.records.saved.turns[0] = { ...turn, state: 'redacted', input: null, reply: null, placeholder: '相关来源已删除' };
  f.records.saved.inputs[0] = { ...f.records.saved.inputs[0], state: 'redacted', content: null, placeholder: '相关来源已删除' };
  f.records.saved.current_input_version_id = null;
  f.records.selection = null;
  f.records.versionFailure = new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
  await assert.rejects(f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId }), /候选来源暂不可用/);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.turns[0].state, 'redacted');
  assert(!JSON.stringify(state).includes('谢谢理解。'));
  assert(f.samples.getState().erasureRevision > before);
  assert.throws(() => pasteVersionMessage(f), /复制来历已失效/);
  await assert.rejects(f.samples.saveManual({ ...f.scope, text: '谢谢理解。先这样。' }));
  assert.equal(f.records.samples.length, 0);
  f.samples.updateManualText({ ...f.scope, text: '' });
  f.samples.updateManualText({ ...f.scope, text: '失效后独立键入的合成表达。' });
  await f.samples.saveManual({ ...f.scope, text: '失效后独立键入的合成表达。' });
  assert.equal(f.samples.getState().samples[0].originKind, 'manual');
});

test('普通版本读取失败不冒充删除，重新读取后可复验原编辑来源', async () => {
  const f = await fixture();
  pasteVersionMessage(f);
  const before = f.samples.getState().erasureRevision;
  f.records.versionFailure = new f.BackendRequestFailure('connection');
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
  await assert.rejects(f.bridge.readCandidateVersions(identity), /候选版本暂不可用/);
  assert.equal((await f.bridge.getState()).candidateVersions.phase, 'failed');
  assert.equal(f.samples.getState().erasureRevision, before);
  assert.throws(() => f.samples.noteCandidateCopy({ ...f.scope, replyRequestId: f.requestId,
    candidateId: f.candidateId, text: '谢谢理解。' }), /复制来历已失效/);
  assert.throws(() => f.samples.noteManualPaste({ ...f.scope, text: '谢谢理解。' }), /无法核验粘贴来源/);
  assert.equal(f.records.samples.length, 0);
  f.records.versionFailure = null;
  await f.bridge.readCandidateVersions(identity);
  f.samples.updateManualText({ ...f.scope, text: '' });
  pasteVersionMessage(f);
  await f.samples.saveManual({ ...f.scope, text: '谢谢理解。' });
  assert.equal(f.samples.getState().samples[0].originKind, 'candidate');
  assert.equal(f.samples.getState().samples[0].originId, f.candidateId);
});

async function multipleCandidates() {
  const f = await fixture();
  const otherCandidateId = randomUUID(), otherMessageId = randomUUID();
  const other = { candidate_id: otherCandidateId, text: '另一合成说法。',
    messages: [{ message_id: otherMessageId, text: '另一合成说法。' }],
    basis: '另一候选同一完成请求。', citation_ids: [], risk_notes: [] };
  f.records.saved.turns[0].reply.candidates.push(other);
  f.records.extraHistories = [{ ...f.records.history, candidate_id: otherCandidateId, candidate_number: 2,
    default_display_version_id: otherCandidateId, selected_version_id: null,
    versions: [{ version_id: otherCandidateId, version_number: 0, parent_version_id: null,
      text: other.text, messages: other.messages, requirements: null, created_at: '2026-10-11T01:00:00+00:00' }] }];
  await f.bridge.readSavedSession(f.scope);
  const otherIdentity = { ...f.scope, sessionId: f.sessionId, candidateId: otherCandidateId };
  await f.bridge.readCandidateVersions(otherIdentity);
  pasteVersionMessage(f);
  return { f, otherIdentity };
}

test('另一候选普通读取失败不能永久拒绝已核实的编辑片段', async () => {
  const { f, otherIdentity } = await multipleCandidates();
  const before = f.samples.getState().erasureRevision;
  f.records.versionFailure = new f.BackendRequestFailure('connection');
  await assert.rejects(f.bridge.readCandidateVersions(otherIdentity), /候选版本暂不可用/);
  const state = await f.bridge.getState();
  assert.equal(state.candidateVersions.phase, 'failed');
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).phase, 'ready');
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === otherIdentity.candidateId).phase, 'failed');
  assert.equal(f.samples.getState().erasureRevision, before);
  // 全局故障期间仍拒绝复制和粘贴，不能据另一候选普通故障永久作废已知合法摘要。
  assert.throws(() => f.samples.noteCandidateCopy({ ...f.scope, replyRequestId: f.requestId,
    candidateId: f.candidateId, text: '谢谢理解。' }), /复制来历已失效/);
  assert.throws(() => f.samples.noteManualPaste({ ...f.scope, text: '谢谢理解。' }), /无法核验粘贴来源/);
  f.records.versionFailure = null;
  await f.bridge.readCandidateVersions(otherIdentity);
  await f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId });
  f.samples.updateManualText({ ...f.scope, text: '' });
  pasteVersionMessage(f);
  await f.samples.saveManual({ ...f.scope, text: '谢谢理解。' });
  assert.equal(f.samples.getState().samples[0].originKind, 'candidate');
  assert.equal(f.samples.getState().samples[0].originId, f.candidateId);
});

test('另一候选仍在读取时不能永久拒绝已核实的编辑片段', async () => {
  const { f, otherIdentity } = await multipleCandidates();
  let releaseRead, signalEntered;
  const blocked = new Promise((resolve) => { releaseRead = resolve; });
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  f.records.beforeVersionResponse = async (request) => {
    assert(request.path.includes(`/${otherIdentity.candidateId}/`));
    signalEntered();
    await blocked;
  };
  const pending = f.bridge.readCandidateVersions(otherIdentity);
  await entered;
  try {
    const state = await f.bridge.getState();
    assert.equal(state.candidateVersions.phase, 'loading');
    assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).phase, 'ready');
    assert.throws(() => f.samples.noteCandidateCopy({ ...f.scope, replyRequestId: f.requestId,
      candidateId: f.candidateId, text: '谢谢理解。' }), /复制来历已失效/);
    assert.throws(() => f.samples.noteManualPaste({ ...f.scope, text: '谢谢理解。' }), /无法核验粘贴来源/);
  } finally {
    releaseRead();
    await pending;
    f.records.beforeVersionResponse = undefined;
  }
  f.samples.updateManualText({ ...f.scope, text: '' });
  pasteVersionMessage(f);
  await f.samples.saveManual({ ...f.scope, text: '谢谢理解。' });
  assert.equal(f.samples.getState().samples[0].originKind, 'candidate');
  assert.equal(f.samples.getState().samples[0].originId, f.candidateId);
});

test('失败读取后的明确无效选区或来源终态仍不能被重试解除', async (t) => {
  for (const terminal of ['invalid_selection', 'source_unavailable']) await t.test(terminal, async () => {
    const f = await fixture();
    pasteVersionMessage(f);
    f.records.versionFailure = new f.BackendRequestFailure('connection');
    const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
    await assert.rejects(f.bridge.readCandidateVersions(identity));
    assert.throws(() => f.samples.noteCandidateCopy({ ...f.scope, replyRequestId: f.requestId,
      candidateId: f.candidateId, text: '谢谢理解。', invalidSelection: terminal === 'invalid_selection' }), /复制来历已失效/);
    if (terminal === 'invalid_selection') {
      f.records.versionFailure = null;
      await f.bridge.readCandidateVersions(identity);
      f.samples.updateManualText({ ...f.scope, text: '' });
      f.samples.noteCandidateCopy({ ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId, text: '谢谢理解。' });
    } else {
      const turn = f.records.saved.turns[0];
      f.records.saved.turns[0] = { ...turn, state: 'redacted', input: null, reply: null, placeholder: '相关来源已删除' };
      f.records.saved.inputs[0] = { ...f.records.saved.inputs[0], state: 'redacted', content: null, placeholder: '相关来源已删除' };
      f.records.saved.current_input_version_id = null;
      f.records.selection = null;
      f.records.versionFailure = new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
      await assert.rejects(f.bridge.readCandidateVersions(identity));
      f.samples.updateManualText({ ...f.scope, text: '' });
      assert.throws(() => pasteVersionMessage(f), /复制来历已失效/);
    }
    assert.throws(() => f.samples.noteManualPaste({ ...f.scope, text: '谢谢理解。' }), /无法核验粘贴来源/);
    await assert.rejects(f.samples.saveManual({ ...f.scope, text: '谢谢理解。' }));
    assert.equal(f.records.samples.length, 0);
  });
});
