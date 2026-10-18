import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { build } from 'esbuild';
import { candidateVersionProtocol } from './fixtures/assistant-candidate-version-protocol.mjs';

async function publicPorts() {
  const output = await build({ stdin: { contents: `
    export { ContactSession } from './src/main/contacts/session';
    export { installReplyBridge } from './src/main/reply/bridge';
    export { createReplyBridge } from './src/preload/reply';
    export { BackendRequestFailure, JsonClient } from './src/main/backend/json-client';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

async function fixture() {
  const ports = await publicPorts();
  const contactId = randomUUID(), sessionId = randomUUID(), candidateId = randomUUID(), versionId = randomUUID();
  const turnId = randomUUID(), inputVersionId = randomUUID(), requestId = randomUUID(), messageId = randomUUID();
  const text = '本次合成已保存编辑文字。';
  const history = { session_id: sessionId, turn_id: turnId, candidate_id: candidateId,
    candidate_group_id: requestId, candidate_number: 1, default_display_version_id: versionId,
    selected_version_id: versionId, versions: [
      { version_id: candidateId, version_number: 0, parent_version_id: null, text: '本次合成原候选。',
        messages: [{ message_id: messageId, text: '本次合成原候选。' }], requirements: null, created_at: '2026-10-11T01:00:00+00:00' },
      { version_id: versionId, version_number: 1, parent_version_id: candidateId, text,
        messages: [{ message_id: messageId, text }], requirements: '本次合成编辑要求。', created_at: '2026-10-11T01:01:00+00:00' },
    ] };
  const selection = { selection_id: randomUUID(), selection_number: 1, session_id: sessionId,
    candidate_id: candidateId, version_id: versionId };
  const records = { history, selection, failure: null, saved: { session_id: sessionId, current_input_version_id: inputVersionId,
    turns: [{ turn_id: turnId, input_version_id: inputVersionId, request_key: randomUUID(), state: 'completed', interruption_reason: null,
      input: { content: { type: 'rewrite_draft', draft_text: '本次合成草稿。' } }, placeholder: null,
      reply: { reply_request_id: requestId, candidates: [{ candidate_id: candidateId, text: '本次合成原候选。',
        messages: [{ message_id: messageId, text: '本次合成原候选。' }], basis: '保留本次草稿原意。', citation_ids: [], risk_notes: [] }],
        context_receipt: { evidence_ids: [] } } }],
    inputs: [{ input_version_id: inputVersionId, type: 'generation', conversation_binding_id: randomUUID(),
      turn_id: turnId, state: 'active', content: null, placeholder: null }],
  } };
  const calls = [], handlers = new Map(), listeners = new Map(), backendListeners = new Set();
  const backend = { getConnectionGeneration: () => records.generation ?? 7,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      if (records.transport?.matches(request)) {
        records.transport.beforeRequest?.(request);
        const response = await records.transport.client.perform(request);
        return { generation: records.generation ?? 7, data: response.data };
      }
      if (records.failure) throw records.failure;
      const failure = records.failRequest?.(request);
      if (failure) throw failure;
      const generation = records.generation ?? 7;
      const requestedCandidateId = request.path.match(/\/candidates\/([^/]+)\/versions$/)?.[1];
      if (requestedCandidateId && records.missingCandidates?.has(requestedCandidateId)) {
        throw new ports.BackendRequestFailure('response', 404, 'not_found');
      }
      if (requestedCandidateId && request.method === 'POST') {
        const saved = records.histories?.[requestedCandidateId] ?? records.history;
        const latest = saved.versions.at(-1);
        if (latest.parent_version_id !== request.body.parent_version_id
          || latest.requirements !== request.body.requirements
          || JSON.stringify(latest.messages) !== JSON.stringify(request.body.messages)) {
          const versionId = randomUUID();
          saved.versions.push({ version_id: versionId, version_number: saved.versions.length,
            parent_version_id: request.body.parent_version_id, messages: structuredClone(request.body.messages),
            text: request.body.messages.map((message) => message.text).join('\n\n'),
            requirements: request.body.requirements, created_at: '2026-10-11T01:02:00+00:00' });
          saved.default_display_version_id = versionId;
        }
      }
      const generatedTurn = records.saved.turns[records.generatedTurnIndex ?? 0];
      if (request.path.endsWith('/replies/prepare')) {
        generatedTurn.request_key = request.body.idempotency_key;
        records.saved.current_input_version_id = generatedTurn.input_version_id;
      }
      const evidenceRequestId = request.path.match(/\/replies\/([^/]+)\/evidence$/)?.[1];
      const data = request.path.endsWith('/assistant-session/default') ? { session_id: records.saved.session_id }
        : request.path.endsWith('/select') ? { session_id: request.path.split('/').at(-2) }
        : request.path.endsWith('/replies/prepare') ? { session_id: records.saved.session_id, turn_id: generatedTurn.turn_id,
          request_key: generatedTurn.request_key, input_version_id: generatedTurn.input_version_id, state: generatedTurn.state }
        : request.path.endsWith('/replies') ? { ...generatedTurn.reply, session_id: records.saved.session_id,
          turn_id: generatedTurn.turn_id, input_version_id: generatedTurn.input_version_id, state: 'completed' }
        : request.path.endsWith('/evidence') ? { reply_request_id: evidenceRequestId, evidence: [] }
        : request.path.includes('/messages?') ? records.messagePages?.[
          new URL(request.path, 'http://localhost').searchParams.get('before') ?? 'latest'] ?? records.messagePage
        : request.path.endsWith('/explorations') ? records.explorationOutcome
        : requestedCandidateId ? records.histories?.[requestedCandidateId] ?? records.history
        : request.path.endsWith('/selections') ? request.method === 'POST'
          ? records.selectionReceipt ?? records.selection : { selection: records.selection } : records.saved;
      const response = structuredClone(data);
      await records.beforeResponse?.(request);
      return { generation, data: response };
    },
  };
  const commands = {
    handle: (channel, handler, role) => { assert(!handlers.has(channel)); handlers.set(channel, { handler, role }); },
    publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: records.generation ?? 7,
    contacts: records.contacts ?? [{ contactId, displayName: '合成版本联系人', messageCount: 0, sourceCount: 0 }] }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const replies = ports.installReplyBridge(commands, candidateVersionProtocol(backend), contacts);
  const bridge = ports.createReplyBridge({
    invoke: async (channel, ...args) => handlers.get(channel).handler(...args),
    on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
  });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await bridge.readSavedSession(scope);
  return { ...ports, bridge, replies, contacts, records, calls, handlers, scope, backend, backendListeners,
    sessionId, candidateId, versionId, messageId, text };
}

function appendCandidate(f, { sameTurn = false, text = '独立合成候选仍可查看。' } = {}) {
  const candidateId = randomUUID(), versionId = randomUUID(), messageId = randomUUID();
  const turnId = sameTurn ? f.records.saved.turns[0].turn_id : randomUUID();
  const inputVersionId = sameTurn ? f.records.saved.turns[0].input_version_id : randomUUID();
  const requestId = sameTurn ? f.records.saved.turns[0].reply.reply_request_id : randomUUID();
  const candidate = { ...f.records.saved.turns[0].reply.candidates[0], candidate_id: candidateId, text,
    messages: [{ message_id: messageId, text }] };
  if (sameTurn) f.records.saved.turns[0].reply.candidates.push(candidate);
  else {
    f.records.saved.turns.push({ turn_id: turnId, input_version_id: inputVersionId, request_key: randomUUID(),
      state: 'completed', interruption_reason: null, input: { content: { type: 'rewrite_draft', draft_text: '独立合成输入。' } }, placeholder: null,
      reply: { reply_request_id: requestId, candidates: [candidate], context_receipt: { evidence_ids: [] } } });
    f.records.saved.inputs.push({ input_version_id: inputVersionId, type: 'generation', conversation_binding_id: randomUUID(),
      turn_id: turnId, state: 'active', content: null, placeholder: null });
  }
  const history = { ...f.records.history, turn_id: turnId, candidate_id: candidateId, candidate_group_id: requestId,
    candidate_number: sameTurn ? 2 : 1, default_display_version_id: versionId, selected_version_id: null,
    versions: [
      { version_id: candidateId, version_number: 0, parent_version_id: null, text,
        messages: [{ message_id: messageId, text }], requirements: null, created_at: '2026-10-11T01:00:00+00:00' },
      { version_id: versionId, version_number: 1, parent_version_id: candidateId, text,
        messages: [{ message_id: messageId, text }], requirements: '独立合成版本要求。', created_at: '2026-10-11T01:01:00+00:00' },
    ] };
  f.records.histories = { ...f.records.histories, [f.candidateId]: f.records.history, [candidateId]: history };
  return { candidateId, versionId, turnId, inputVersionId, text };
}

function unavailableTurn(records, index = 0, state = 'redacted') {
  const turn = records.saved.turns[index];
  const placeholder = state === 'redacted' ? '相关来源已删除' : '相关来源不可用';
  records.saved.turns[index] = { ...turn, state, input: null, reply: null, placeholder };
  records.saved.inputs = records.saved.inputs.map((input) => input.turn_id === turn.turn_id
    ? { ...input, state, content: null, placeholder } : input);
}

function candidateOperation(f, operation) {
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
  return operation === 'read' ? f.bridge.readCandidateVersions(identity)
    : operation === 'save' ? f.bridge.saveCandidateVersion({ ...identity, editKey: randomUUID(), parentVersionId: f.versionId,
      messages: [{ messageId: f.messageId, text: '本次来源复验合成编辑。' }], requirements: '本次来源复验合成要求。' })
      : f.bridge.selectCandidateVersion({ ...identity, versionId: f.versionId, selectionKey: randomUUID() });
}

function primaryCandidateOperation(request, f, operation) {
  return operation === 'select' ? request.method === 'POST' && request.path.endsWith('/selections')
    : request.path.includes(f.candidateId) && request.path.endsWith('/versions')
      && request.method === (operation === 'save' ? 'POST' : 'GET');
}

async function conflictTransport(t, f, payload, matches, beforeRequest, status = 409) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const client = new f.JsonClient({ port: server.address().port, token: 'synthetic-version-contract' });
  t.after(async () => { client.cancelPending(); await new Promise((resolve) => server.close(resolve)); });
  f.records.transport = { client, matches, beforeRequest };
  return { client, requests };
}

function replaceSavedFixture(f, sessionId = f.sessionId) {
  const candidateId = randomUUID(), versionId = randomUUID(), turnId = randomUUID();
  const inputId = randomUUID(), messageId = randomUUID(), requestId = randomUUID(), text = '新范围合成候选。';
  f.records.saved = { session_id: sessionId, current_input_version_id: inputId,
    turns: [{ turn_id: turnId, input_version_id: inputId, request_key: randomUUID(), state: 'completed', interruption_reason: null,
      input: { content: { type: 'rewrite_draft', draft_text: '新范围合成草稿。' } }, placeholder: null,
      reply: { reply_request_id: requestId, candidates: [{ candidate_id: candidateId, text,
        messages: [{ message_id: messageId, text }], basis: '新范围合成依据。', citation_ids: [], risk_notes: [] }],
        context_receipt: { evidence_ids: [] } } }],
    inputs: [{ input_version_id: inputId, type: 'generation', conversation_binding_id: randomUUID(),
      turn_id: turnId, state: 'active', content: null, placeholder: null }],
  };
  f.records.history = { session_id: sessionId, turn_id: turnId, candidate_id: candidateId,
    candidate_group_id: requestId, candidate_number: 1, default_display_version_id: versionId,
    selected_version_id: versionId, versions: [
      { version_id: candidateId, version_number: 0, parent_version_id: null, text,
        messages: [{ message_id: messageId, text }], requirements: null, created_at: '2026-10-11T01:00:00+00:00' },
      { version_id: versionId, version_number: 1, parent_version_id: candidateId, text,
        messages: [{ message_id: messageId, text }], requirements: '新范围合成要求。', created_at: '2026-10-11T01:01:00+00:00' },
    ] };
  f.records.selection = { selection_id: randomUUID(), selection_number: 1,
    session_id: sessionId, candidate_id: candidateId, version_id: versionId };
  return { candidateId, versionId, sessionId, text };
}

test('同SID完整重读来源删除快照后清除旧版本RAM与实际选择，不恢复隐藏正文', async () => {
  const f = await fixture();
  const before = await f.bridge.getState();
  assert.equal(before.candidateVersions.items[0].history.versions[1].text, f.text);
  assert.equal(before.explicitCandidateSelection.selection.versionId, f.versionId);
  f.records.saved.turns[0] = { ...f.records.saved.turns[0], state: 'redacted', input: null, reply: null,
    placeholder: '相关来源已删除' };
  f.records.saved.inputs[0] = { ...f.records.saved.inputs[0], state: 'redacted', placeholder: '相关来源已删除' };
  f.records.selection = null;
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.sessionId, f.sessionId);
  assert(!JSON.stringify(state).includes(f.text));
  assert.deepEqual(state.candidateVersions.items, []);
  assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: null });
});

test('公开四版本RPC只接受完整身份与整组编辑，选择重读实际指针', async () => {
  const f = await fixture();
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
  await f.bridge.readCandidateVersions({ ...identity, contactId: f.scope.contactId.toUpperCase() });
  await f.bridge.showCandidateVersion({ ...identity, versionId: f.candidateId });
  assert.equal((await f.bridge.getState()).candidateVersions.items[0].displayVersionId, f.candidateId);
  const editKey = randomUUID(), editedVersionId = randomUUID();
  f.records.history.versions.push({ version_id: editedVersionId, version_number: 2, parent_version_id: f.candidateId,
    text: '本次公开整组编辑。', messages: [{ message_id: f.messageId, text: '本次公开整组编辑。' }],
    requirements: '只修改本次版本。', created_at: '2026-10-11T01:02:00+00:00' });
  f.records.history.default_display_version_id = editedVersionId;
  await f.bridge.saveCandidateVersion({ ...identity, editKey, parentVersionId: f.candidateId,
    messages: [{ messageId: f.messageId, text: '本次公开整组编辑。' }], requirements: '只修改本次版本。' });
  f.records.selectionReceipt = { ...f.records.selection, selection_id: randomUUID(),
    selection_number: 1, version_id: f.candidateId };
  await f.bridge.selectCandidateVersion({ ...identity, versionId: f.candidateId, selectionKey: randomUUID() });
  const state = await f.bridge.getState();
  assert.equal(state.candidateVersions.items[0].displayVersionId, editedVersionId);
  assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
  const count = f.calls.length;
  const edit = { ...identity, editKey, parentVersionId: f.candidateId,
    messages: [{ messageId: f.messageId, text: '本次公开整组编辑。' }], requirements: null };
  for (const operation of [
    () => f.bridge.readCandidateVersions(),
    () => f.bridge.readCandidateVersions(identity, identity),
    () => f.bridge.readCandidateVersions({ ...identity, ownerId: randomUUID() }),
    () => f.bridge.readCandidateVersions({ ...identity, sessionId: randomUUID() }),
    () => f.bridge.readCandidateVersions({ ...identity, scopeRevision: identity.scopeRevision - 1 }),
    () => f.bridge.showCandidateVersion({ ...identity, versionId: 'invalid' }),
    () => f.bridge.selectCandidateVersion({ ...identity, versionId: f.versionId, selectionKey: randomUUID(), text: '不得注入正文' }),
    () => f.bridge.saveCandidateVersion({ ...edit, editKey: 'invalid' }),
    () => f.bridge.saveCandidateVersion({ ...edit, requirements: ' ' }),
    () => f.bridge.saveCandidateVersion({ ...edit, requirements: '合'.repeat(4097) }),
    () => f.bridge.saveCandidateVersion({ ...edit, messages: [{ messageId: f.messageId, text: '文字', ordinal: 0 }] }),
    () => f.bridge.saveCandidateVersion({ ...edit, messages: [{ messageId: randomUUID(), text: '文字' }] }),
    () => f.bridge.saveCandidateVersion({ ...edit, messages: [] }),
  ]) await assert.rejects(operation());
  assert.equal(f.calls.length, count);
  for (const channel of ['read-candidate-versions', 'show-candidate-version', 'save-candidate-version', 'select-candidate-version']) {
    assert.equal(f.handlers.get(`reply:${channel}`).role, 'helper');
  }
});

test('普通读取连接故障保留用户草稿、要求与已知版本，明确会话失效清除旧正文', async () => {
  const f = await fixture();
  f.contacts.setDraft({ ...f.scope, text: '用户正在编辑的新草稿。' });
  const options = { tone: 'warm', instruction: '本次用户要求。', includeRelationshipContext: false };
  await f.bridge.updateOptions({ ...f.scope, options });
  f.records.failure = new f.BackendRequestFailure('connection');
  await f.bridge.readSavedSession(f.scope);
  const retry = await f.bridge.getState();
  assert.equal(retry.savedSession.phase, 'failed');
  assert.equal(retry.candidateVersions.items[0].history.versions[1].text, f.text);
  assert.deepEqual(retry.options, options);
  assert.equal(f.contacts.getState().draft, '用户正在编辑的新草稿。');
  f.records.failure = new f.BackendRequestFailure('response', 404, 'not_found');
  await f.bridge.readSavedSession(f.scope);
  const missing = await f.bridge.getState();
  assert.deepEqual(missing.candidateVersions.items, []);
  assert.equal(missing.explicitCandidateSelection.selection, null);
  assert(!JSON.stringify(missing).includes(f.text));
  assert.deepEqual(missing.options, options);
  assert.equal(f.contacts.getState().draft, '用户正在编辑的新草稿。');
});

test('候选版本公开读取确认来源不可用后清除该候选版本正文与选择', async () => {
  const f = await fixture();
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records, 0, 'unavailable'); f.records.selection = null;
    return new f.BackendRequestFailure('response', 404, 'not_found');
  };
  await assert.rejects(f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId }));
  const state = await f.bridge.getState();
  assert.equal(state.candidateVersions.items[0].phase, 'failed');
  assert.equal(state.candidateVersions.items[0].history, null);
  assert.equal(state.explicitCandidateSelection.selection, null);
  assert(!JSON.stringify(state.candidateVersions).includes(f.text));
  assert.equal(state.savedSession.turns[0].reply, null);
  assert.equal(state.savedSession.turns[0].input, null);
  assert.equal(state.savedSession.turns[0].state, 'unavailable');
  assert.equal(state.savedSession.inputs[0].state, 'unavailable');
  assert(!JSON.stringify(state).includes('本次合成原候选。'));
});

test('公开保存和明确选择的source409同步清原结果与同turn副本，保留新草稿和要求', async () => {
  for (const operation of ['save', 'select']) {
    const f = await fixture();
    f.contacts.setDraft({ ...f.scope, text: '用户仍在编辑的新草稿。' });
    const options = { tone: 'warm', instruction: '只保留用户当前要求。', includeRelationshipContext: false };
    await f.bridge.updateOptions({ ...f.scope, options });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    const oldRequestKey = f.calls.find((request) => request.path.endsWith('/replies')).body.idempotency_key;
    assert.equal((await f.bridge.getState()).result.candidates[0].original.text, '本次合成原候选。');
    const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
    f.records.failRequest = (request) => {
      if (!primaryCandidateOperation(request, f, operation)) return null;
      unavailableTurn(f.records, 0, 'unavailable'); f.records.selection = null;
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    };
    await assert.rejects(operation === 'save'
      ? f.bridge.saveCandidateVersion({ ...identity, editKey: randomUUID(), parentVersionId: f.versionId,
        messages: [{ messageId: f.messageId, text: '本次尚未保存的编辑。' }], requirements: '仅限本次编辑要求。' })
      : f.bridge.selectCandidateVersion({ ...identity, versionId: f.versionId, selectionKey: randomUUID() }));
    const state = await f.bridge.getState();
    assert.equal(state.result, null);
    assert.equal(state.selectedCandidateId, null);
    assert.equal(state.savedSession.turns[0].reply, null);
    assert.equal(state.savedSession.turns[0].input, null);
    assert.equal(state.savedSession.inputs[0].state, 'unavailable');
    assert.equal(state.candidateVersions.items[0].history, null);
    assert.equal(state.explicitCandidateSelection.selection, null);
    assert(!JSON.stringify(state).includes('本次合成原候选。'));
    assert(!JSON.stringify(state).includes(f.text));
    assert.deepEqual(state.options, options);
    assert.equal(f.contacts.getState().draft, '用户仍在编辑的新草稿。');
    f.records.failRequest = (request) => request.path.endsWith('/replies') ? new f.BackendRequestFailure('connection') : null;
    await f.bridge.generate({ ...f.scope, newRequest: false });
    assert.notEqual(f.calls.filter((request) => request.path.endsWith('/replies/prepare')).at(-1).body.idempotency_key, oldRequestKey);
  }
});

test('候选404清同turn所有候选版本，保留独立turn及其版本和讨论', async () => {
  const f = await fixture(), sibling = appendCandidate(f, { sameTurn: true, text: '同来源合成兄弟候选。' });
  const independent = appendCandidate(f);
  await f.bridge.readSavedSession(f.scope);
  const beforeReads = f.calls.filter((request) => request.method === 'GET'
    && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)).length;
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records); f.records.selection = null;
    return new f.BackendRequestFailure('response', 404, 'not_found');
  };
  await assert.rejects(f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId }));
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.turns[0].reply, null);
  assert.equal(state.savedSession.turns[1].reply.candidates[0].text, independent.text);
  assert.equal(state.savedSession.turns[1].input.content.draft_text, '独立合成输入。');
  assert.equal(state.savedSession.inputs[1].state, 'active');
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === sibling.candidateId).history, null);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history.versions[1].text,
    independent.text);
  assert(!JSON.stringify(state).includes('同来源合成兄弟候选。'));
  assert(!JSON.stringify(state).includes('本次合成原候选。'));
  assert.equal(f.calls.filter((request) => request.method === 'GET'
    && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)).length, beforeReads + 1);
  await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
    candidateId: independent.candidateId, versionId: independent.candidateId });
  assert.equal((await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === independent.candidateId).displayVersionId,
    independent.candidateId);
});

test('生成清空当前turn投影后完整来源复验仍清历史版本缓存，消失turn不能复活且有效turn保留', async () => {
  for (const authority of ['redacted', 'unavailable', 'missing']) {
    const f = await fixture(), historical = appendCandidate(f, { text: '生成前加载的历史合成正文。' });
    const independent = appendCandidate(f, { text: '权威仍有效的独立历史合成正文。' });
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '保留用户生成后的手工合成草稿。' });
    const options = { tone: 'warm', instruction: '保留本次手工合成要求。', includeRelationshipContext: false };
    await f.bridge.updateOptions({ ...f.scope, options });
    const fullReads = () => f.calls.filter((request) => request.method === 'GET'
      && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)).length;
    const beforeReads = fullReads();
    await f.bridge.generate({ ...f.scope, newRequest: true });
    const generated = await f.bridge.getState();
    assert.equal(generated.savedSession.sessionId, f.sessionId);
    assert.deepEqual(generated.savedSession.turns, []);
    assert.equal(generated.candidateVersions.items.length, 3);
    assert.equal(fullReads(), beforeReads + 1);
    const beforeValidationReads = fullReads();
    let confirmed = false;
    const published = [];
    const unsubscribe = f.bridge.onStateChanged((state) => { if (confirmed) published.push(state); });
    f.records.failRequest = (request) => {
      if (!primaryCandidateOperation(request, f, 'read')) return null;
      confirmed = true;
      unavailableTurn(f.records, 0, authority === 'unavailable' ? 'unavailable' : 'redacted');
      if (authority === 'missing') {
        f.records.saved.turns = f.records.saved.turns.filter((turn) => turn.turn_id !== historical.turnId);
        f.records.saved.inputs = f.records.saved.inputs.filter((input) => input.turn_id !== historical.turnId);
      } else unavailableTurn(f.records, 1, authority);
      if (authority === 'redacted') unavailableTurn(f.records, 2, 'redacted');
      f.records.selection = null;
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    };
    await assert.rejects(candidateOperation(f, 'read'));
    unsubscribe();
    const state = await f.bridge.getState();
    assert.equal(state.candidateVersions.items.find((item) => item.candidateId === historical.candidateId).history, null);
    assert.equal(state.result, null);
    assert.equal(state.selectedCandidateId, null);
    assert.equal(state.explicitCandidateSelection.selection, null);
    assert.equal(state.savedSession.phase, 'ready');
    assert.equal(fullReads(), beforeValidationReads + 1);
    assert(!JSON.stringify(state).includes(historical.text));
    assert(published.length > 0);
    assert(published.every((event) => !JSON.stringify(event).includes(historical.text)));
    await assert.rejects(f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
      candidateId: historical.candidateId, versionId: historical.versionId }));
    if (authority === 'redacted') {
      assert(!JSON.stringify(state).includes(independent.text));
      assert(state.savedSession.turns.every((turn) => turn.state === 'redacted' && turn.reply === null));
      await assert.rejects(f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
        candidateId: independent.candidateId, versionId: independent.versionId }));
    } else {
      assert.equal(state.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text,
        independent.text);
      assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history.versions[1].text,
        independent.text);
      await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
        candidateId: independent.candidateId, versionId: independent.candidateId });
      assert.equal((await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === independent.candidateId).displayVersionId,
        independent.candidateId);
    }
    assert.deepEqual(state.options, options);
    assert.equal(f.contacts.getState().draft, '保留用户生成后的手工合成草稿。');
  }
});

test('版本来源复验不发布已删消息与派生目的，权威有效消息和独立手写目的保留', async () => {
  for (const editedPurpose of [false, true]) {
    const f = await fixture(), deletedMessageId = randomUUID(), validMessageId = randomUUID();
    const deletedText = '本次删除的合成消息原文。', validText = '本次仍有效的独立合成消息。';
    const derivedPurpose = '本次来源派生的合成目的。', manualPurpose = '用户独立手写的合成目的。';
    const message = (messageId, text) => ({ message_id: messageId, speaker: 'contact', message_type: 'text',
      text, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null });
    f.records.messagePage = { messages: [message(deletedMessageId, deletedText), message(validMessageId, validText)], next_cursor: null };
    await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
    await f.bridge.selectMessage({ ...f.scope, messageId: deletedMessageId });
    await f.bridge.setMode({ ...f.scope, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...f.scope, purpose: '用户最初手写的合成目的。' });
    f.records.explorationOutcome = { kind: 'generated', exploration_id: randomUUID(), confirmed_intent: derivedPurpose,
      turn: { ...f.records.saved.turns[0].reply, session_id: f.sessionId,
        input_version_id: f.records.saved.turns[0].input_version_id, state: 'completed' } };
    await f.bridge.explore(f.scope);
    assert.equal((await f.bridge.getState()).purpose, derivedPurpose);
    if (editedPurpose) await f.bridge.updatePurpose({ ...f.scope, purpose: manualPurpose });
    let confirmed = false;
    const published = [];
    const unsubscribe = f.bridge.onStateChanged((state) => { if (confirmed) published.push(state); });
    f.records.failRequest = (request) => {
      if (!primaryCandidateOperation(request, f, 'read')) return null;
      confirmed = true;
      unavailableTurn(f.records, 0, 'unavailable'); f.records.selection = null;
      f.records.messagePage.messages = [message(validMessageId, validText)];
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    };
    await assert.rejects(candidateOperation(f, 'read'));
    unsubscribe();
    const state = await f.bridge.getState();
    assert(!JSON.stringify(state).includes(deletedText));
    assert(published.every((event) => !JSON.stringify(event).includes(deletedText)));
    assert.equal(state.targetMessageId, null);
    assert.equal(state.messages.items.find((item) => item.messageId === validMessageId).text, validText);
    assert.equal(state.purpose, editedPurpose ? manualPurpose : '');
    assert(published.every((event) => editedPurpose || !JSON.stringify(event).includes(derivedPurpose)));
    assert.equal(state.result, null);
    assert.equal(state.savedSession.turns[0].state, 'unavailable');
  }
});

test('A版本来源复验保留较早分页中仍有效的已选消息', async () => {
  const f = await fixture(), validMessageId = randomUUID();
  const validText = '较早分页中仍有效的独立合成消息。';
  const message = (messageId, text) => ({ message_id: messageId, speaker: 'contact', message_type: 'text',
    text, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null });
  const latest = Array.from({ length: 20 }, (_, index) => message(randomUUID(), `最新分页合成消息${index + 1}。`));
  const cursor = latest.at(-1).message_id;
  f.records.messagePages = {
    latest: { messages: latest, next_cursor: cursor },
    [cursor]: { messages: [message(validMessageId, validText)], next_cursor: null },
  };
  await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
  await f.bridge.loadMessages({ ...f.scope, older: true });
  await f.bridge.selectMessage({ ...f.scope, messageId: validMessageId });
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records, 0, 'redacted'); f.records.selection = null;
    return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
  };
  await assert.rejects(candidateOperation(f, 'read'));
  const state = await f.bridge.getState();
  assert.equal(state.targetMessageId, validMessageId);
  assert.equal(state.messages.items.find((item) => item.messageId === validMessageId).text, validText);
  assert.equal(state.savedSession.turns[0].state, 'redacted');
  assert(!JSON.stringify(state).includes(f.text));
});

for (const late of [false, true]) {
  test(`generated探索${late ? '迟到重试响应' : '已保存重试快照'}在来源失效后不能恢复正文`, async () => {
    const f = await fixture(), targetId = randomUUID(), targetText = '来源删除后不能保留的合成消息原文。';
    f.records.messagePage = { messages: [{ message_id: targetId, speaker: 'contact', message_type: 'text',
      text: targetText, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null }], next_cursor: null };
    await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
    await f.bridge.selectMessage({ ...f.scope, messageId: targetId });
    f.records.explorationOutcome = { kind: 'generated', exploration_id: randomUUID(), confirmed_intent: '本轮合成回应意愿。',
      turn: { ...f.records.saved.turns[0].reply, session_id: f.sessionId,
        input_version_id: f.records.saved.turns[0].input_version_id, state: 'completed' } };
    await f.bridge.explore(f.scope);
    assert.equal((await f.bridge.getState()).result.input.target.text, targetText);
    let retry, release;
    if (late) {
      let reached;
      const blocked = new Promise((resolve) => { reached = resolve; });
      f.records.beforeResponse = (request) => {
        if (request.path.endsWith('/explorations')) {
          f.records.beforeResponse = undefined;
          reached(); return new Promise((resolve) => { release = resolve; });
        }
      };
      retry = f.bridge.retryExploration(f.scope);
      await blocked;
    }
    f.records.failRequest = (request) => {
      if (!primaryCandidateOperation(request, f, 'read')) return null;
      unavailableTurn(f.records, 0, 'redacted'); f.records.selection = null;
      f.records.messagePage = { messages: [], next_cursor: null };
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    };
    await assert.rejects(candidateOperation(f, 'read'));
    const published = [];
    const unsubscribe = f.bridge.onStateChanged((state) => published.push(state));
    if (late) { release(); await retry; }
    assert(published.every((event) => !JSON.stringify(event).includes(targetText) && !JSON.stringify(event).includes(f.text)));
    const before = f.calls.filter((request) => request.method === 'POST').length;
    await f.bridge.retryExploration(f.scope);
    unsubscribe();
    assert.equal(f.calls.filter((request) => request.method === 'POST').length, before);
    assert(published.every((event) => !JSON.stringify(event).includes(targetText) && !JSON.stringify(event).includes(f.text)));
    const state = await f.bridge.getState();
    assert.equal(state.result, null);
    assert.equal(state.targetMessageId, null);
    assert(!JSON.stringify(state).includes(targetText));
    assert(!JSON.stringify(state).includes(f.text));
  });
}

for (const status of [404, 409]) {
  test(`首次open已保存新输入X而expected仍为独立B时，来源${status}阻止迟到方向正文`, async () => {
    const f = await fixture(), independent = appendCandidate(f);
    const targetId = randomUUID(), targetText = '首次探索失效后不能恢复的合成目标正文。';
    const inputX = randomUUID(), bindingId = randomUUID(), evidenceId = randomUUID();
    const understanding = '已删除目标的合成探索理解。';
    f.records.saved.current_input_version_id = independent.inputVersionId;
    await f.bridge.readSavedSession(f.scope);
    f.records.messagePage = { messages: [{ message_id: targetId, speaker: 'contact', message_type: 'text',
      text: targetText, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null }], next_cursor: null };
    await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
    await f.bridge.selectMessage({ ...f.scope, messageId: targetId });
    f.records.explorationOutcome = { kind: 'directions', exploration_id: randomUUID(), session_id: f.sessionId,
      input_version_id: inputX, understanding, ambiguities: [], evidence: [
        { evidence_id: evidenceId, text: targetText, source_ids: [randomUUID()] },
      ], options: ['先回应本次消息。', '先确认当前意愿。'].map((intent, index) => ({ suggestion_id: randomUUID(),
        label: intent, intent, reason: '合成目标消息支持本方向。', citation_ids: [evidenceId], recommended: index === 0, pause: false })),
      citation_ids: [evidenceId], question: null, confirmed_intent: null, current_step: '等待用户选择方向',
      tradeoffs: [], used_skill: null, skill_choices: [] };
    let release, reached;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.beforeResponse = (request) => {
      if (!request.path.endsWith('/explorations')) return;
      assert.equal(request.body.previous_id, null);
      assert.equal(request.body.expected_input_version_id, independent.inputVersionId);
      f.records.beforeResponse = undefined;
      f.records.saved.inputs.push({ input_version_id: inputX, type: 'response_exploration', conversation_binding_id: bindingId,
        turn_id: null, state: 'active', content: { type: 'response_exploration', target_message_id: targetId,
          correction: '', requirements: '', answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null },
        placeholder: null });
      f.records.saved.current_input_version_id = inputX;
      reached(); return new Promise((resolve) => { release = resolve; });
    };
    const exploring = f.bridge.explore(f.scope);
    await blocked;
    let confirmed = false;
    f.records.failRequest = (request) => {
      if (!primaryCandidateOperation(request, f, 'read')) return null;
      confirmed = true;
      unavailableTurn(f.records); f.records.selection = null;
      f.records.saved.inputs = f.records.saved.inputs.map((input) => input.input_version_id === inputX
        ? { ...input, state: 'redacted', content: null, placeholder: '相关来源已删除' } : input);
      f.records.messagePage = { messages: [], next_cursor: null };
      return status === 404 ? new f.BackendRequestFailure('response', 404, 'not_found')
        : new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    };
    const published = [], unsubscribe = f.bridge.onStateChanged((state) => { if (confirmed) published.push(state); });
    await assert.rejects(candidateOperation(f, 'read'));
    release(); await exploring;
    const before = f.calls.filter((request) => request.method === 'POST').length;
    await f.bridge.retryExploration(f.scope);
    unsubscribe();
    const state = await f.bridge.getState();
    assert.equal(state.exploration.phase, 'idle');
    assert.equal(state.exploration.result, null);
    assert.equal(state.targetMessageId, null);
    assert.equal(state.savedSession.inputs.find((input) => input.inputVersionId === inputX).state, 'redacted');
    assert.equal(state.savedSession.inputs.find((input) => input.inputVersionId === independent.inputVersionId).state, 'active');
    assert.equal(state.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text, independent.text);
    assert.equal(f.calls.filter((request) => request.method === 'POST').length, before);
    assert(published.every((event) => !JSON.stringify(event).includes(targetText) && !JSON.stringify(event).includes(understanding)));
    assert(!JSON.stringify(state).includes(targetText));
    await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
      candidateId: independent.candidateId, versionId: independent.candidateId });
    assert.equal((await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === independent.candidateId).displayVersionId,
      independent.candidateId);
  });
}

for (const [status, inputState] of [[404, 'redacted'], [409, 'unavailable']]) {
  test(`首次open实际X的额外来源失效而B和目标T仍有效时，版本${status}不能恢复迟到方向`, async (t) => {
    const f = await fixture(), independent = appendCandidate(f);
    const targetId = randomUUID(), targetText = '来源独立且仍有效的合成目标T。';
    const inputX = randomUUID(), rawR = randomUUID(), evidenceId = randomUUID();
    const deletedContext = '本次额外近期消息或确认资料R的合成正文。';
    const understanding = '仅由已失效额外资料R支持的合成理解。';
    f.records.saved.current_input_version_id = independent.inputVersionId;
    await f.bridge.readSavedSession(f.scope);
    f.records.messagePage = { messages: [{ message_id: targetId, speaker: 'contact', message_type: 'text',
      text: targetText, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null }], next_cursor: null };
    await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
    await f.bridge.selectMessage({ ...f.scope, messageId: targetId });
    f.records.explorationOutcome = { kind: 'directions', exploration_id: randomUUID(), session_id: f.sessionId,
      input_version_id: inputX, understanding, ambiguities: [], evidence: [
        { evidence_id: evidenceId, text: deletedContext, source_ids: [rawR] },
      ], options: ['先回应当前有效消息。', '先确认当前意愿。'].map((intent, index) => ({ suggestion_id: randomUUID(),
        label: intent, intent, reason: '本次额外资料R支持的合成理由。', citation_ids: [evidenceId], recommended: index === 0, pause: false })),
      citation_ids: [evidenceId], question: null, confirmed_intent: null, current_step: '等待用户选择方向',
      tradeoffs: [], used_skill: null, skill_choices: [] };
    let release, reached;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.beforeResponse = (request) => {
      if (!request.path.endsWith('/explorations')) return;
      assert.equal(request.body.previous_id, null);
      assert.equal(request.body.expected_input_version_id, independent.inputVersionId);
      f.records.beforeResponse = undefined;
      f.records.saved.inputs.push({ input_version_id: inputX, type: 'response_exploration', conversation_binding_id: randomUUID(),
        turn_id: null, state: 'active', content: { type: 'response_exploration', target_message_id: targetId,
          correction: '', requirements: '', answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null },
        placeholder: null });
      f.records.saved.current_input_version_id = inputX;
      reached(); return new Promise((resolve) => { release = resolve; });
    };
    const exploring = f.bridge.explore(f.scope);
    await blocked;
    const payload = status === 404 ? { error: 'not_found' }
      : { error: 'assistant_candidate_version_conflict', reason: 'source_unavailable' };
    let confirmed = false;
    await conflictTransport(t, f, payload, (request) => primaryCandidateOperation(request, f, 'read'), () => {
      confirmed = true; unavailableTurn(f.records, 0, inputState); f.records.selection = null;
      f.records.saved.inputs = f.records.saved.inputs.map((input) => input.input_version_id === inputX
        ? { ...input, state: inputState, content: null, placeholder: inputState === 'redacted' ? '相关来源已删除' : '相关来源不可用' } : input);
    }, status);
    const published = [], unsubscribe = f.bridge.onStateChanged((state) => { if (confirmed) published.push(state); });
    await assert.rejects(candidateOperation(f, 'read'));
    release(); await exploring;
    const before = f.calls.filter((request) => request.method === 'POST').length;
    await f.bridge.retryExploration(f.scope);
    unsubscribe();
    const state = await f.bridge.getState();
    assert.equal(state.exploration.phase, 'idle');
    assert.equal(state.exploration.result, null);
    assert.equal(state.targetMessageId, targetId);
    assert.equal(state.messages.items.find((message) => message.messageId === targetId).text, targetText);
    assert.equal(state.savedSession.inputs.find((input) => input.inputVersionId === inputX).state, inputState);
    assert.equal(state.savedSession.inputs.find((input) => input.inputVersionId === independent.inputVersionId).state, 'active');
    assert.equal(state.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text, independent.text);
    assert.equal(f.calls.filter((request) => request.method === 'POST').length, before);
    assert(published.every((event) => !JSON.stringify(event).includes(deletedContext) && !JSON.stringify(event).includes(understanding)));
    assert(!JSON.stringify(state).includes(deletedContext));
    await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
      candidateId: independent.candidateId, versionId: independent.candidateId });
    assert.equal((await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === independent.candidateId).displayVersionId,
      independent.candidateId);
  });
}

async function pendingIndependentExploration() {
  const f = await fixture(), independent = appendCandidate(f);
  const targetId = randomUUID(), inputX = randomUUID(), evidenceId = randomUUID();
  const targetText = '与来源A独立的合成目标T。', understanding = '独立有效输入X的合成理解。';
  f.records.saved.current_input_version_id = independent.inputVersionId;
  await f.bridge.readSavedSession(f.scope);
  f.records.messagePage = { messages: [{ message_id: targetId, speaker: 'contact', message_type: 'text',
    text: targetText, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null }], next_cursor: null };
  await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
  await f.bridge.selectMessage({ ...f.scope, messageId: targetId });
  f.records.explorationOutcome = { kind: 'directions', exploration_id: randomUUID(), session_id: f.sessionId,
    input_version_id: inputX, understanding, ambiguities: [], evidence: [{ evidence_id: evidenceId, text: targetText, source_ids: [randomUUID()] }],
    options: ['回应当前消息。', '确认当前意愿。'].map((intent, index) => ({ suggestion_id: randomUUID(), label: intent, intent,
      reason: '独立目标的合成依据。', citation_ids: [evidenceId], recommended: index === 0, pause: false })),
    citation_ids: [evidenceId], question: null, confirmed_intent: null, current_step: '等待用户选择方向',
    tradeoffs: [], used_skill: null, skill_choices: [] };
  const input = { input_version_id: inputX, type: 'response_exploration', conversation_binding_id: randomUUID(), turn_id: null,
    state: 'active', content: { type: 'response_exploration', target_message_id: targetId, correction: '', requirements: '',
      answer: '', confirmed_intent: '', skill_mode: 'auto', skill_version_id: null }, placeholder: null };
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (!request.path.endsWith('/explorations')) return;
    assert.equal(request.body.expected_input_version_id, independent.inputVersionId);
    f.records.beforeResponse = undefined;
    f.records.saved.inputs.push(input); f.records.saved.current_input_version_id = inputX;
    reached(); return new Promise((resolve) => { release = resolve; });
  };
  const exploring = f.bridge.explore(f.scope);
  await blocked;
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records); f.records.selection = { selection_id: randomUUID(), selection_number: 2,
      session_id: f.sessionId, candidate_id: independent.candidateId, version_id: independent.versionId };
    return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
  };
  return { f, independent, inputX, input, targetId, targetText, understanding, exploring, release };
}

test('首次open来源GET早于实际X完成时，未知身份隔离后允许有效X精确重试而保留B', async () => {
  const x = await pendingIndependentExploration(), { f } = x;
  f.records.saved.inputs = f.records.saved.inputs.filter((input) => input.input_version_id !== x.inputX);
  f.records.saved.current_input_version_id = x.independent.inputVersionId;
  let releaseSnapshot, reachedSnapshot;
  const blocked = new Promise((resolve) => { reachedSnapshot = resolve; });
  f.records.beforeResponse = (request) => {
    if (!request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) return;
    f.records.beforeResponse = undefined;
    reachedSnapshot(); return new Promise((resolve) => { releaseSnapshot = resolve; });
  };
  const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
  await blocked;
  f.records.saved.inputs.push(x.input); f.records.saved.current_input_version_id = x.inputX;
  const published = [], unsubscribe = f.bridge.onStateChanged((state) => published.push(state));
  x.release(); await x.exploring;
  assert(published.every((state) => !JSON.stringify(state).includes(x.understanding)));
  releaseSnapshot(); assert(await reading);
  const before = f.calls.filter((request) => request.method === 'POST' && request.path.endsWith('/explorations')).length;
  await f.bridge.retryExploration(f.scope);
  unsubscribe();
  const state = await f.bridge.getState();
  assert.equal(f.calls.filter((request) => request.method === 'POST' && request.path.endsWith('/explorations')).length, before + 1);
  assert.equal(state.exploration.phase, 'ready');
  assert.equal(state.exploration.result.inputVersion, x.inputX);
  assert.equal(state.exploration.result.understanding, x.understanding);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === x.independent.candidateId).history.versions[1].text,
    x.independent.text);
});

test('首次open按实际X而非current指针核验，独立有效X和B不因同SID其他输入失效而丢失', async () => {
  const x = await pendingIndependentExploration(), { f } = x;
  const unrelated = { ...x.input, input_version_id: randomUUID(), state: 'redacted', content: null, placeholder: '相关来源已删除' };
  f.records.saved.inputs.push(unrelated); f.records.saved.current_input_version_id = unrelated.input_version_id;
  await assert.rejects(candidateOperation(f, 'read'));
  x.release(); await x.exploring;
  const state = await f.bridge.getState();
  assert.equal(state.exploration.phase, 'ready');
  assert.equal(state.exploration.result.inputVersion, x.inputX);
  assert.equal(state.exploration.result.understanding, x.understanding);
  assert.equal(state.targetMessageId, x.targetId);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === x.independent.candidateId).history.versions[1].text,
    x.independent.text);
});

for (const failure of ['connection', '403', 'ordinary409']) {
  test(`首次open实际X需补验而完整GET为${failure}时只隔离探索，公开retry核验有效X并保留B`, async () => {
    const x = await pendingIndependentExploration(), { f } = x;
    f.records.saved.inputs = f.records.saved.inputs.filter((input) => input.input_version_id !== x.inputX);
    f.records.saved.current_input_version_id = x.independent.inputVersionId;
    await assert.rejects(candidateOperation(f, 'read'));
    f.records.saved.inputs.push(x.input); f.records.saved.current_input_version_id = x.inputX;
    let unknown = true;
    f.records.failRequest = (request) => unknown && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)
      ? failure === 'connection' ? new f.BackendRequestFailure('connection')
        : new f.BackendRequestFailure('response', failure === '403' ? 403 : 409,
          failure === '403' ? 'forbidden' : 'assistant_candidate_version_conflict', failure === '403' ? 'source_unavailable' : 'edit_key_conflict')
      : null;
    const published = [], unsubscribe = f.bridge.onStateChanged((state) => published.push(state));
    x.release(); await x.exploring;
    let state = await f.bridge.getState();
    assert.equal(state.exploration.phase, 'failed');
    assert.equal(state.exploration.result, null);
    assert.equal(state.exploration.canRetry, true);
    assert.equal(state.targetMessageId, x.targetId);
    assert.equal(state.savedSession.inputs.find((input) => input.inputVersionId === x.independent.inputVersionId).state, 'active');
    assert.equal(state.candidateVersions.items.find((item) => item.candidateId === x.independent.candidateId).history.versions[1].text,
      x.independent.text);
    assert(published.every((event) => !JSON.stringify(event).includes(x.understanding)));
    unknown = false;
    await f.bridge.retryExploration(f.scope);
    unsubscribe(); state = await f.bridge.getState();
    assert.equal(state.exploration.phase, 'ready');
    assert.equal(state.exploration.result.inputVersion, x.inputX);
    assert.equal(state.exploration.result.understanding, x.understanding);
  });
}

for (const status of [404, 409]) {
  test(`首次open实际X补验完整GET确认会话终态${status}时停止探索与retry，不永久waiting`, async () => {
    const x = await pendingIndependentExploration(), { f } = x;
    f.records.saved.inputs = f.records.saved.inputs.filter((input) => input.input_version_id !== x.inputX);
    f.records.saved.current_input_version_id = x.independent.inputVersionId;
    await assert.rejects(candidateOperation(f, 'read'));
    f.records.failRequest = (request) => request.path.endsWith(`/assistant-sessions/${f.sessionId}`)
      ? status === 404 ? new f.BackendRequestFailure('response', 404, 'not_found')
        : new f.BackendRequestFailure('response', 409, 'assistant_session_conflict', 'source_unavailable') : null;
    x.release(); await x.exploring;
    const before = f.calls.filter((request) => request.method === 'POST').length;
    await f.bridge.retryExploration(f.scope);
    const state = await f.bridge.getState();
    assert.equal(state.exploration.phase, 'idle');
    assert.equal(state.exploration.result, null);
    assert.equal(state.result, null);
    assert.equal(f.calls.filter((request) => request.method === 'POST').length, before);
    assert(!JSON.stringify(state).includes(x.understanding));
    assert(!JSON.stringify(state).includes(x.independent.text));
  });
}

for (const change of ['scope', 'operation', 'generation']) {
  test(`首次open实际X补验的完整GET在${change}变更后迟到，不发布旧正文或污染新版本视图`, async () => {
    const x = await pendingIndependentExploration(), { f } = x;
    f.records.saved.inputs = f.records.saved.inputs.filter((input) => input.input_version_id !== x.inputX);
    f.records.saved.current_input_version_id = x.independent.inputVersionId;
    await assert.rejects(candidateOperation(f, 'read'));
    f.records.saved.inputs.push(x.input); f.records.saved.current_input_version_id = x.inputX;
    let releaseValidation, reachedValidation;
    const blocked = new Promise((resolve) => { reachedValidation = resolve; });
    f.records.beforeResponse = (request) => {
      if (!request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) return;
      f.records.beforeResponse = undefined;
      reachedValidation(); return new Promise((resolve) => { releaseValidation = resolve; });
    };
    x.release(); await blocked;
    if (change === 'operation') await f.bridge.updateCorrection({ ...f.scope, correction: '本次新的独立纠正。' });
    else {
      replaceSavedFixture(f);
      if (change === 'scope') {
        const contactId = randomUUID();
        f.records.contacts = [{ contactId, displayName: '补验后新合成联系人', messageCount: 0, sourceCount: 0 }];
        await f.contacts.refreshContacts();
        f.contacts.selectContact({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
        await f.bridge.readSavedSession({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
      } else {
        f.records.generation = 8;
        for (const listener of f.backendListeners) listener();
        await f.bridge.readSavedSession(f.scope);
      }
    }
    const before = await f.bridge.getState(), published = [];
    const unsubscribe = f.bridge.onStateChanged((state) => published.push(state));
    releaseValidation(); await x.exploring;
    unsubscribe();
    assert.deepEqual(await f.bridge.getState(), before);
    assert(published.every((state) => !JSON.stringify(state).includes(x.understanding)));
  });
}

test('A版本失效复验保留正在核验依据的有效B held结果，B依据成功后可恢复', async () => {
  const f = await fixture(), independent = appendCandidate(f, { text: '依据仍有效的独立B合成候选。' });
  await f.bridge.readSavedSession(f.scope);
  f.records.generatedTurnIndex = 1;
  f.contacts.setDraft({ ...f.scope, text: '独立B的手工合成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  assert.equal((await f.bridge.getState()).result.candidates[0].original.candidateId, independent.candidateId);
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (request.path.endsWith('/evidence')) { reached(); return new Promise((resolve) => { release = resolve; }); }
  };
  const validating = f.replies.revalidateDeletedSource(randomUUID());
  await blocked;
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records, 0, 'redacted'); f.records.selection = null;
    return new f.BackendRequestFailure('response', 404, 'not_found');
  };
  await f.bridge.readSavedSession(f.scope);
  assert.equal((await f.bridge.getState()).savedSession.turns.find((turn) => turn.turnId === independent.turnId).state, 'completed');
  release(); await validating;
  const state = await f.bridge.getState();
  assert.equal(state.result?.candidates[0].original.candidateId, independent.candidateId);
  assert.equal(state.result.candidates[0].original.text, independent.text);
  assert.equal(state.sourceAvailability, undefined);
  assert(!JSON.stringify(state).includes(f.text));
});

for (const operation of ['read', 'save', 'select']) {
  for (const status of [404, 409]) {
    test(`公开${operation}来源${status}完整复验同源两个turn，第二turn旧版不能继续展开`, async () => {
      const f = await fixture(), dependent = appendCandidate(f, { text: '同来源第二轮合成候选。' });
      f.contacts.setDraft({ ...f.scope, text: '来源复验保留用户手工草稿。' });
      const options = { tone: 'warm', instruction: '来源复验保留本次用户要求。', includeRelationshipContext: false };
      await f.bridge.updateOptions({ ...f.scope, options });
      await f.bridge.generate({ ...f.scope, newRequest: true });
      await f.bridge.readSavedSession(f.scope);
      const fullReads = () => f.calls.filter((request) => request.method === 'GET'
        && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)).length;
      const beforeReads = fullReads();
      f.records.failRequest = (request) => {
        if (!primaryCandidateOperation(request, f, operation)) return null;
        unavailableTurn(f.records, 0, status === 404 ? 'redacted' : 'unavailable');
        unavailableTurn(f.records, 1, status === 404 ? 'redacted' : 'unavailable');
        f.records.selection = null;
        return status === 404 ? new f.BackendRequestFailure('response', 404, 'not_found')
          : new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
      };
      await assert.rejects(candidateOperation(f, operation));
      const state = await f.bridge.getState();
      assert.equal(state.savedSession.turns[1].reply, null);
      assert.equal(state.savedSession.turns[1].input, null);
      assert.equal(state.savedSession.inputs[1].state, status === 404 ? 'redacted' : 'unavailable');
      assert.equal(state.savedSession.turns[0].reply, null);
      assert.equal(state.savedSession.inputs[0].state, status === 404 ? 'redacted' : 'unavailable');
      assert.equal(state.result, null);
      assert.equal(state.selectedCandidateId, null);
      assert.equal(state.candidateVersions.items.find((item) => item.candidateId === dependent.candidateId).history, null);
      assert.equal(state.explicitCandidateSelection.selection, null);
      assert.equal(fullReads(), beforeReads + 1);
      assert(!JSON.stringify(state).includes(dependent.text));
      assert(!JSON.stringify(state).includes(f.text));
      await assert.rejects(f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
        candidateId: dependent.candidateId, versionId: dependent.candidateId }));
      assert.deepEqual(state.options, options);
      assert.equal(f.contacts.getState().draft, '来源复验保留用户手工草稿。');
    });
  }
}

test('已确认跨turn来源失效后公开状态事件不先回显未核验缓存正文', async () => {
  const f = await fixture(), dependent = appendCandidate(f, { text: '不能在失效事件回显的第二轮合成正文。' });
  await f.bridge.readSavedSession(f.scope);
  let confirmed = false;
  const published = [];
  const unsubscribe = f.bridge.onStateChanged((state) => { if (confirmed) published.push(state); });
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    confirmed = true; unavailableTurn(f.records); unavailableTurn(f.records, 1); f.records.selection = null;
    return new f.BackendRequestFailure('response', 404, 'not_found');
  };
  await assert.rejects(candidateOperation(f, 'read'));
  unsubscribe();
  assert(published.length > 0);
  assert(published.every((state) => !JSON.stringify(state).includes(dependent.text)));
});

test('确认来源失效到完整GET返回之间隔离所有旧来源视图和版本操作', async () => {
  const f = await fixture(), dependent = appendCandidate(f, { text: '完整复验在途必须隔离的合成正文。' });
  await f.bridge.readSavedSession(f.scope);
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records); unavailableTurn(f.records, 1); f.records.selection = null;
    return new f.BackendRequestFailure('response', 404, 'not_found');
  };
  f.records.beforeResponse = (request) => {
    if (request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
      reached(); return new Promise((resolve) => { release = resolve; });
    }
  };
  const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
  await blocked;
  const quarantined = await f.bridge.getState();
  assert.equal(quarantined.sourceAvailability, 'checking');
  assert(!JSON.stringify(quarantined).includes(dependent.text));
  assert(!JSON.stringify(quarantined).includes(f.text));
  assert.equal(quarantined.result, null);
  assert.deepEqual(quarantined.savedSession.turns, []);
  assert.deepEqual(quarantined.savedSession.inputs, []);
  const beforeCalls = f.calls.length;
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: dependent.candidateId };
  await assert.rejects(f.bridge.showCandidateVersion({ ...identity, versionId: dependent.candidateId }));
  await assert.rejects(f.bridge.readCandidateVersions(identity));
  await assert.rejects(f.bridge.selectCandidateVersion({ ...identity, versionId: dependent.versionId, selectionKey: randomUUID() }));
  await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true }));
  assert.equal(f.calls.length, beforeCalls);
  release(); assert(await reading);
  const state = await f.bridge.getState();
  assert.equal(state.sourceAvailability, undefined);
  assert.equal(state.savedSession.turns[1].reply, null);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === dependent.candidateId).history, null);
  assert(!JSON.stringify(state).includes(dependent.text));
});

for (const [operation, failure] of [['read', 'connection'], ['save', 'server'], ['select', 'missing']]) {
  test(`公开${operation}确认来源坏后完整GET的${failure}失败清全会话RAM`, async () => {
    const f = await fixture(), dependent = appendCandidate(f, { text: '权威失败必须清除的第二轮合成正文。' });
    f.contacts.setDraft({ ...f.scope, text: '权威失败保留用户手工草稿。' });
    const options = { tone: 'polite', instruction: '权威失败保留本次用户要求。', includeRelationshipContext: false };
    await f.bridge.updateOptions({ ...f.scope, options });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    f.records.failRequest = (request) => primaryCandidateOperation(request, f, operation)
      ? new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable')
      : request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? failure === 'connection'
        ? new f.BackendRequestFailure('connection') : new f.BackendRequestFailure('response', failure === 'server' ? 503 : 404,
          failure === 'server' ? 'assistant_session_unavailable' : 'not_found') : null;
    await assert.rejects(candidateOperation(f, operation));
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.phase, 'failed');
    assert.deepEqual(state.savedSession.turns, []);
    assert.deepEqual(state.savedSession.inputs, []);
    assert.equal(state.result, null);
    assert.equal(state.selectedCandidateId, null);
    assert(state.candidateVersions.items.every((item) => item.history === null && item.displayVersionId === null));
    assert.equal(state.explicitCandidateSelection.selection, null);
    assert(!JSON.stringify(state).includes(dependent.text));
    assert(!JSON.stringify(state).includes(f.text));
    assert.deepEqual(state.options, options);
    assert.equal(f.contacts.getState().draft, '权威失败保留用户手工草稿。');
  });
}

for (const change of ['scope', 'operation', 'generation']) {
  test(`已确认坏来源的完整GET迟到失败不能清${change}的新权威恢复视图`, async () => {
    const f = await fixture(); appendCandidate(f, { text: '旧scope同源第二轮合成正文。' });
    await f.bridge.readSavedSession(f.scope);
    let release, reached, slow = true;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.failRequest = (request) => {
      if (!primaryCandidateOperation(request, f, 'read')) return null;
      unavailableTurn(f.records); unavailableTurn(f.records, 1); f.records.selection = null;
      return new f.BackendRequestFailure('response', 404, 'not_found');
    };
    f.records.beforeResponse = (request) => {
      if (slow && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
        slow = false; reached();
        return new Promise((_resolve, reject) => { release = () => reject(new f.BackendRequestFailure('connection')); });
      }
    };
    const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
    await blocked;
    const fresh = replaceSavedFixture(f);
    if (change === 'scope') {
      const contactId = randomUUID();
      f.records.contacts = [{ contactId, displayName: '来源复验后的合成联系人', messageCount: 0, sourceCount: 0 }];
      await f.contacts.refreshContacts();
      f.contacts.selectContact({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
      await f.bridge.readSavedSession({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
    } else {
      if (change === 'generation') {
        f.records.generation = 8;
        for (const listener of f.backendListeners) listener();
      }
      await f.bridge.readSavedSession(f.scope);
    }
    release(); assert(await reading);
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.phase, 'ready');
    assert.equal(state.savedSession.turns[0].reply.candidates[0].text, fresh.text);
    assert.equal(state.candidateVersions.items[0].history.versions[1].text, fresh.text);
    assert.equal(state.explicitCandidateSelection.selection.versionId, fresh.versionId);
    assert.equal(state.sourceAvailability, undefined);
    assert(!JSON.stringify(state).includes('旧scope同源第二轮合成正文。'));
  });
}

test('坏来源复验停止在途生成后保留权威有效的独立结果，并离开waiting', async () => {
  const f = await fixture(), independent = appendCandidate(f, { text: '复验后保留的独立当前结果。' });
  f.records.saved.turns.reverse(); f.records.saved.inputs.reverse();
  f.records.saved.current_input_version_id = independent.inputVersionId;
  f.contacts.setDraft({ ...f.scope, text: '独立当前结果的本次合成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  assert.equal((await f.bridge.getState()).result.candidates[0].original.text, independent.text);
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (request.path.endsWith('/replies')) {
      reached(); return new Promise((resolve) => { release = resolve; });
    }
  };
  const generating = f.bridge.generate({ ...f.scope, newRequest: true });
  await blocked;
  assert.equal((await f.bridge.getState()).phase, 'waiting');
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records, 1, 'unavailable'); f.records.selection = null;
    return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
  };
  await assert.rejects(candidateOperation(f, 'read'));
  const state = await f.bridge.getState();
  release(); await generating;
  assert.equal(state.result.candidates[0].original.text, independent.text);
  assert.equal(state.phase, 'ready');
  assert.equal((await f.bridge.getState()).phase, 'ready');
  assert.equal(state.savedSession.turns[1].reply, null);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).history, null);
});

test('恢复协调的选择来源409通过完整会话权威快照清原turn，保留无关turn', async () => {
  const f = await fixture(), independent = appendCandidate(f);
  let fail = true;
  f.records.failRequest = (request) => {
    if (fail && request.method === 'GET' && request.path.endsWith('/selections')) {
      fail = false; unavailableTurn(f.records); f.records.selection = null;
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    }
    return null;
  };
  await f.bridge.readSavedSession(f.scope);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.turns[0].state, 'redacted');
  assert.equal(state.savedSession.turns[0].reply, null);
  assert.equal(state.savedSession.inputs[0].state, 'redacted');
  assert.equal(state.savedSession.turns[1].reply.candidates[0].text, independent.text);
  assert.equal(state.savedSession.inputs[1].state, 'active');
  assert.equal(state.explicitCandidateSelection.selection, null);
  assert(!JSON.stringify(state).includes('本次合成原候选。'));
  assert(!JSON.stringify(state).includes(f.text));
});

test('版本操作后的选择GET来源失效只清权威命中的另一turn，不清有效版本或原结果', async () => {
  for (const operation of ['read', 'save', 'select']) {
    const f = await fixture(), independent = appendCandidate(f);
    f.contacts.setDraft({ ...f.scope, text: '有效原结果的本次草稿。' });
    await f.bridge.generate({ ...f.scope, newRequest: true });
    await f.bridge.readSavedSession(f.scope);
    let fail = true;
    f.records.failRequest = (request) => {
      if (fail && request.method === 'GET' && request.path.endsWith('/selections')) {
        fail = false; unavailableTurn(f.records, 1); f.records.selection = null;
        return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
      }
      return null;
    };
    const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
    await assert.rejects(operation === 'read' ? f.bridge.readCandidateVersions(identity)
      : operation === 'save' ? f.bridge.saveCandidateVersion({ ...identity, editKey: randomUUID(), parentVersionId: f.versionId,
        messages: [{ messageId: f.messageId, text: f.text }], requirements: null })
        : f.bridge.selectCandidateVersion({ ...identity, versionId: f.versionId, selectionKey: randomUUID() }));
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '本次合成原候选。');
    assert.equal(state.result.candidates[0].original.text, '本次合成原候选。');
    assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).history.versions[1].text, f.text);
    assert.equal(state.savedSession.turns[1].reply, null);
    assert.equal(state.savedSession.inputs[1].state, 'redacted');
    assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history, null);
    assert.equal(state.explicitCandidateSelection.selection, null);
    assert(!JSON.stringify(state).includes(independent.text));
  }
});

test('选择GET失效后完整权威读取缺失旧turn时不恢复其结果或版本，保留仍在的turn', async () => {
  const f = await fixture(), independent = appendCandidate(f);
  f.contacts.setDraft({ ...f.scope, text: '本次合成生成草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  let fail = true;
  f.records.failRequest = (request) => {
    if (fail && request.method === 'GET' && request.path.endsWith('/selections')) {
      fail = false; f.records.saved.turns.shift(); f.records.saved.inputs.shift(); f.records.selection = null;
      f.records.saved.current_input_version_id = independent.inputVersionId;
      return new f.BackendRequestFailure('response', 404, 'not_found');
    }
    return null;
  };
  await assert.rejects(f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId }));
  const state = await f.bridge.getState();
  assert.equal(state.result, null);
  assert.equal(state.savedSession.turns.length, 1);
  assert.equal(state.savedSession.turns[0].reply.candidates[0].text, independent.text);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).history, null);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history.versions[1].text,
    independent.text);
  assert.equal(state.explicitCandidateSelection.selection, null);
  assert(!JSON.stringify(state).includes('本次合成原候选。'));
});

test('已确认选择来源失效后权威重读连接失败清会话RAM，保留用户新输入', async () => {
  const f = await fixture();
  f.contacts.setDraft({ ...f.scope, text: '确认失效后仍保留用户新草稿。' });
  const options = { tone: 'warm', instruction: '确认失效后仍保留本次用户要求。', includeRelationshipContext: false };
  await f.bridge.updateOptions({ ...f.scope, options });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  f.records.failRequest = (request) => request.path.endsWith('/selections')
    ? new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable')
    : request.path.endsWith(`/assistant-sessions/${f.sessionId}`) ? new f.BackendRequestFailure('connection') : null;
  await assert.rejects(f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId }));
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'failed');
  assert.deepEqual(state.savedSession.turns, []);
  assert.deepEqual(state.savedSession.inputs, []);
  assert.equal(state.result, null);
  assert.equal(state.selectedCandidateId, null);
  assert.equal(state.explicitCandidateSelection.selection, null);
  assert.equal(state.candidateVersions.items[0].history, null);
  assert(!JSON.stringify(state).includes('本次合成原候选。'));
  assert(!JSON.stringify(state).includes(f.text));
  assert.deepEqual(state.options, options);
  assert.equal(f.contacts.getState().draft, '确认失效后仍保留用户新草稿。');
});

test('旧来源失效的完整权威复验迟到连接失败不清更新公开恢复视图', async () => {
  const f = await fixture();
  let fail = true, release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.failRequest = (request) => {
    if (fail && request.path.endsWith('/selections')) {
      fail = false;
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    }
    return null;
  };
  let slow = true;
  f.records.beforeResponse = (request) => {
    if (slow && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
      slow = false; reached();
      return new Promise((_resolve, reject) => { release = () => reject(new f.BackendRequestFailure('connection')); });
    }
  };
  const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId })
    .then(() => null, (error) => error);
  await blocked;
  const fresh = replaceSavedFixture(f);
  await f.bridge.readSavedSession(f.scope);
  release(); await reading;
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  assert.equal(state.savedSession.turns[0].reply.candidates[0].text, fresh.text);
  assert.equal(state.candidateVersions.items[0].history.versions[1].text, fresh.text);
  assert.equal(state.explicitCandidateSelection.selection.versionId, fresh.versionId);
});

test('版本读写连接与非来源冲突保留可恢复历史、原结果和用户输入', async () => {
  for (const operation of ['read', 'save', 'select']) {
    for (const failure of ['connection', 'server', 'conflict']) {
      const f = await fixture();
      f.contacts.setDraft({ ...f.scope, text: '连接失败仍保留本次新草稿。' });
      const options = { tone: 'concise', instruction: '用户本次要求仍在。', includeRelationshipContext: false };
      await f.bridge.updateOptions({ ...f.scope, options });
      await f.bridge.generate({ ...f.scope, newRequest: true });
      await f.bridge.readSavedSession(f.scope);
      f.records.failure = failure === 'connection' ? new f.BackendRequestFailure('connection')
        : failure === 'server' ? new f.BackendRequestFailure('response', 503, 'assistant_candidate_version_save_failed')
        : new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict');
      const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId };
      await assert.rejects(operation === 'read' ? f.bridge.readCandidateVersions(identity)
        : operation === 'save' ? f.bridge.saveCandidateVersion({ ...identity, editKey: randomUUID(), parentVersionId: f.versionId,
          messages: [{ messageId: f.messageId, text: '仍可重试保存的修改。' }], requirements: null })
          : f.bridge.selectCandidateVersion({ ...identity, versionId: f.versionId, selectionKey: randomUUID() }));
      const state = await f.bridge.getState();
      assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '本次合成原候选。');
      assert.equal(state.result.candidates[0].original.text, '本次合成原候选。');
      assert.equal(state.candidateVersions.items[0].history.versions[1].text, f.text);
      assert.equal(state.candidateVersions.items[0].displayVersionId, f.versionId);
      assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
      assert.deepEqual(state.options, options);
      assert.equal(f.contacts.getState().draft, '连接失败仍保留本次新草稿。');
    }
  }
});

test('旧scope、SID和generation的迟到来源404不能清除新公开视图', async () => {
  for (const change of ['scope', 'session', 'generation']) {
    const f = await fixture();
    let release, reached, slow = true;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.beforeResponse = (request) => {
      if (slow && request.path.includes(f.candidateId) && request.path.endsWith('/versions')) {
        slow = false; reached();
        return new Promise((_resolve, reject) => {
          release = () => reject(new f.BackendRequestFailure('response', 404, 'not_found'));
        });
      }
    };
    const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId });
    await blocked;
    const fresh = replaceSavedFixture(f, change === 'session' ? randomUUID() : f.sessionId);
    if (change === 'scope') {
      const contactId = randomUUID();
      f.records.contacts = [{ contactId, displayName: '另一合成联系人', messageCount: 0, sourceCount: 0 }];
      await f.contacts.refreshContacts();
      f.contacts.selectContact({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
      await f.bridge.readSavedSession({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
    } else if (change === 'session') await f.bridge.selectSavedSession({ ...f.scope, sessionId: fresh.sessionId });
    else {
      f.records.generation = 8;
      for (const listener of f.backendListeners) listener();
      await f.bridge.readSavedSession(f.scope);
    }
    release(); await reading;
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.sessionId, fresh.sessionId);
    assert.equal(state.savedSession.turns[0].reply.candidates[0].text, fresh.text);
    assert.equal(state.candidateVersions.items[0].history.versions[1].text, fresh.text);
    assert.equal(state.explicitCandidateSelection.selection.versionId, fresh.versionId);
    assert(!JSON.stringify(state).includes('本次合成原候选。'));
  }
});

test('独立B版本迟到404仍核验来源，保留明确展开的A及后端实际选择并离开loading', async () => {
  const f = await fixture(), independent = appendCandidate(f);
  await f.bridge.readSavedSession(f.scope);
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (request.path.includes(independent.candidateId) && request.path.endsWith('/versions')) {
      reached();
      return new Promise((_resolve, reject) => {
        release = () => { unavailableTurn(f.records, 1); reject(new f.BackendRequestFailure('response', 404, 'not_found')); };
      });
    }
  };
  const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: independent.candidateId });
  await blocked;
  await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.candidateId });
  release(); await assert.rejects(reading);
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '本次合成原候选。');
  assert.equal(state.savedSession.turns[1].state, 'redacted');
  assert.equal(state.savedSession.turns[1].reply, null);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).displayVersionId, f.candidateId);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history, null);
  assert.equal(state.candidateVersions.phase, 'ready');
  assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: {
    selectionId: f.records.selection.selection_id, selectionNumber: f.records.selection.selection_number,
    sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.versionId,
  } });
});

for (const status of [404, 409]) {
  test(`show独立于读取结果所有权，同源B迟到${status}清除已展开A的旧正文`, async () => {
    const f = await fixture(), dependent = appendCandidate(f, { text: '同源B删除后不能恢复的合成正文。' });
    await f.bridge.readSavedSession(f.scope);
    const fullReads = () => f.calls.filter((request) => request.method === 'GET'
      && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)).length;
    const beforeReads = fullReads();
    let release, reached, confirmed = false;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.beforeResponse = (request) => {
      if (!request.path.includes(dependent.candidateId) || !request.path.endsWith('/versions')) return;
      reached(); return new Promise((_resolve, reject) => {
        release = () => {
          confirmed = true; unavailableTurn(f.records); unavailableTurn(f.records, 1); f.records.selection = null;
          reject(status === 404 ? new f.BackendRequestFailure('response', 404, 'not_found')
            : new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable'));
        };
      });
    };
    const published = [], unsubscribe = f.bridge.onStateChanged((state) => { if (confirmed) published.push(state); });
    const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: dependent.candidateId });
    await blocked;
    await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.candidateId });
    assert.equal((await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === f.candidateId).displayVersionId,
      f.candidateId);
    release(); await assert.rejects(reading);
    unsubscribe();
    const state = await f.bridge.getState();
    assert.equal(fullReads(), beforeReads + 1);
    assert(state.savedSession.turns.every((turn) => turn.state === 'redacted' && turn.reply === null && turn.input === null));
    assert(state.savedSession.inputs.every((input) => input.state === 'redacted' && input.content === null));
    assert(state.candidateVersions.items.every((item) => item.history === null && item.displayVersionId === null));
    assert.equal(state.candidateVersions.phase, 'ready');
    assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: null });
    assert(published.length > 0);
    assert(published.every((event) => !JSON.stringify(event).includes(f.text) && !JSON.stringify(event).includes(dependent.text)
      && !JSON.stringify(event).includes('本次合成原候选。')));
    await assert.rejects(f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId,
      candidateId: f.candidateId, versionId: f.candidateId }));
  });
}

test('show已有A不废弃有效B版本读取，完成时保留A展示和后端实际选择', async () => {
  const f = await fixture(), independent = appendCandidate(f);
  await f.bridge.readSavedSession(f.scope);
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (!request.path.includes(independent.candidateId) || !request.path.endsWith('/versions')) return;
    reached(); return new Promise((resolve) => { release = resolve; });
  };
  const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: independent.candidateId });
  await blocked;
  await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.candidateId });
  release(); await reading;
  const state = await f.bridge.getState();
  assert.equal(state.candidateVersions.phase, 'ready');
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).displayVersionId, f.candidateId);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history.versions[1].text,
    independent.text);
  assert.equal(state.explicitCandidateSelection.phase, 'ready');
  assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
});

test('版本历史已到而实际选择GET在途时，show同候选旧版在读取收尾后仍保留且不隐式选择', async () => {
  const f = await fixture();
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (request.method !== 'GET' || !request.path.endsWith('/selections')) return;
    reached(); return new Promise((resolve) => { release = resolve; });
  };
  const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId });
  await blocked;
  await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.candidateId });
  assert.equal((await f.bridge.getState()).candidateVersions.items[0].displayVersionId, f.candidateId);
  release(); await reading;
  const state = await f.bridge.getState();
  assert.equal(state.candidateVersions.phase, 'ready');
  assert.equal(state.candidateVersions.items[0].displayVersionId, f.candidateId);
  assert.equal(state.candidateVersions.items[0].history.defaultDisplayVersionId, f.versionId);
  assert.equal(state.explicitCandidateSelection.phase, 'ready');
  assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
  assert(!f.calls.some((request) => request.method === 'POST' && request.path.endsWith('/selections')));
});

test('完整来源复验后reconcile选择GET在途，公开show有效A旧版保持展示和唯一实际选择', async () => {
  const f = await fixture(), independent = appendCandidate(f);
  await f.bridge.readSavedSession(f.scope);
  let confirmed = false, release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.failRequest = (request) => {
    if (!request.path.includes(independent.candidateId) || !request.path.endsWith('/versions')) return null;
    confirmed = true; unavailableTurn(f.records, 1);
    return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
  };
  f.records.beforeResponse = (request) => {
    if (!confirmed || request.method !== 'GET' || !request.path.endsWith('/selections')) return;
    reached(); return new Promise((resolve) => { release = resolve; });
  };
  const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: independent.candidateId })
    .then(() => null, (error) => error);
  await blocked;
  assert.equal((await f.bridge.getState()).sourceAvailability, undefined);
  await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.candidateId });
  assert.equal((await f.bridge.getState()).candidateVersions.items.find((item) => item.candidateId === f.candidateId).displayVersionId,
    f.candidateId);
  release(); assert(await reading);
  const state = await f.bridge.getState();
  assert.equal(state.candidateVersions.phase, 'ready');
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).displayVersionId, f.candidateId);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).history.defaultDisplayVersionId, f.versionId);
  assert.equal(state.explicitCandidateSelection.phase, 'ready');
  assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
  assert.equal(state.explicitCandidateSelection.selection.selectionId, f.records.selection.selection_id);
  assert.equal(state.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history, null);
  assert(!f.calls.some((request) => request.method === 'POST' && request.path.endsWith('/selections')));
});

test('同scope较新A读取接管后，迟到B的正式来源失效仍清同源旧正文，普通409不作删除', async () => {
  for (const reason of ['request_invalidated', 'candidate_unavailable', 'edit_key_conflict']) {
    const f = await fixture(), dependent = appendCandidate(f, { text: '同scope读取接管后需复验的合成B正文。' });
    await f.bridge.readSavedSession(f.scope);
    const fullReads = () => f.calls.filter((request) => request.method === 'GET'
      && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)).length;
    const beforeReads = fullReads();
    let release, reached;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.beforeResponse = (request) => {
      if (!request.path.includes(dependent.candidateId) || !request.path.endsWith('/versions')) return;
      reached(); return new Promise((_resolve, reject) => {
        release = () => {
          if (reason !== 'edit_key_conflict') {
            unavailableTurn(f.records); unavailableTurn(f.records, 1); f.records.selection = null;
          }
          reject(new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', reason));
        };
      });
    };
    const reading = f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: dependent.candidateId });
    await blocked;
    await f.bridge.readCandidateVersions({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId });
    await f.bridge.showCandidateVersion({ ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.candidateId });
    release();
    if (reason === 'edit_key_conflict') {
      await assert.doesNotReject(reading);
      const state = await f.bridge.getState();
      assert.equal(fullReads(), beforeReads);
      assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '本次合成原候选。');
      assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).displayVersionId, f.candidateId);
      assert.equal(state.explicitCandidateSelection.phase, 'ready');
      assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
    } else {
      await assert.rejects(reading);
      const state = await f.bridge.getState();
      assert.equal(fullReads(), beforeReads + 1);
      assert(state.savedSession.turns.every((turn) => turn.state === 'redacted' && turn.reply === null));
      assert(state.candidateVersions.items.every((item) => item.history === null));
      assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: null });
      assert(!JSON.stringify(state).includes(f.text));
      assert(!JSON.stringify(state).includes(dependent.text));
    }
  }
});

test('公开版本恢复404清除隐藏held结果，迟到依据成功不能恢复旧正文', async () => {
  const f = await fixture();
  f.contacts.setDraft({ ...f.scope, text: '本次合成生成输入。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.beforeResponse = (request) => {
    if (request.path.endsWith('/evidence')) {
      reached(); return new Promise((resolve) => { release = resolve; });
    }
  };
  const validating = f.replies.revalidateDeletedSource(f.scope.contactId);
  await blocked;
  assert.equal((await f.bridge.getState()).sourceAvailability, 'checking');
  f.records.failRequest = (request) => {
    if (!primaryCandidateOperation(request, f, 'read')) return null;
    unavailableTurn(f.records, 0, 'unavailable'); f.records.selection = null;
    return new f.BackendRequestFailure('response', 404, 'not_found');
  };
  await f.bridge.readSavedSession(f.scope);
  const unavailable = await f.bridge.getState();
  assert.equal(unavailable.result, null);
  assert.equal(unavailable.savedSession.turns[0].reply, null);
  assert.equal(unavailable.sourceAvailability, undefined);
  release(); await validating;
  const state = await f.bridge.getState();
  assert.equal(state.result, null);
  assert.equal(state.selectedCandidateId, null);
  assert.equal(state.savedSession.turns[0].reply, null);
  assert.equal(state.candidateVersions.items[0].history, null);
  assert.equal(state.explicitCandidateSelection.selection, null);
  assert(!JSON.stringify(state).includes('本次合成原候选。'));
  assert(!JSON.stringify(state).includes(f.text));
});

test('旧完整恢复的迟到读取不能在新删除快照后继续恢复旧候选', async () => {
  const f = await fixture(), secondId = randomUUID();
  const original = f.records.saved.turns[0].reply.candidates[0];
  f.records.saved.turns[0].reply.candidates.push({ ...original, candidate_id: secondId,
    messages: [{ message_id: secondId, text: original.text }] });
  let release, reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  let slow = true;
  f.records.beforeResponse = (request) => {
    if (slow && request.path.includes(f.candidateId) && request.path.endsWith('/versions')) {
      slow = false; reached(); return new Promise((resolve) => { release = resolve; });
    }
  };
  const earlier = f.bridge.readSavedSession(f.scope);
  await blocked;
  f.records.saved.turns[0] = { ...f.records.saved.turns[0], state: 'redacted', input: null, reply: null,
    placeholder: '相关来源已删除' };
  f.records.saved.inputs[0] = { ...f.records.saved.inputs[0], state: 'redacted', placeholder: '相关来源已删除' };
  f.records.selection = null; f.records.missingCandidates = new Set([secondId]);
  await f.bridge.readSavedSession(f.scope);
  release(); await earlier;
  const state = await f.bridge.getState();
  assert.deepEqual(state.candidateVersions.items, []);
  assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: null });
  assert(!JSON.stringify(state).includes(f.text));
});

for (const status of [404, 409]) {
  test(`来源选择核验接管的完整GET${status}清除generated重试快照及迟到响应`, async () => {
    const f = await fixture(), targetId = randomUUID(), targetText = '核验终态后不得恢复的合成目标正文。';
    f.records.messagePage = { messages: [{ message_id: targetId, speaker: 'contact', message_type: 'text',
      text: targetText, media_placeholder: null, occurred_at: '2026-10-11T01:00:00+00:00', quoted: null }], next_cursor: null };
    await f.bridge.setMode({ ...f.scope, mode: 'reply_to_message' });
    await f.bridge.selectMessage({ ...f.scope, messageId: targetId });
    f.records.explorationOutcome = { kind: 'generated', exploration_id: randomUUID(), confirmed_intent: '来源派生的合成方向。',
      turn: { ...f.records.saved.turns[0].reply, session_id: f.sessionId,
        input_version_id: f.records.saved.turns[0].input_version_id, state: 'completed' } };
    await f.bridge.explore(f.scope);
    await f.bridge.readSavedSession(f.scope);
    let releaseRetry, reachedRetry, releaseAuto, reachedAuto;
    const retryBlocked = new Promise((resolve) => { reachedRetry = resolve; });
    const autoBlocked = new Promise((resolve) => { reachedAuto = resolve; });
    let slowRetry = true, slowAuto = true, manual = false, selectionFailed = false;
    f.records.beforeResponse = (request) => {
      if (slowRetry && request.path.endsWith('/explorations')) {
        slowRetry = false; reachedRetry(); return new Promise((resolve) => { releaseRetry = resolve; });
      }
      if (slowAuto && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
        slowAuto = false; reachedAuto(); return new Promise((resolve) => { releaseAuto = resolve; });
      }
    };
    f.records.failRequest = (request) => {
      if (!selectionFailed && request.path.endsWith('/selections')) {
        selectionFailed = true;
        return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
      }
      if (manual && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) return status === 404
        ? new f.BackendRequestFailure('response', 404, 'not_found')
        : new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
      return null;
    };
    const retry = f.bridge.retryExploration(f.scope);
    await retryBlocked;
    const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
    await autoBlocked;
    manual = true;
    await f.bridge.readSavedSession(f.scope);
    const terminal = await f.bridge.getState();
    assert.equal(terminal.savedSession.phase, 'failed');
    assert.equal(terminal.exploration.phase, 'idle');
    assert.equal(terminal.direction, '');
    assert.equal(terminal.result, null);
    const published = [], unsubscribe = f.bridge.onStateChanged((state) => published.push(state));
    releaseAuto(); await reading;
    releaseRetry(); await retry;
    const postCount = f.calls.filter((request) => request.method === 'POST').length;
    await f.bridge.retryExploration(f.scope);
    unsubscribe();
    assert.equal(f.calls.filter((request) => request.method === 'POST').length, postCount);
    assert(published.every((state) => !JSON.stringify(state).includes(targetText)));
    assert(!JSON.stringify(await f.bridge.getState()).includes(targetText));
  });
}

test('完整GET终态也使尚未建立策略任务的在途探索身份失效', async () => {
  const f = await fixture();
  await f.bridge.setMode({ ...f.scope, mode: 'initiate_conversation' });
  await f.bridge.updatePurpose({ ...f.scope, purpose: '独立手写目的仍保留。' });
  f.records.explorationOutcome = { kind: 'generated', exploration_id: randomUUID(), confirmed_intent: '旧身份派生目的。',
    turn: { ...f.records.saved.turns[0].reply, session_id: f.sessionId,
      input_version_id: f.records.saved.turns[0].input_version_id, state: 'completed' } };
  let releaseIdentity, reachedIdentity, releaseAuto, reachedAuto, fullReads = 0;
  const identityBlocked = new Promise((resolve) => { reachedIdentity = resolve; });
  const autoBlocked = new Promise((resolve) => { reachedAuto = resolve; });
  f.records.beforeResponse = (request) => {
    if (!request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) return;
    if (++fullReads === 1) { reachedIdentity(); return new Promise((resolve) => { releaseIdentity = resolve; }); }
    if (fullReads === 2) { reachedAuto(); return new Promise((resolve) => { releaseAuto = resolve; }); }
  };
  let selectionFailed = false, manual = false;
  f.records.failRequest = (request) => {
    if (!selectionFailed && request.path.endsWith('/selections')) {
      selectionFailed = true;
      return new f.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict', 'source_unavailable');
    }
    return manual && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)
      ? new f.BackendRequestFailure('response', 404, 'not_found') : null;
  };
  const exploring = f.bridge.explore(f.scope);
  await identityBlocked;
  const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
  await autoBlocked;
  manual = true;
  await f.bridge.readSavedSession(f.scope);
  releaseAuto(); await reading;
  const before = f.calls.filter((request) => request.method === 'POST').length;
  releaseIdentity(); await exploring;
  assert.equal(f.calls.filter((request) => request.method === 'POST').length, before);
  const state = await f.bridge.getState();
  assert.equal(state.exploration.phase, 'idle');
  assert.equal(state.purpose, '独立手写目的仍保留。');
  assert.equal(state.result, null);
});

for (const checkpoint of ['DELETE受理', 'task成功']) {
  test(`${checkpoint}来源检查点接管版本核验后公开保留独立讨论，不滞留loading`, async () => {
    const f = await fixture(), independent = appendCandidate(f);
    f.records.messagePage = { messages: [], next_cursor: null };
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '检查点后保留独立手写草稿。' });
    let release, reached, slow = true, failed = false;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.records.failRequest = (request) => {
      if (!failed && primaryCandidateOperation(request, f, 'read')) {
        failed = true; unavailableTurn(f.records); f.records.selection = null;
        return new f.BackendRequestFailure('response', 404, 'not_found');
      }
      return null;
    };
    f.records.beforeResponse = (request) => {
      if (slow && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
        slow = false; reached(); return new Promise((resolve) => { release = resolve; });
      }
    };
    const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
    await blocked;
    await assert.doesNotReject(f.replies.revalidateDeletedSource(f.scope.contactId));
    const accepted = await f.bridge.getState();
    assert.equal(accepted.savedSession.phase, 'ready');
    assert.equal(accepted.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text, independent.text);
    assert.equal(accepted.candidateVersions.items.find((item) => item.candidateId === independent.candidateId).history.versions[1].text, independent.text);
    assert.equal(accepted.sourceAvailability, undefined);
    assert.equal(f.contacts.getState().draft, '检查点后保留独立手写草稿。');
    release(); await reading;
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.phase, 'ready');
    assert(!JSON.stringify(state).includes(f.text));
  });
}

for (const operation of ['read', 'save', 'select']) {
  for (const reason of ['request_invalidated', 'candidate_unavailable']) {
    test(`真实JsonClient传输${reason}使公开${operation}清除失效候选和输入快照`, async (t) => {
      const f = await fixture(), independent = appendCandidate(f);
      f.contacts.setDraft({ ...f.scope, text: '终态保留独立手写草稿。' });
      await f.bridge.generate({ ...f.scope, newRequest: true });
      await f.bridge.readSavedSession(f.scope);
      await f.bridge.setMode({ ...f.scope, mode: 'initiate_conversation' });
      await f.bridge.updatePurpose({ ...f.scope, purpose: '终态保留独立手写目的。' });
      const transport = await conflictTransport(t, f,
        { error: 'assistant_candidate_version_conflict', reason },
        (request) => primaryCandidateOperation(request, f, operation),
        () => { unavailableTurn(f.records, 0, 'unavailable'); f.records.selection = null; });
      await assert.rejects(candidateOperation(f, operation));
      assert.equal(transport.requests.length, 1);
      const state = await f.bridge.getState();
      assert.equal(state.savedSession.turns[0].reply, null);
      assert.equal(state.result, null);
      assert.equal(state.explicitCandidateSelection.selection, null);
      assert.equal(state.candidateVersions.items.find((item) => item.candidateId === f.candidateId).history, null);
      assert(!JSON.stringify(state).includes(f.text));
      assert(!JSON.stringify(state).includes('本次合成草稿。'));
      assert.equal(state.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text, independent.text);
      assert.equal(state.purpose, '终态保留独立手写目的。');
      assert.equal(f.contacts.getState().draft, '终态保留独立手写草稿。');
    });
  }
}

for (const operation of ['read', 'save', 'select']) {
  test(`真实JsonClient普通409使公开${operation}保留已有历史与实际选择`, async (t) => {
    for (const reason of ['edit_key_conflict', 'selection_key_conflict', undefined, '原始 SQL 与合成私密正文']) {
      const f = await fixture();
      f.contacts.setDraft({ ...f.scope, text: '普通冲突保留本次新草稿。' });
      await f.bridge.generate({ ...f.scope, newRequest: true });
      await f.bridge.readSavedSession(f.scope);
      const transport = await conflictTransport(t, f,
        { error: 'assistant_candidate_version_conflict', ...(reason ? { reason } : {}) },
        (request) => primaryCandidateOperation(request, f, operation));
      await assert.rejects(candidateOperation(f, operation));
      assert.equal(transport.requests.length, 1);
      const state = await f.bridge.getState();
      assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '本次合成原候选。');
      assert.equal(state.result.candidates[0].original.text, '本次合成原候选。');
      assert.equal(state.candidateVersions.items[0].history.versions[1].text, f.text);
      assert.equal(state.explicitCandidateSelection.selection.versionId, f.versionId);
      assert(!JSON.stringify(state).includes('原始 SQL 与合成私密正文'));
    }
  });
}

test('真实JsonClient只保留稳定终态reason白名单，不暴露任意后端字符串', async (t) => {
  const f = await fixture();
  for (const reason of ['request_invalidated', 'candidate_unavailable', 'source_unavailable',
    'skill_policy_changed',
    'target_message_unavailable', 'edit_key_conflict', 'selection_key_conflict', '原始 SQL 与合成私密正文']) {
    const transport = await conflictTransport(t, f, { error: 'assistant_candidate_version_conflict', reason }, () => true);
    await assert.rejects(transport.client.perform({ method: 'GET', path: '/api/synthetic-version-contract' }), (error) => {
      assert(error instanceof f.BackendRequestFailure);
      assert.equal(error.kind, 'response');
      assert.equal(error.status, 409);
      assert.equal(error.reason, ['request_invalidated', 'candidate_unavailable', 'source_unavailable',
        'skill_policy_changed',
        'target_message_unavailable'].includes(reason) ? reason : undefined);
      assert(!JSON.stringify(error).includes('原始 SQL 与合成私密正文'));
      return true;
    });
  }
});

test('检查点接管的未知读取故障保持隔离，同范围公开重试完成后旧响应无副作用', async () => {
  const f = await fixture(), independent = appendCandidate(f);
  f.records.messagePage = { messages: [], next_cursor: null };
  await f.bridge.readSavedSession(f.scope);
  let release, reached, slow = true, failed = false, takeoverFailure = false;
  const blocked = new Promise((resolve) => { reached = resolve; });
  f.records.failRequest = (request) => {
    if (!failed && primaryCandidateOperation(request, f, 'read')) {
      failed = true; unavailableTurn(f.records); f.records.selection = null;
      return new f.BackendRequestFailure('response', 404, 'not_found');
    }
    return takeoverFailure && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)
      ? new f.BackendRequestFailure('connection') : null;
  };
  f.records.beforeResponse = (request) => {
    if (slow && request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
      slow = false; reached(); return new Promise((resolve) => { release = resolve; });
    }
  };
  const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
  await blocked;
  takeoverFailure = true;
  await assert.doesNotReject(f.replies.revalidateDeletedSource(f.scope.contactId));
  assert.equal((await f.bridge.getState()).sourceAvailability, 'failed');
  assert.equal((await f.bridge.getState()).savedSession.phase, 'failed');
  assert(!(await f.bridge.getState()).savedSession.turns.length);
  takeoverFailure = false;
  await f.bridge.readSavedSession(f.scope);
  release(); await reading;
  const state = await f.bridge.getState();
  assert.equal(state.savedSession.phase, 'ready');
  assert.equal(state.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text, independent.text);
  assert.equal(state.sourceAvailability, undefined);
  assert(!JSON.stringify(state).includes(f.text));
});

test('检查点接管后旧scope的完整读取迟到，不修改新联系人的公开恢复视图', async () => {
  const f = await fixture();
  let releaseAuto, releaseCheckpoint, reachedAuto, reachedCheckpoint, reads = 0, failed = false;
  const autoBlocked = new Promise((resolve) => { reachedAuto = resolve; });
  const checkpointBlocked = new Promise((resolve) => { reachedCheckpoint = resolve; });
  f.records.failRequest = (request) => {
    if (!failed && primaryCandidateOperation(request, f, 'read')) {
      failed = true;
      return new f.BackendRequestFailure('response', 404, 'not_found');
    }
    return null;
  };
  f.records.beforeResponse = (request) => {
    if (!request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) return;
    if (++reads === 1) { reachedAuto(); return new Promise((resolve) => { releaseAuto = resolve; }); }
    if (reads === 2) { reachedCheckpoint(); return new Promise((resolve) => { releaseCheckpoint = resolve; }); }
  };
  const reading = candidateOperation(f, 'read').then(() => null, (error) => error);
  await autoBlocked;
  const checkpoint = f.replies.revalidateDeletedSource(f.scope.contactId);
  await checkpointBlocked;
  const fresh = replaceSavedFixture(f), contactId = randomUUID();
  f.records.contacts = [{ contactId, displayName: '检查点接管后另一合成联系人', messageCount: 0, sourceCount: 0 }];
  await f.contacts.refreshContacts();
  f.contacts.selectContact({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
  await f.bridge.readSavedSession({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
  const before = await f.bridge.getState();
  releaseAuto(); await reading;
  releaseCheckpoint(); await checkpoint;
  const state = await f.bridge.getState();
  assert.equal(state.revision, before.revision);
  assert.equal(state.contactId, contactId);
  assert.equal(state.savedSession.turns[0].reply.candidates[0].text, fresh.text);
  assert.equal(state.candidateVersions.items[0].history.versions[1].text, fresh.text);
});

for (const reason of ['request_invalidated', 'candidate_unavailable']) {
  test(`真实JsonClient选择GET的${reason}复验各公开操作及恢复协调`, async (t) => {
    for (const operation of ['read', 'save', 'select', 'reconcile']) {
      const f = await fixture(), independent = appendCandidate(f);
      await f.bridge.readSavedSession(f.scope);
      let failed = false;
      const transport = await conflictTransport(t, f, { error: 'assistant_candidate_version_conflict', reason },
        (request) => !failed && request.method === 'GET' && request.path.endsWith('/selections'),
        () => { failed = true; unavailableTurn(f.records); f.records.selection = null; });
      if (operation === 'reconcile') await f.bridge.readSavedSession(f.scope);
      else await assert.rejects(candidateOperation(f, operation));
      assert.equal(transport.requests.length, 1);
      const state = await f.bridge.getState();
      assert.equal(state.savedSession.turns[0].reply, null);
      assert(!JSON.stringify(state).includes(f.text));
      assert.equal(state.savedSession.turns.find((turn) => turn.turnId === independent.turnId).reply.candidates[0].text, independent.text);
      assert.equal(state.sourceAvailability, undefined);
    }
  });
}


test('提交已核验版本草稿只通知一次输入门禁，不写版本或选择', async () => {
  const f = await fixture();
  let notices = 0;
  const stop = f.replies.onInputChanged(() => { notices++; });
  const before = await f.bridge.getState(), calls = f.calls.length;
  try {
    const state = await f.bridge.updateCandidateVersionDraft({ ...f.scope, sessionId: f.sessionId,
      candidateId: f.candidateId, versionId: f.versionId,
      messages: [{ messageId: f.messageId, text: '尚未保存的完整编辑。' }], requirements: '只改本组。' });
    assert.equal(notices, 1);
    assert.equal(f.calls.length, calls);
    assert.deepEqual(state.candidateVersions, before.candidateVersions);
    assert.deepEqual(state.explicitCandidateSelection, before.explicitCandidateSelection);
    assert.deepEqual(state.savedSession, before.savedSession);
    assert.equal(state.candidateDrafts[0].messages[0].text, '尚未保存的完整编辑。');
    assert.equal(f.handlers.get('reply:update-candidate-version-draft').role, 'helper');
  } finally { stop(); }
});

test('完整草稿正文与所属当前结果一起更新，只改要求不覆盖正文投影', async () => {
  const f = await fixture();
  f.contacts.setDraft({ ...f.scope, text: '本次合成生成输入。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.versionId };
  const original = (await f.bridge.getState()).result.candidates[0];
  let notices = 0;
  const observed = [];
  const stopInput = f.replies.onInputChanged(() => { notices++; });
  const stopState = f.bridge.onStateChanged((state) => observed.push(state));
  try {
    // 显示保存版本的文字与当前结果投影可以不同；仅要求变化不能将二者强行同步。
    const requirementsOnly = await f.bridge.updateCandidateVersionDraft({ ...identity,
      messages: [{ messageId: f.messageId, text: f.text }], requirements: '只修改本组要求。' });
    assert.equal(requirementsOnly.result.candidates[0].editedText, original.editedText);
    const edited = await f.bridge.updateCandidateVersionDraft({ ...identity,
      messages: [{ messageId: f.messageId, text: '已改的完整正文。' }], requirements: '只修改本组要求。' });
    assert.equal(edited.result.candidates[0].editedText, '已改的完整正文。');
    assert.equal(edited.candidateDrafts[0].messages[0].text, '已改的完整正文。');
    assert.deepEqual(edited.result.candidates[0].original, original.original);
    assert(observed.every((state) => state.candidateDrafts?.[0]?.messages[0]?.text !== '已改的完整正文。'
      || state.result.candidates[0].editedText === '已改的完整正文。'));
    const reverted = await f.bridge.updateCandidateVersionDraft({ ...identity,
      messages: [{ messageId: f.messageId, text: f.text }], requirements: '恢复保存的正文。' });
    assert.equal(reverted.result.candidates[0].editedText, f.text);
    assert.equal(notices, 3);
  } finally { stopInput(); stopState(); }
});

test('历史候选可保留草稿，但不能改写另一生成轮次的当前结果', async () => {
  const f = await fixture(), historical = appendCandidate(f);
  f.contacts.setDraft({ ...f.scope, text: '本次当前生成输入。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  await f.bridge.readSavedSession(f.scope);
  const before = await f.bridge.getState();
  const history = before.candidateVersions.items.find((item) => item.candidateId === historical.candidateId).history;
  const state = await f.bridge.updateCandidateVersionDraft({ ...f.scope, sessionId: f.sessionId,
    candidateId: historical.candidateId, versionId: historical.versionId,
    messages: [{ ...history.versions[1].messages[0], text: '只属于历史候选的修改。' }], requirements: '' });
  assert.equal(state.candidateDrafts[0].messages[0].text, '只属于历史候选的修改。');
  assert.deepEqual(state.result, before.result);
});

for (const checkpoint of ['表达偏好删除中', '保留内容来源复验中', '候选来源复验中']) {
  test(`完整草稿在${checkpoint}拒绝且没有输入通知`, async () => {
    const f = await fixture();
    const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.versionId,
      messages: [{ messageId: f.messageId, text: '来源待核验时不能保留的编辑。' }], requirements: '' };
    let release, reached, pending;
    const blocked = new Promise((resolve) => { reached = resolve; });
    if (checkpoint === '表达偏好删除中') f.replies.beginExpressionPreferenceDeletion();
    else {
      f.records.beforeResponse = (request) => {
        if (request.path.endsWith(`/assistant-sessions/${f.sessionId}`)) {
          reached(); return new Promise((resolve) => { release = resolve; });
        }
      };
      if (checkpoint === '保留内容来源复验中') pending = f.replies.revalidateDeletedSource(f.scope.contactId);
      else {
        f.records.failRequest = (request) => primaryCandidateOperation(request, f, 'read')
          ? new f.BackendRequestFailure('response', 404, 'not_found') : null;
        pending = candidateOperation(f, 'read').catch(() => {});
      }
      await blocked;
      await new Promise((resolve) => setImmediate(resolve));
    }
    let notices = 0;
    const stop = f.replies.onInputChanged(() => { notices++; });
    const before = await f.bridge.getState();
    try {
      await assert.rejects(f.bridge.updateCandidateVersionDraft(identity));
      assert.equal(notices, 0);
      assert.deepEqual(await f.bridge.getState(), before);
    } finally {
      stop(); f.records.beforeResponse = undefined; f.records.failRequest = undefined;
      release?.(); if (pending) await pending;
    }
  });
}

test('草稿拒绝不属于当前显示版本的身份和无效消息，且不通知输入变化', async () => {
  const f = await fixture();
  let notices = 0;
  const stop = f.replies.onInputChanged(() => { notices++; });
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.versionId,
    messages: [{ messageId: f.messageId, text: '完整草稿。' }], requirements: '' };
  const before = await f.bridge.getState();
  try {
    for (const request of [
      { ...identity, contactId: randomUUID() }, { ...identity, scopeRevision: identity.scopeRevision + 1 },
      { ...identity, sessionId: randomUUID() }, { ...identity, candidateId: randomUUID() },
      { ...identity, versionId: randomUUID() }, { ...identity, versionId: f.candidateId },
      { ...identity, text: '不能传入的合成正文。' }, { ...identity, versionId: null },
      { ...identity, messages: [{ messageId: randomUUID(), text: '错误消息身份。' }] },
      { ...identity, messages: [...identity.messages, { messageId: randomUUID(), text: '多余消息。' }] },
    ]) await assert.rejects(async () => f.bridge.updateCandidateVersionDraft(request));
    assert.equal(notices, 0);
    await assert.rejects(async () => f.bridge.updateCandidateVersionDraft(identity, identity));
    await assert.rejects(async () => f.bridge.updateCandidateVersionDraft());
    assert.equal(notices, 0);
    assert.deepEqual(await f.bridge.getState(), before);
  } finally { stop(); }
});

for (const scenario of ['旧空读取', '旧非空读取', '权威current变化', '较新current变化', '来源不可用', '较新来源不可用', '其他联系人', '外来会话快照', '宿主隐藏', '操作取消']) {
  test(`完成确认的新HTTP快照与${scenario}保持读取和范围优先级`, { timeout: 5000 }, async (t) => {
    const f = await fixture();
    const turn = structuredClone(f.records.saved.turns[0]), input = structuredClone(f.records.saved.inputs[0]);
    const sessionId = randomUUID(), token = randomUUID();
    const base = `/api/contacts/${f.scope.contactId}/assistant-sessions/${sessionId}`;
    let authority = { session_id: sessionId, current_input_version_id: null, turns: [], inputs: [] };
    let getCount = 0, preparedKey, formalCount = 0, holdReads = false;
    const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
    const oldCaptured = gate(), freshCaptured = gate(), releaseOld = gate(), releaseFresh = gate();
    const changeCurrent = () => {
      const other = { ...input, input_version_id: randomUUID(), turn_id: null, type: 'purpose_exploration',
        content: { type: 'purpose_exploration', correction: '', requirements: '', answer: '', confirmed_intent: '',
          skill_mode: 'auto', skill_version_id: null, purpose_hint: '本次独立合成讨论。' } };
      authority = { ...authority, current_input_version_id: other.input_version_id, inputs: [...authority.inputs, other] };
    };
    const invalidateSource = () => {
      authority = { ...authority,
        turns: [{ ...turn, state: 'unavailable', input: null, reply: null, placeholder: '相关来源不可用' }],
        inputs: [{ ...input, state: 'unavailable', content: null, placeholder: '相关来源不可用' }] };
    };
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        let payload;
        if (request.method === 'POST' && request.url.endsWith('/assistant-sessions')) payload = { session_id: sessionId };
        else if (request.method === 'POST' && request.url === `${base}/replies/prepare`) {
          preparedKey = body.idempotency_key; turn.request_key = preparedKey;
          payload = { session_id: sessionId, turn_id: turn.turn_id, request_key: preparedKey,
            input_version_id: input.input_version_id, state: 'running' };
        } else if (request.method === 'POST' && request.url === `${base}/replies`) {
          formalCount += 1; assert.equal(body.idempotency_key, preparedKey);
          authority = { session_id: sessionId, current_input_version_id: input.input_version_id,
            turns: [turn], inputs: [input] };
          payload = { ...turn.reply, session_id: sessionId, turn_id: turn.turn_id,
            input_version_id: input.input_version_id, state: 'completed' };
        } else if (request.method === 'GET' && request.url === base) {
          if (holdReads && getCount === 1 && scenario === '权威current变化') changeCurrent();
          if (holdReads && getCount === 1 && scenario === '来源不可用') invalidateSource();
          if (holdReads && getCount === 1 && scenario === '外来会话快照') authority = { ...authority, session_id: randomUUID() };
          payload = structuredClone(authority);
          if (holdReads && ++getCount === 1) { oldCaptured.resolve(); await releaseOld.promise; }
          else if (holdReads && getCount === 2) { freshCaptured.resolve(); await releaseFresh.promise; }
        } else throw new Error('未声明的合成HTTP路由');
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
      } catch {
        response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'synthetic_mock_failure' }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new f.JsonClient({ port: server.address().port, token });
    t.after(async () => {
      releaseOld.resolve(); releaseFresh.resolve(); client.cancelPending();
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    });
    f.records.history.session_id = sessionId; f.records.selection = null;
    f.records.transport = { client, matches: (request) => request.path === base || request.path.startsWith(`${base}/replies`)
      || request.method === 'POST' && request.path.endsWith('/assistant-sessions') };
    await f.bridge.newSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '迟到读取回归的合成草稿。' });
    if (scenario === '旧非空读取') changeCurrent();
    holdReads = true;
    const oldRead = f.bridge.readSavedSession(f.scope); await oldCaptured.promise;
    const generating = f.bridge.generate({ ...f.scope, newRequest: true }); await freshCaptured.promise;
    releaseOld.resolve(); await oldRead;
    if (scenario === '较新current变化') {
      changeCurrent(); await f.bridge.readSavedSession(f.scope);
    } else if (scenario === '较新来源不可用') {
      invalidateSource(); await f.bridge.readSavedSession(f.scope);
    } else if (scenario === '其他联系人') {
      const contactId = randomUUID();
      f.records.saved = { session_id: randomUUID(), current_input_version_id: null, turns: [], inputs: [] };
      f.records.contacts = [{ contactId, displayName: '另一位合成联系人', messageCount: 0, sourceCount: 0 }];
      await f.contacts.refreshContacts();
      f.contacts.selectContact({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
      await f.bridge.readSavedSession({ contactId, scopeRevision: f.contacts.getState().scopeRevision });
    } else if (scenario === '宿主隐藏') f.replies.notifyHelperLifecycle('hidden');
    else if (scenario === '操作取消') f.contacts.setDraft({ ...f.scope, text: '改为另一份合成草稿。' });
    releaseFresh.resolve(); await generating;
    const state = await f.bridge.getState();
    assert.equal(formalCount, 1);
    if (scenario === '旧空读取' || scenario === '旧非空读取') {
      assert.equal(authority.current_input_version_id, input.input_version_id);
      assert.equal(authority.turns[0].request_key, preparedKey);
      assert.equal(authority.turns[0].state, 'completed');
      assert.equal(authority.inputs[0].state, 'active');
      assert.equal(state.phase, 'ready');
      assert.equal(state.result.assistantSessionId, sessionId);
      assert.equal(state.result.inputVersionId, input.input_version_id);
      assert.equal(state.result.replyRequestId, turn.reply.reply_request_id);
      assert.equal(state.result.candidates[0].original.candidateId, turn.reply.candidates[0].candidate_id);
    } else {
      if (scenario !== '较新来源不可用') assert.notEqual(state.phase, 'waiting');
      assert.equal(state.result, null);
      if (scenario === '较新current变化' || scenario === '权威current变化') {
        assert.notEqual(authority.current_input_version_id, input.input_version_id);
      }
      if (scenario === '较新来源不可用' || scenario === '来源不可用') assert.equal(state.savedSession.turns[0].state, 'unavailable');
      if (scenario === '其他联系人') assert.notEqual(state.contactId, f.scope.contactId);
      if (scenario === '外来会话快照') assert.equal(state.phase, 'failed');
    }
  });
}

test('轻量输入命令保留候选编辑、独立版本和范围门禁，不回传完整历史', async () => {
  const f = await fixture();
  const identity = { ...f.scope, sessionId: f.sessionId, candidateId: f.candidateId, versionId: f.versionId };
  const before = await f.bridge.getState(), observed = [];
  const unsubscribe = f.bridge.onStateChanged(state => observed.push(state));
  try {
    const result = await f.bridge.updateInput({ type: 'candidateDraft', update: { ...identity,
      messages: [{ messageId: f.messageId, text: '轻量路径尚未保存的完整正文。' }], requirements: '只改当前版本。' } });
    assert.equal(result, undefined);
    const edited = await f.bridge.getState();
    assert.equal(edited.candidateDrafts[0].messages[0].text, '轻量路径尚未保存的完整正文。');
    assert.equal(observed.at(-1).candidateDrafts[0].requirements, '只改当前版本。');
    assert.deepEqual(edited.savedSession, before.savedSession);
    assert.deepEqual(edited.candidateVersions, before.candidateVersions);
    assert.deepEqual(edited.explicitCandidateSelection, before.explicitCandidateSelection);
    await assert.rejects(f.bridge.updateInput({ type: 'candidateDraft', update: { ...identity, scopeRevision: identity.scopeRevision - 1,
      messages: [{ messageId: f.messageId, text: '迟到编辑不得覆盖。' }], requirements: '' } }));
    assert.equal((await f.bridge.getState()).candidateDrafts[0].messages[0].text, '轻量路径尚未保存的完整正文。');
    assert.equal(f.handlers.get('reply:update-input').role, 'helper');
    await assert.rejects(f.bridge.updateInput({ type: 'generate', update: f.scope }));
  } finally { unsubscribe(); }
});
