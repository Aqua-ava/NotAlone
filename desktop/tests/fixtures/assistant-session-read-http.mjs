import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

// 生产公开 RPC、真实认证 HTTP 和默认传输上限；不启动浏览器或 App。
let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
assert.deepEqual(Object.keys(process.env).filter((key) => key.startsWith('LANGSMITH_') || key.startsWith('LANGCHAIN_')).sort(),
  ['LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING']);
assert(['LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING'].every((key) => process.env[key] === 'false'));
const output = await build({ stdin: { contents: `
  export { JsonClient } from './src/main/backend/json-client';
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { JsonClient, ContactSession, installReplyBridge, createReplyBridge } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const transport = new JsonClient({ port: fixture.port, token: fixture.token });
const calls = [], parts = [], failures = [], capFailures = [];
let generation = 7;
let triggered = false, changedInput;
const base = `/api/contacts/${fixture.contactId}/assistant-sessions/${fixture.sessionId}`;
let faultServer, faultTransport, faultBodyBytes, faultFailure;
if (['misleading-oversize-code', 'oversized-server-error'].includes(fixture.mode)) {
  faultServer = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${fixture.token}`);
    assert.equal(request.url, base);
    const body = JSON.stringify({ error: 'response_too_large',
      ...(fixture.mode === 'oversized-server-error' ? { padding: 'x'.repeat(1_048_576) } : {}) });
    faultBodyBytes = Buffer.byteLength(body);
    response.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': faultBodyBytes });
    response.end(body);
  });
  await new Promise((resolve) => faultServer.listen(0, '127.0.0.1', resolve));
  faultTransport = new JsonClient({ port: faultServer.address().port, token: fixture.token });
}
async function deleteSource() {
  const deleted = await transport.perform({ method: 'DELETE', path: `/api/contacts/${fixture.contactId}/sources/${fixture.sourceId}` });
  assert.equal(deleted.status, 202);
  if (fixture.mode === 'source-pending') return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await transport.perform({ method: 'GET', path: `/api/contacts/${fixture.contactId}/sources` });
    const source = response.data.sources.find((item) => item.source_id === fixture.sourceId);
    assert.notEqual(source.task_status, 'failed');
    if (source.status === 'deleted' && source.task_status === 'succeeded') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('合成来源删除未在时限内完成。');
}
async function appendNewInput() {
  const changed = await transport.perform({ method: 'POST', path: `${base}/inputs`, body: {
    content: { type: 'purpose_exploration', purpose_hint: '新的合成讨论，应覆盖迟到读取。' },
    expected_input_version_id: fixture.expectedInputIds.at(-1),
  } });
  changedInput = changed.data.input_version_id;
}
const backend = { getConnectionGeneration: () => generation, requestJson: async (request) => {
  const requestedGeneration = generation;
  calls.push({ method: request.method, path: request.path, enlarged: request.maxResponseBytes !== undefined });
  if (!triggered && request.path === base && faultTransport) {
    triggered = true;
    try { await faultTransport.perform(request); }
    catch (error) { faultFailure = { kind: error.kind, status: error.status, code: error.code }; throw error; }
  }
  const middle = request.path.startsWith(`${base}?read_part=1&`);
  if (!triggered && middle && ['source-deleted', 'source-pending', 'session-deleted', 'current-changed'].includes(fixture.mode)) {
    triggered = true;
    if (fixture.mode.startsWith('source-')) await deleteSource();
    else if (fixture.mode === 'session-deleted') await transport.perform({ method: 'DELETE', path: base, body: { confirmed: true } });
    else await appendNewInput();
  }
  try {
    const response = await transport.perform(request);
    if (response.data?.payload_fragment !== undefined) parts.push(response.data);
    if (!triggered && response.data?.payload_fragment !== undefined) {
      if (fixture.mode === 'final-source-deleted' && response.data.next_part === null) {
        triggered = true; await deleteSource();
      } else if (middle && ['late-contact', 'late-generation', 'late-operation'].includes(fixture.mode)) {
        triggered = true;
        if (fixture.mode !== 'late-contact') await appendNewInput();
        if (fixture.mode === 'late-generation') {
          generation += 1; contacts.setConnection(generation); await contacts.refreshContacts();
        }
        if (fixture.mode === 'late-contact') {
          contacts.selectContact({ contactId: fixture.otherContactId, scopeRevision: contacts.getState().scopeRevision });
        } else if (fixture.mode === 'late-generation') {
          contacts.selectContact({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
        }
        await bridge.readSavedSession({ contactId: contacts.getState().selectedContactId,
          scopeRevision: contacts.getState().scopeRevision });
      } else if (middle && fixture.mode?.startsWith('invalid-')) {
        triggered = true;
        const part = response.data;
        if (fixture.mode === 'invalid-session') part.session_id = randomUUID();
        else if (fixture.mode === 'invalid-current') part.current_input_version_id = randomUUID();
        else if (fixture.mode === 'invalid-order') part.part_number = 0;
        else if (fixture.mode === 'invalid-count') part.part_count += 1;
        else if (fixture.mode === 'invalid-bytes') part.payload_bytes += 1;
        else if (fixture.mode === 'invalid-fragment') part.payload_fragment = part.payload_fragment.replace('甲', '乙');
        else if (fixture.mode === 'invalid-id') part.read_id = '0'.repeat(64);
        else if (fixture.mode === 'invalid-surrogate') part.payload_fragment = '\ud800' + part.payload_fragment.slice(1);
        else if (fixture.mode === 'invalid-fields') part.owner_id = randomUUID();
      }
    }
    return { generation: requestedGeneration, data: response.data };
  } catch (error) {
    if (request.path === base) capFailures.push({ kind: error.kind, code: error.code });
    if (request.path.startsWith(`${base}?read_part=`)) failures.push({ status: error.status, code: error.code, reason: error.reason });
    throw error;
  }
}, onStateChanged: () => () => {}, subscribeMessages: (observer) => observer.connected() };
const contacts = new ContactSession(async () => ({ generation,
  contacts: [fixture.contactId, fixture.otherContactId].filter(Boolean).map((contactId) =>
    ({ contactId, displayName: '合成完整历史联系人', messageCount: 0, sourceCount: 0 })) }));
const handlers = new Map();
installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, backend, contacts);
const bridge = createReplyBridge({ invoke: (channel, ...args) => handlers.get(channel)(...args),
  on: () => {}, removeListener: () => {} });
try {
  contacts.setConnection(generation); await contacts.refreshContacts();
  contacts.selectContact({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
  await bridge.readSavedSession({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
  const state = await bridge.getState();
  if (fixture.mode) {
    assert(triggered, '故障或迟到必须发生在真实有界读取期间。');
    assert(calls.every((call) => !call.enlarged));
    if (fixture.mode.startsWith('late-')) {
      assert.equal(state.savedSession.phase, 'ready');
      if (fixture.mode === 'late-contact') {
        assert.equal(state.contactId, fixture.otherContactId);
        assert.notEqual(state.savedSession.sessionId, fixture.sessionId);
        assert.deepEqual(state.savedSession.inputs, []); assert.deepEqual(state.savedSession.turns, []);
      } else {
        assert.equal(state.savedSession.currentInputVersionId, changedInput);
        assert.equal(state.savedSession.inputs.at(-1).content.purposeHint, '新的合成讨论，应覆盖迟到读取。');
      }
    } else {
      assert.equal(state.savedSession.phase, 'failed');
      assert.deepEqual(state.savedSession.inputs, []); assert.deepEqual(state.savedSession.turns, []);
      assert.equal(state.result, null);
      if (fixture.mode === 'session-deleted') assert(failures.some((item) => item.status === 404 && item.code === 'not_found'));
      else if (fixture.mode === 'current-changed') assert(failures.some((item) => item.status === 409 && item.code === 'assistant_session_read_changed'));
      else if (fixture.mode.includes('source')) assert(failures.some((item) => item.status === 409 && item.reason === 'source_unavailable'), JSON.stringify(failures));
      if (fixture.mode === 'misleading-oversize-code') assert(!calls.some((call) => call.path.startsWith(`${base}?read_part=`)));
      if (fixture.mode === 'oversized-server-error') {
        assert(faultBodyBytes > 1_048_576);
        assert.equal(faultFailure.kind, 'response');
        assert.equal(faultFailure.status, 503);
        assert(!calls.some((call) => call.path.startsWith(`${base}?read_part=`)));
      }
    }
    process.stdout.write(JSON.stringify({ triggered, phase: state.savedSession.phase, failures, requests: calls.length,
      faultBodyBytes, faultFailure }));
  } else {
  assert.equal(state.savedSession.phase, 'ready', '完整保存历史必须可查看。');
  assert.equal(state.savedSession.sessionId, fixture.sessionId);
  if (fixture.expectedTexts) assert.deepEqual(state.savedSession.inputs.filter((item) => item.type === 'purpose_exploration')
    .map((item) => item.content.purposeHint), fixture.expectedTexts);
  assert.deepEqual(state.savedSession.inputs.map((item) => item.inputVersionId), fixture.expectedInputIds);
  assert.equal(state.savedSession.currentInputVersionId, Object.hasOwn(fixture, 'expectedCurrentInputId')
    ? fixture.expectedCurrentInputId : fixture.expectedInputIds.at(-1));
  if (fixture.expectedRedactedId) {
    const erased = state.savedSession.inputs.find((item) => item.inputVersionId === fixture.expectedRedactedId);
    assert.equal(erased.state, 'redacted'); assert.equal(erased.content, null); assert.equal(erased.placeholder, '相关来源已删除');
  }
  if (fixture.expectedDrafts) {
    assert.deepEqual(state.savedSession.turns.map((turn) => turn.input.content.draft_text), fixture.expectedDrafts);
    assert.deepEqual(state.savedSession.turns.map((turn) => turn.reply?.candidates[0].text ?? null), fixture.expectedCandidates);
    assert.deepEqual(state.savedSession.turns.map((turn) => turn.state), fixture.expectedStates ?? ['completed']);
    if (fixture.expectedCandidates[0] !== null) {
      const history = state.candidateVersions.items[0].history;
      assert.equal(history.versions[0].messages[0].text, fixture.expectedCandidates[0]);
    }
  } else assert.deepEqual(state.savedSession.turns, []);
  if (fixture.expectedWireSha) assert(parts.length > 1 && parts.every((part) => part.read_id === fixture.expectedWireSha));
  if (fixture.editText || fixture.expectedVersionTexts) {
    const scope = { contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision, sessionId: fixture.sessionId };
    const original = state.candidateVersions.items[0].history;
    const candidateId = original.candidateId;
    if (fixture.editText) await bridge.saveCandidateVersion({ ...scope, candidateId, editKey: randomUUID(),
      parentVersionId: original.versions[0].versionId,
      messages: [{ messageId: original.versions[0].messages[0].messageId, text: fixture.editText }],
      requirements: '硬拒绝后保存的本次合成编辑要求。' });
    const history = (await bridge.getState()).candidateVersions.items[0].history;
    const expected = fixture.expectedVersionTexts ?? [fixture.expectedCandidates[0], fixture.editText];
    assert(history.versions.every((version, index) => version.messages[0].text === expected[index]));
    assert.deepEqual(history.versions.map((version) => version.text), expected);
    assert.equal(history.selectedVersionId, null);
    assert.equal(history.versions[1].requirements, '硬拒绝后保存的本次合成编辑要求。');
    await bridge.showCandidateVersion({ ...scope, candidateId, versionId: history.versions[0].versionId });
    assert.equal((await bridge.getState()).candidateVersions.items[0].displayVersionId, history.versions[0].versionId);
  }
  if (fixture.newDraft) {
    const scope = { contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision };
    await bridge.newSavedSession(scope);
    const blank = await bridge.getState();
    assert.equal(blank.savedSession.phase, 'ready');
    assert.notEqual(blank.savedSession.sessionId, fixture.sessionId);
    assert.deepEqual(blank.savedSession.inputs, []); assert.deepEqual(blank.savedSession.turns, []);
    assert.equal(blank.savedSession.currentInputVersionId, null); assert.equal(blank.result, null);
    contacts.setDraft({ ...scope, text: fixture.newDraft });
    await bridge.generate({ ...scope, newRequest: true });
    const generated = await bridge.getState();
    assert.equal(generated.phase, 'ready');
    assert.equal(generated.result.inputBudget.state, 'ready');
    await bridge.selectSavedSession({ ...scope, sessionId: fixture.sessionId });
    const reopened = await bridge.getState();
    assert.equal(reopened.savedSession.phase, 'ready');
    assert.deepEqual(reopened.savedSession.inputs.map((item) => item.inputVersionId), fixture.expectedInputIds);
  }
  assert(calls.every((call) => !call.enlarged), '通用 JSON 上限保持原值。');
  assert(capFailures.length > 0 && capFailures.every((failure) => failure.kind === 'response' && failure.code === 'response_too_large'));
  process.stdout.write(JSON.stringify({ inputCount: state.savedSession.inputs.length,
    turnCount: state.savedSession.turns.length, requests: calls.length }));
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.constructor.name, message: error.message, faultBodyBytes, faultFailure }));
  process.exitCode = 1;
} finally {
  transport.cancelPending(); faultTransport?.cancelPending();
  if (faultServer) await new Promise((resolve) => faultServer.close(resolve));
}
