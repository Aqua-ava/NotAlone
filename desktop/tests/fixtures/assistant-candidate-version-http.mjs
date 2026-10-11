import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// 正式 HTTP 和默认 JsonClient；仅后端模型由 Python 夹具替换。
let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
const output = await build({ stdin: { contents: `
  export { AssistantCandidateVersionSession } from './src/main/reply/assistant-candidate-versions';
  export { JsonClient, BackendRequestFailure } from './src/main/backend/json-client';
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { AssistantCandidateVersionSession, JsonClient, BackendRequestFailure, ContactSession, installReplyBridge, createReplyBridge } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const transport = new JsonClient({ port: fixture.port, token: fixture.token });
const calls = [];
let beforeRequest, beforeResponse;
let generation = 7;
const pageFailures = [];
const backend = { getConnectionGeneration: () => generation, requestJson: async (request) => {
  const requestedGeneration = generation;
  calls.push({ method: request.method, path: request.path, enlarged: request.maxResponseBytes !== undefined });
  await beforeRequest?.(request);
  try {
    const response = await transport.perform(request);
    await beforeResponse?.(request, response);
    return { generation: requestedGeneration, data: response.data };
  } catch (error) {
    if (request.path.includes('/versions?page=')) pageFailures.push({ kind: error.kind, status: error.status, reason: error.reason });
    throw error;
  }
}, onStateChanged: () => () => {}, subscribeMessages: (observer) => observer.connected() };
async function openSession() {
  if (!fixture.publicRpc) {
    const scope = { contactId: fixture.contactId, scopeRevision: 4, sessionId: fixture.sessionId };
    const session = new AssistantCandidateVersionSession(backend); session.setScope(scope);
    return { session, scope };
  }
  const contacts = new ContactSession(async () => ({ generation,
    contacts: [fixture.contactId, fixture.otherContactId].filter(Boolean).map((contactId) =>
      ({ contactId, displayName: '合成版本传输联系人', messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(generation); await contacts.refreshContacts();
  const handlers = new Map();
  installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} }, backend, contacts);
  const bridge = createReplyBridge({ invoke: (channel, ...args) => handlers.get(channel)(...args),
    on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision, sessionId: fixture.sessionId };
  await bridge.readSavedSession({ contactId: scope.contactId, scopeRevision: scope.scopeRevision });
  return { scope, session: { read: bridge.readCandidateVersions, save: bridge.saveCandidateVersion,
    show: bridge.showCandidateVersion, select: bridge.selectCandidateVersion, getState: bridge.getState,
    switchContact: async (contactId) => {
      contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
      await bridge.readSavedSession({ contactId, scopeRevision: contacts.getState().scopeRevision });
    }, reconnect: async () => {
      generation += 1; contacts.setConnection(generation); await contacts.refreshContacts();
      contacts.selectContact({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
      await bridge.readSavedSession({ contactId: fixture.contactId, scopeRevision: contacts.getState().scopeRevision });
    } } };
}
let phase = 'read-original';
try {
  const { session, scope } = await openSession();
  const read = { ...scope, candidateId: fixture.candidateId };
  await session.read(read);
  const initial = (await session.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).history;
  const expected = initial.versions.map((version) => version.messages);
  if (fixture.mode === 'read-existing') {
    assert.equal(initial.versions.length, fixture.expectedVersionCount);
    assert(initial.versions.at(-1).text === fixture.expectedText, '权威正文必须完整重读。');
    assert(initial.versions.at(-1).messages[0].text === fixture.expectedText, '整组消息正文必须完整重读。');
    assert(calls.every((call) => !call.enlarged));
    process.stdout.write(JSON.stringify({ phase: 'complete', versionCount: initial.versions.length, requests: calls.length }));
  } else if (fixture.mode === 'max-group') {
    phase = 'save-max-group';
    const messages = expected[0].map((message, index) => ({ messageId: message.messageId,
      text: '\x01'.repeat(index === 7 ? 8178 : 8192) }));
    assert.equal(messages.map((message) => message.text).join('\n\n').length, 65_536);
    await session.save({ ...read, editKey: randomUUID(), parentVersionId: fixture.candidateId,
      messages, requirements: '\x01'.repeat(4096) });
    const saved = (await session.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).history;
    assert.deepEqual(saved.versions[1].messages, messages);
    assert.equal(saved.versions[1].text.length, 65_536);
    assert.equal(saved.versions[1].requirements, '\x01'.repeat(4096));
    const reopened = (await openSession()).session;
    await reopened.read(read);
    assert.deepEqual((await reopened.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).history.versions[1].messages, messages);
    assert(calls.every((call) => !call.enlarged));
    process.stdout.write(JSON.stringify({ phase: 'complete', versionCount: 2, requests: calls.length,
      defaultVersionId: saved.defaultDisplayVersionId, maxGroupCharacters: 65_536 }));
    process.exitCode = 0;
  } else {
  let parentVersionId = fixture.candidateId;
  const edits = [];
  for (let number = 1; number <= 3; number += 1) {
    phase = `save-${number}`;
    const text = ['甲', '乙', '丙'][number - 1].repeat(65_536);
    const messages = [{ messageId: expected[0][0].messageId, text }];
    const editKey = randomUUID();
    const edit = { ...read, editKey, parentVersionId, messages, requirements: `合成要求${number}` }; edits.push(edit);
    await session.save(edit);
    const saved = (await session.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).history;
    assert.equal(saved.versions.length, number + 1);
    assert.equal(saved.versions.at(-1).parentVersionId, parentVersionId);
    assert.equal(saved.versions.at(-1).requirements, `合成要求${number}`);
    assert.deepEqual(saved.versions.at(-1).messages, messages);
    assert.equal(saved.versions.at(-1).text, text);
    expected.push(messages); parentVersionId = saved.defaultDisplayVersionId;
  }
  phase = 'reconnect';
  const reopened = (await openSession()).session;
  await reopened.read(read);
  const history = (await reopened.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).history;
  assert.deepEqual(history.versions.map((version) => version.messages), expected);
  assert.deepEqual(history.versions.map((version) => version.versionNumber), [0, 1, 2, 3]);
  assert.equal(history.defaultDisplayVersionId, parentVersionId);
  assert.equal((await reopened.getState()).explicitCandidateSelection.selection, null);
  phase = 'select-original';
  await reopened.show({ ...read, versionId: fixture.candidateId });
  const originalChoice = { ...read, versionId: fixture.candidateId, selectionKey: randomUUID() };
  await reopened.select(originalChoice);
  assert.equal((await reopened.getState()).explicitCandidateSelection.selection.versionId, fixture.candidateId);
  assert.equal((await reopened.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).displayVersionId, fixture.candidateId);
  phase = 'old-mutation-replay';
  await reopened.select({ ...read, versionId: parentVersionId, selectionKey: randomUUID() });
  await reopened.select(originalChoice);
  assert.equal((await reopened.getState()).explicitCandidateSelection.selection.versionId, parentVersionId);
  assert.equal((await reopened.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).displayVersionId, fixture.candidateId);
  await reopened.save(edits[0]);
  const replayed = (await reopened.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).history;
  assert.equal(replayed.versions.length, 4);
  assert.equal(replayed.defaultDisplayVersionId, parentVersionId);
  assert.equal((await reopened.getState()).explicitCandidateSelection.selection.versionId, parentVersionId);
  assert.deepEqual(replayed.versions.map((version) => version.messages), expected);
  if (fixture.mode === 'source-deleted' || fixture.mode === 'source-pending') {
    phase = 'middle-page-source-invalidation';
    let triggered = false;
    beforeRequest = async (request) => {
      if (triggered || !request.path.includes(`/candidates/${fixture.candidateId}/versions?page=1`)) return;
      triggered = true;
      const deleted = await transport.perform({ method: 'DELETE',
        path: `/api/contacts/${fixture.contactId}/sources/${fixture.sourceId}` });
      assert.equal(deleted.status, 202);
      if (fixture.mode === 'source-deleted') {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const response = await transport.perform({ method: 'GET', path: `/api/contacts/${fixture.contactId}/sources` });
          if (response.data.sources.find((source) => source.source_id === fixture.sourceId).status === 'deleted') break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    await assert.rejects(reopened.read(read));
    assert(triggered);
    const unavailable = await reopened.getState();
    assert.equal(unavailable.candidateVersions.items.find((item) => item.candidateId === fixture.candidateId)?.history ?? null, null);
    assert(unavailable.candidateVersions.items.find((item) => item.candidateId === fixture.independentCandidateId)?.history);
    assert(unavailable.savedSession.turns.find((turn) => turn.reply?.candidates.some((item) => item.candidateId === fixture.independentCandidateId)));
    assert(!JSON.stringify(unavailable).includes('来自待删来源的候选。'));
    for (const body of ['甲'.repeat(65_536), '乙'.repeat(65_536), '丙'.repeat(65_536)]) {
      assert(!JSON.stringify(unavailable).includes(body));
    }
    assert(pageFailures.some((failure) => fixture.mode === 'source-deleted' ? failure.status === 404
      : failure.status === 409 && failure.reason === 'source_unavailable'));
  } else if (fixture.mode === 'unknown-retry') {
    phase = 'middle-page-unknown-failure';
    let failed = false;
    beforeResponse = (request) => {
      if (!failed && request.path.includes(`/candidates/${fixture.candidateId}/versions?page=1`)) {
        failed = true; throw new BackendRequestFailure('connection');
      }
    };
    await assert.rejects(reopened.read(read));
    assert.equal((await reopened.getState()).candidateVersions.phase, 'failed');
    beforeResponse = undefined;
    await reopened.read(read);
    assert.deepEqual((await reopened.getState()).candidateVersions.items.find((item) => item.candidateId === fixture.candidateId)
      .history.versions.map((version) => version.messages), expected);
  } else if (['late-scope', 'late-operation', 'late-generation'].includes(fixture.mode)) {
    phase = 'middle-page-late-response';
    let release, announce, held = false;
    const pageArrived = new Promise((resolve) => { announce = resolve; });
    const pageRelease = new Promise((resolve) => { release = resolve; });
    beforeResponse = async (request) => {
      if (!held && request.path.includes(`/candidates/${fixture.candidateId}/versions?page=1`)) {
        held = true; announce(); await pageRelease;
      }
    };
    const older = reopened.read(read);
    await pageArrived;
    if (fixture.mode === 'late-scope') await reopened.switchContact(fixture.otherContactId);
    else if (fixture.mode === 'late-generation') await reopened.reconnect();
    else { await reopened.read(read); await reopened.show({ ...read, versionId: fixture.candidateId }); }
    const current = await reopened.getState();
    release(); await older;
    assert.deepEqual(await reopened.getState(), current);
    if (fixture.mode === 'late-scope') {
      assert.equal(current.contactId, fixture.otherContactId);
      assert(!JSON.stringify(current).includes('甲'.repeat(65_536)));
    } else if (fixture.mode === 'late-operation') {
      assert.equal(current.candidateVersions.items.find((item) => item.candidateId === fixture.candidateId).displayVersionId, fixture.candidateId);
      assert.equal(current.explicitCandidateSelection.selection.versionId, parentVersionId);
    }
  }
  assert(calls.every((call) => !call.enlarged));
  process.stdout.write(JSON.stringify({ phase: 'complete', versionCount: history.versions.length,
    totalCharacters: history.versions.slice(1).reduce((sum, version) => sum + version.text.length, 0),
    requests: calls.length, edited: edits.length, pageFailures }));
  }
} catch (error) {
  let rereadFailure = null;
  try { await transport.perform({ method: 'GET',
    path: `/api/contacts/${fixture.contactId}/assistant-sessions/${fixture.sessionId}/candidates/${fixture.candidateId}/versions` }); }
  catch (rereadError) { rereadFailure = rereadError.constructor.name; }
  process.stderr.write(JSON.stringify({ phase, error: error.constructor.name, message: error.message, rereadFailure }));
  process.exitCode = 1;
} finally { transport.cancelPending(); }
