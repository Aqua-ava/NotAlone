import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

// 本文件是独立真实HTTP入口，不纳入纯Node组；只在主会话授予串行窗口后执行。
const compiledInputs = [];
const compiled = await build({ stdin: { contents: `
  export { withReplyOverviewFixture, replyOverviewModules } from './tests/overview-reply-retrieval-fixture';
  export { withControllerEnvironment } from './tests/headless/backend-fixture';
  export { BackendHost } from './src/main/backend/host';
  export { StartupDiagnostics } from './src/main/startup/diagnostics';
  export { installContactSessionBridge } from './src/main/contacts/bridge';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { installSourceDeletionBridge } from './src/main/sources/bridge';
  export { createSourceDeletionBridge } from './src/preload/source-deletion';
  export { ReplyEvidence } from './src/renderer/ReplyEvidence';
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, write: false,
  plugins: [{ name: 'actual-overview-reply-http-inputs', setup(builder) {
    builder.onLoad({ filter: /\.(?:ts|tsx|mjs)$/ }, async (input) => {
      const contents = await readFile(input.path);
      compiledInputs.push({ path: input.path, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
      return { contents, loader: input.path.endsWith('.tsx') ? 'tsx' : input.path.endsWith('.ts') ? 'ts' : 'js' };
    });
  } }] });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const ports = compiledModule.exports;

const evidenceDirectory = await realpath(process.env.NOTALONE_REPLY_OVERVIEW_TEST_EVIDENCE_DIR ?? '');
const evidenceMetadata = await stat(evidenceDirectory), project = path.resolve('..');
assert.equal(evidenceMetadata.isDirectory(), true); assert.equal(evidenceMetadata.mode & 0o777, 0o700);
assert.ok(evidenceDirectory !== project && !evidenceDirectory.startsWith(`${project}${path.sep}`));
await writeFile(path.join(evidenceDirectory, `overview-reply-http-build-${process.pid}.json`), JSON.stringify({
  cwd: process.cwd(), inputs: compiledInputs.sort((a, b) => a.path.localeCompare(b.path)),
  outputSha256: createHash('sha256').update(compiled.outputFiles[0].contents).digest('hex'),
}, null, 2), { mode: 0o600, flag: 'wx' });

async function withOverviewReply(run) {
  let child, proof, cleanupConfirmed = false;
  await ports.withReplyOverviewFixture(async (fixture) => ports.withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('reply_overview_prepared');
    process.env.NOTALONE_TEST_DATABASE_URL = fixture.data.database_url;
    const diagnostics = new ports.StartupDiagnostics(userData);
    const backend = new ports.BackendHost(userData, (config, canStart) => diagnostics.ensureReady(config, canStart));
    const calls = [], delivery = {}, originalRequest = backend.requestJson.bind(backend);
    backend.requestJson = async (request) => {
      calls.push({ method: request.method, path: request.path });
      try {
        const result = await originalRequest(request); await delivery.after?.(request); return result;
      } catch (error) {
        calls.push({ method: request.method, path: request.path, failure: error.reason ?? error.code });
        throw error;
      }
    };
    const handlers = new Map(), listeners = new Map();
    const commands = { handle: (name, handler, role) => handlers.set(name, { handler, role }),
      publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(null, state); } };
    const contacts = ports.installContactSessionBridge(commands, backend);
    const replies = ports.installReplyBridge(commands, backend, contacts);
    ports.installSourceDeletionBridge(commands, backend, contacts, (contactId) => replies.revalidateDeletedSource(contactId));
    const transport = { invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name).handler(...args)),
      on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
      removeListener: (name, listener) => listeners.get(name)?.delete(listener) };
    const bridge = ports.createReplyBridge(transport), source = ports.createSourceDeletionBridge(transport);
    const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
    const request = async (endpoint, body, method = body === undefined ? 'GET' : 'POST') =>
      (await backend.requestJson({ method, path: endpoint, ...(body === undefined ? {} : { body }) })).data;
    try {
      await backend.connect(); assert.equal(backend.getState().phase, 'connected');
      await contacts.refreshContacts(); assert.equal(contacts.getState().directoryPhase, 'ready');
      contacts.selectContact({ contactId: prepared.contactId, scopeRevision: contacts.getState().scopeRevision });
      await bridge.readSavedSession(scope());
      proof = await fixture.command('runtime_proof'); child = fixture.child;
      assert.equal(proof.environment_verified, true);
      assert.equal(proof.critical_module_count, Object.keys(ports.replyOverviewModules).length);
      assert.ok(proof.loaded_module_count > proof.critical_module_count);
      assert.equal(proof.external_model_attempts, 0);
      await run({ fixture, prepared, bridge, source, contacts, replies, backend, scope, request, calls, delivery });
      assert.equal((await fixture.command('runtime_proof')).external_model_attempts, 0);
    } finally { diagnostics.cancel(); assert.equal(await backend.stop(), true); }
  }), () => { cleanupConfirmed = true; });
  assert.equal(cleanupConfirmed, true); assert.equal(child.exitCode, 0);
  assert.match(proof.evidence_file, /^overview-reply-runtime-[a-f0-9]{32}\.json$/);
  const cleaned = JSON.parse(await readFile(path.join(evidenceDirectory, proof.evidence_file), 'utf8'));
  assert.equal(cleaned.phase, 'cleaned'); assert.equal(cleaned.cleanup_confirmed, true); assert.equal(cleaned.database_remaining, false);
}

async function generate(f, { draft = f.prepared.draft, background = true, kinds,
  text = '想问问现在适不适合一起散步？', newRequest = true } = {}) {
  f.contacts.setDraft({ ...f.scope(), text: draft });
  await f.bridge.updateOptions({ ...f.scope(), options: { tone: 'original', instruction: '', includeRelationshipContext: background } });
  await f.fixture.command('plan', { plan: { text, basis: '依据实际资料提出问题，未核实处仍为未知。',
    ...(kinds ? { cite_kinds: kinds } : {}) } });
  await f.bridge.generate({ ...f.scope(), newRequest });
  const state = await f.bridge.getState(); assert.equal(state.phase, 'ready', JSON.stringify({
    errorCode: state.errorCode, failedRequests: f.calls.filter((call) => call.failure) }));
  assert.equal(state.result.candidates[0].original.text, text);
  const selection = { ...f.scope(), replyRequestId: state.result.replyRequestId, candidateId: state.result.candidates[0].original.candidateId };
  await f.bridge.loadEvidence(selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
  return { state, selection, evidence: await f.bridge.getEvidenceState() };
}
async function renderEvidence(f, selection) {
  const state = await f.bridge.getState(), evidence = await f.bridge.getEvidenceState();
  return ports.renderToStaticMarkup(ports.createElement(ports.ReplyEvidence, { evidence: { state: evidence, error: '' }, selection,
    candidate: state.result.candidates[0].original, number: 1, waiting: false }));
}
async function waitFor(read, check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await read(); if (check(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('合成来源删除未在有限时段完成公开核对。');
}

test('真实HTTP与生产桥展开实际概览定位、同关系原话、SELF手录和历史未知及pending参考', { timeout: 90_000 }, async () => {
  await withOverviewReply(async (f) => {
    const { state, selection, evidence } = await generate(f, { kinds: ['confirmed_memory', 'owner_memory', 'pending_candidate', 'message'] });
    const byId = new Map(evidence.items.map((item) => [item.evidenceId, item]));
    assert.equal(byId.get(f.prepared.history.memory_id).timing.currentStatus, 'historical');
    assert.equal(byId.get(f.prepared.unknown.memory_id).timing.currentStatus, 'current_unverified');
    assert.equal(byId.get(f.prepared.manualContact.memory_id).navigation.provenanceKind, 'manual_entry');
    for (const memory of [f.prepared.self, f.prepared.otherSelf]) {
      assert.equal(byId.get(memory.memory_id).navigation.scopeKind, 'owner');
      assert.equal(byId.get(memory.memory_id).navigation.provenanceKind, 'source_supported');
    }
    assert.equal(byId.get(f.prepared.manualOwner.memory_id).navigation.provenanceKind, 'manual_entry');
    assert.equal(byId.get(f.prepared.pending.candidate_id).snapshotStatus, 'pending');
    assert.equal(byId.get(f.prepared.pending.candidate_id).navigation, undefined);
    const actual = (await f.fixture.command('observations')).payloads.at(-1);
    for (const query of evidence.retrieval.queries) for (const id of query.evidenceIds) {
      assert.ok(byId.has(id)); assert.ok(actual.evidence.some((item) => item.evidence_id === id));
    }
    assert.equal(evidence.retrieval.retrieverVersion, 'lexical-v1');
    assert.ok(evidence.retrieval.budgets.sourceMessages.usedCalls > 0);
    assert.ok(evidence.items.some((item) => item.kind === 'message' && item.text === f.prepared.rawText));
    assert.ok(!JSON.stringify(actual).includes(f.prepared.otherPrivateText));
    assert.ok(!state.result.contextEvidenceIds.some((id) => !byId.has(id)));
    const html = await renderEvidence(f, selection);
    for (const text of [f.prepared.rawText, f.prepared.history.text, f.prepared.unknown.text, f.prepared.pending.text,
      '由联系人概览定位', '由本人概览定位', '历史资料', '当前未核实', '未确认记忆候选', '估算 token']) assert.ok(html.includes(text), text);
    assert.ok(!html.includes(f.prepared.otherPrivateText));
    assert.ok(f.calls.every((call) => !call.path.endsWith('/relationship-overview') && !call.path.endsWith('/owner/overview')));
  });
});

test('真实空检索不声称不存在，关闭背景的新快照不沿用此前回执或读取关系资料', { timeout: 90_000 }, async () => {
  await withOverviewReply(async (f) => {
    const empty = await generate(f, { draft: '桉树彗星。' });
    assert.equal(empty.evidence.retrieval.status, 'empty');
    assert.ok((await renderEvidence(f, empty.selection)).includes('本次检索未查到相关依据；不表示没有这件事。'));
    const local = await generate(f, { draft: '只整理用户这句话。', background: false });
    assert.equal(local.evidence.retrieval, null);
    assert.equal(local.evidence.items.length, 1); assert.equal(local.evidence.items[0].kind, 'user_draft');
    assert.ok((await renderEvidence(f, local.selection)).includes('本次快照未记录检索过程'));
  });
});

test('真实词法生产检索分别用尽联系人本人pending预算，只展示实际进入模型的有限资料', { timeout: 90_000 }, async () => {
  await withOverviewReply(async (f) => {
    await f.fixture.command('more_related');
    const { evidence, selection } = await generate(f, { kinds: ['confirmed_memory', 'owner_memory', 'pending_candidate'] });
    assert.equal(evidence.retrieval.status, 'budget_exhausted');
    for (const [kind, budget] of [['confirmed_memory', evidence.retrieval.budgets.contactMemory],
      ['owner_memory', evidence.retrieval.budgets.ownerMemory], ['pending_candidate', evidence.retrieval.budgets.pendingCandidate]]) {
      const used = evidence.items.filter((item) => item.kind === kind);
      assert.equal(budget.exhausted, true); assert.equal(budget.usedCount, used.length);
      assert.equal(budget.usedChars, used.reduce((total, item) => total + Array.from(item.text).length, 0));
      assert.ok(budget.usedCount <= budget.limit); assert.ok(budget.usedChars <= budget.charLimit);
    }
    assert.ok((await renderEvidence(f, selection)).includes('未查到的内容仍为未知'));
  });
});

test('来源删除后查空再补充资料，主生成操作按新草稿准备并用尽三轨预算', { timeout: 90_000 }, async () => {
  await withOverviewReply(async (f) => {
    await generate(f, { kinds: ['confirmed_memory', 'owner_memory', 'pending_candidate', 'message'], newRequest: false });
    const corrected = await f.request(`/api/contacts/${f.prepared.contactId}/memories/${f.prepared.manualContact.memory_id}/correct`,
      { text: '对方明确更正为短程散步。' });
    await f.source.refresh(f.scope());
    await f.source.delete({ ...f.scope(), sourceId: f.prepared.sourceToDelete });
    await waitFor(() => f.source.getState(), (value) => value.sources.some((source) =>
      source.sourceId === f.prepared.sourceToDelete && source.task?.status === 'succeeded'));
    await f.bridge.readSavedSession(f.scope());
    assert.equal((await f.bridge.getState()).result, null);
    const empty = await generate(f, { draft: '桉树彗星。', text: '只把这句话整理清楚。', newRequest: false });
    assert.equal(empty.evidence.retrieval.status, 'empty');
    await f.fixture.command('more_related');
    const refreshed = await generate(f, { draft: '短程散步。', text: '先询问当前散步安排。', newRequest: false,
      kinds: ['confirmed_memory', 'owner_memory', 'pending_candidate'] });
    assert.ok(refreshed.evidence.items.some((item) => item.evidenceId === corrected.memory.memory_id));
    assert.equal(refreshed.evidence.retrieval.status, 'budget_exhausted');
    for (const kind of ['contactMemory', 'ownerMemory', 'pendingCandidate']) {
      assert.equal(refreshed.evidence.retrieval.budgets[kind].exhausted, true);
    }
    assert.equal((await f.fixture.command('observations')).model_calls, 3);
  });
});

test('概览修订保留合法编辑和原导航，两种真实来源通知次序及重复删除不让迟到依据复活', { timeout: 180_000 }, async () => {
  for (const order of ['rendered', 'inflight']) await withOverviewReply(async (f) => {
    const { state, selection, evidence } = await generate(f, { kinds: ['confirmed_memory', 'owner_memory'] });
    const edit = '用户合法合成编辑：先询问安排，暂不承诺。';
    await f.bridge.editCandidate({ ...selection, text: edit });
    await f.request(`/api/contacts/${f.prepared.contactId}/memories/${f.prepared.manualContact.memory_id}/correct`, { text: '对方明确更正为短程散步。' });
    const currentOverview = await f.request(`/api/contacts/${f.prepared.contactId}/relationship-overview`);
    assert.notEqual(currentOverview.overview.projection_revision, evidence.retrieval.overviewRevisions.contact.projectionRevision);
    await f.bridge.readSavedSession(f.scope()); await f.bridge.loadEvidence(selection);
    assert.equal((await f.bridge.getState()).result.candidates[0].editedText, edit);
    assert.equal((await f.bridge.getEvidenceState()).retrieval.overviewRevisions.contact.projectionRevision, evidence.retrieval.overviewRevisions.contact.projectionRevision);
    assert.ok((await f.bridge.getEvidenceState()).basisChanges.some((change) => change.reason === 'memory_generation_forbidden'));
    let release, reached, held = false, pending;
    const atResponse = new Promise((resolve) => { reached = resolve; });
    if (order === 'inflight') {
      f.delivery.after = (request) => request.path.endsWith('/evidence') && !held
        ? (held = true, new Promise((resolve) => { release = resolve; reached(); })) : undefined;
      pending = f.bridge.loadEvidence(selection); await atResponse;
    }
    try {
      await f.source.refresh(f.scope()); await f.source.delete({ ...f.scope(), sourceId: f.prepared.sourceToDelete });
      await waitFor(() => f.source.getState(), (value) => value.sources.some((source) => source.sourceId === f.prepared.sourceToDelete && source.task?.status === 'succeeded'));
      await f.source.delete({ ...f.scope(), sourceId: f.prepared.sourceToDelete });
    } finally { release?.(); await pending; }
    await f.bridge.readSavedSession(f.scope());
    const erased = await f.bridge.getState(), erasedEvidence = await f.bridge.getEvidenceState();
    assert.ok(erased.savedSession.turns.some((turn) => turn.state === 'redacted'));
    assert.equal(erasedEvidence.items.length, 0); assert.equal(erasedEvidence.retrieval, undefined);
    const visible = JSON.stringify({ erased, erasedEvidence });
    assert.ok(!visible.includes(f.prepared.history.text)); assert.ok(!visible.includes(edit));
    assert.ok(!visible.includes(state.result.candidates[0].original.text));
  });
});
