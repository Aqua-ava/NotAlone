import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { historicalReplyFixture, ports } from './fixtures/historical-reply-basis.mjs';
import { payload as layeredPayload, profilePayload, ids as layeredIds } from './layered-memory/support.mjs';

test('真实HTTP保存的主题正文依据穿过生产解析与React，历史协议仍按匹配版本展示', { timeout: 90_000 }, async () => {
  const previous = process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-layered-parser-contract-'));
  process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR = directory;
  try {
    await ports.withLayeredReplyFixture(async (fixture) => {
      const prepared = await fixture.command('prepared');
      const actual = await fixture.command('saved_scenario_evidence');
      await writeFile(path.join(directory, 'actual-saved-evidence.json'), JSON.stringify(actual), { mode: 0o600 });
      // 完整GET结果先原样进入生产解析器，不改任何请求身份或正文。
      const parsed = await ports.readReplyEvidence({ requestJson: async () => ({ data: actual, generation: 1 }) },
        prepared.contact_id, actual.reply_request_id, new AbortController().signal);
      assert.equal(parsed.layeredContext.schemaVersion, 3);
      assert.equal(parsed.layeredScenarioReads[0].document.versionId, prepared.scenario_version_id);
      assert.deepEqual(parsed.layeredScenarioReads[0].document.paragraphRange, [0, 1]);
      const f = await generatedFixture((f) => {
        Object.assign(f.records.evidence, actual, { reply_request_id: f.requestId });
        f.records.saved.turns[0].reply.candidates[0].citation_ids = actual.evidence.filter((item) => item.cited).map((item) => item.evidence_id);
      });
      await f.bridge.loadEvidence(f.selection);
      const state = await f.bridge.getEvidenceState();
      assert.equal(state.phase, 'ready', JSON.stringify(state));
      assert.equal(state.layeredContext.schemaVersion, 3);
      assert.equal(state.layeredContext.readPolicy, 'synthetic-scoped-layered-v3');
      assert.equal(state.layeredContext.profileVersionId, prepared.profile_version_id);
      assert.deepEqual(state.layeredScenarioReads.map((item) => item.status), ['succeeded', 'duplicate']);
      assert.equal(state.layeredScenarioReads[0].document.versionId, prepared.scenario_version_id);
      assert.deepEqual(state.layeredScenarioReads[0].document.paragraphRange, [0, 1]);
      const html = await renderEvidence(f);
      assert.ok(html.includes(prepared.scenario_text));
      assert.ok(html.includes(prepared.scenario_version_id));
      assert.ok(html.includes('重复读取'));
      if (prepared.owner_profile_version_id) {
        assert.equal(parsed.ownerLayeredContext.scopeKind, 'owner');
        assert.equal(state.ownerLayeredContext.profileVersionId, prepared.owner_profile_version_id);
        assert.deepEqual(state.ownerLayeredScenarioReads.map((item) => item.status), ['succeeded', 'duplicate']);
        assert.equal(state.ownerLayeredScenarioReads[0].document.versionId, prepared.owner_scenario.version_id);
        assert.ok(html.includes(prepared.owner_scenario.paragraphs[0].text));
        assert.ok(html.includes(prepared.owner_profile_version_id));
      }
      assert.equal((await fixture.command('runtime_proof')).external_model_calls, 0);
    });
    process.stdout.write(`saved_evidence_contract: ${directory}\n`);
  } finally {
    if (previous === undefined) delete process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR;
    else process.env.NOTALONE_LAYERED_TEST_EVIDENCE_DIR = previous;
  }
});

function retrieval(ids, overrides = {}) {
  return { version: 1, retriever_version: 'lexical-v1', status: 'succeeded',
    overview_revisions: { contact: { projection_revision: 'a'.repeat(64), memory_revision: 7 },
      owner: { projection_revision: 'b'.repeat(64), memory_revision: 3 } },
    queries: [
      { kind: 'confirmed_memory', purpose: 'recall', status: 'succeeded', evidence_ids: [ids.contact], limit: 5 },
      { kind: 'owner_memory', purpose: 'recall', status: 'succeeded', evidence_ids: [ids.owner], limit: 3 },
      { kind: 'pending_candidate', purpose: 'recall', status: 'succeeded', evidence_ids: [ids.pending], limit: 3 },
      { kind: 'message', purpose: 'source_window', status: 'succeeded', evidence_ids: [ids.message], limit: 16 },
    ],
    budgets: { contact_memory: { limit: 5, char_limit: 600, used_count: 1, used_chars: 14, exhausted: false },
      owner_memory: { limit: 3, char_limit: 240, used_count: 1, used_chars: 14, exhausted: false },
      pending_candidate: { limit: 3, char_limit: 300, used_count: 1, used_chars: 15, exhausted: false },
      source_messages: { call_limit: 3, item_limit: 16, token_limit: 2048,
        used_calls: 1, used_count: 1, used_tokens: 4, exhausted: false } }, ...overrides };
}

test('公开GET保存的双范围实际材料原样穿过生产解析、Main、preload与React', {
  skip: !process.env.NOTALONE_SCOPED_REPLY_EVIDENCE,
}, async () => {
  const bytes = await readFile(process.env.NOTALONE_SCOPED_REPLY_EVIDENCE);
  const actual = JSON.parse(bytes);
  const f = await generatedFixture((f) => { f.records.evidence = actual; }, { replyRequestId: actual.reply_request_id });
  const parsed = await ports.readReplyEvidence({ requestJson: async () => ({ data: actual, generation: 1 }) },
    f.scope.contactId, actual.reply_request_id, new AbortController().signal);
  await f.bridge.loadEvidence(f.selection);
  const state = await f.bridge.getEvidenceState();
  assert.equal(state.phase, 'ready', JSON.stringify(state));
  assert.equal(parsed.layeredContext.scopeKind, 'contact');
  assert.equal(parsed.ownerLayeredContext.scopeKind, 'owner');
  assert.equal(state.layeredContext.schemaVersion, 3);
  assert.equal(state.ownerLayeredContext.schemaVersion, 3);
  assert.equal(state.ownerLayeredContext.readPolicy, 'synthetic-scoped-layered-v3');
  assert.equal(state.ownerLayeredScenarioReads[0].status, 'succeeded');
  const html = await renderEvidence(f);
  for (const [context, reads] of [[actual.layered_context, actual.layered_scenario_reads], [actual.owner_layered_context, actual.owner_layered_scenario_reads]]) {
    for (const entry of context.profile_entries) assert(html.includes(entry.text));
    for (const entry of context.directory) assert(html.includes(entry.title));
    for (const read of reads) if (read.status === 'succeeded') {
      assert(html.includes(read.document.version_id));
      for (const paragraph of read.document.paragraphs) assert(html.includes(paragraph.text));
    }
  }
  assert(html.includes('本次实际读取的本人主题正文'));
  assert.equal(await readFile(process.env.NOTALONE_SCOPED_REPLY_EVIDENCE, 'utf8'), bytes.toString());
});

async function generatedFixture(arrange, options) {
  const f = await historicalReplyFixture(options);
  await f.bridge.readSavedSession(f.scope);
  if (arrange) await arrange(f);
  f.records.saved.turns[0].reply.context_receipt.evidence_ids = f.records.evidence.evidence.map((item) => item.evidence_id);
  f.contacts.setDraft({ ...f.scope, text: '合成当前草稿。' });
  await f.bridge.generate({ ...f.scope, newRequest: true });
  assert.equal((await f.bridge.getState()).phase, 'ready');
  const selection = { ...f.scope, replyRequestId: f.requestId, candidateId: f.candidateId };
  return { ...f, selection };
}

async function renderEvidence(f) {
  const state = await f.bridge.getState();
  const evidence = await f.bridge.getEvidenceState();
  return ports.renderToStaticMarkup(ports.createElement(ports.ReplyEvidence, {
    evidence: { state: evidence, error: '' }, selection: f.selection,
    candidate: state.result.candidates[0].original, number: 1, waiting: false,
  }));
}

test('展开候选依据显示概览定位后的实际原话与事实，历史和未确认参考各保留状态', async () => {
  const f = await generatedFixture((f) => {
  const ids = { contact: f.memoryId, owner: randomUUID(), pending: randomUUID(), message: randomUUID() };
  const original = f.records.evidence.evidence[0];
  original.text = '合成当时资料：过去周末有空。';
  original.snapshot_status = 'invalidated';
  original.timing.current_status = 'historical';
  original.timing.current_status_reason = '来源只支持过去，不说明现在仍有空。';
  original.navigation = { scope_kind: 'contact', projection_revision: 'a'.repeat(64),
    memory_id: f.memoryId, memory_revision: 1, provenance_kind: 'source_supported' };
  f.records.evidence.evidence.push(
    { ...structuredClone(original), evidence_id: ids.owner, kind: 'owner_memory', text: '合成本人明确偏好：无糖饮品。',
      snapshot_status: 'active', cited: false, navigation: { scope_kind: 'owner', projection_revision: 'b'.repeat(64),
        memory_id: ids.owner, memory_revision: 2, provenance_kind: 'manual_entry' },
      timing: { ...original.timing, current_status: 'stable', current_status_reason: '本人明确保存的长期偏好。' } },
    { ...structuredClone(original), evidence_id: ids.pending, kind: 'pending_candidate', text: '合成未确认参考：可能周末有空。',
      snapshot_status: 'pending', cited: false, navigation: null,
      selection_reason: '未确认候选、仅供参考、不得当作事实。',
      timing: { ...original.timing, current_status: 'current_unverified', current_status_reason: '当前是否成立尚未核实。' } },
    { ...structuredClone(original), evidence_id: ids.message, kind: 'message', text: '合成来源原话：那时周末有空。',
      snapshot_status: 'active', cited: false, navigation: null },
  );
  f.records.evidence.retrieval = retrieval(ids);
  });
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
  const html = await renderEvidence(f);
  for (const phrase of ['本次已完成有界检索', '由联系人概览定位', '由本人概览定位', '来源支持', '手动录入',
    '合成来源原话：那时周末有空。', '合成当时资料：过去周末有空。', '生成时适用性', '历史资料',
    '未确认记忆候选', '是否仍适用，尚不确定', '未指定期限的事实或偏好', '本候选已引用', '生成上下文，未被候选引用']) {
    assert(html.includes(phrase), phrase);
  }
  assert(f.calls.every((request) => !request.path.endsWith('/relationship-overview') && !request.path.endsWith('/owner/overview')));
});

function emptyRetrieval() {
  const value = retrieval({});
  value.status = 'empty';
  value.overview_revisions = { contact: null, owner: null };
  value.queries = ['confirmed_memory', 'owner_memory', 'pending_candidate'].map((kind) => ({
    kind, purpose: 'recall', status: 'empty', evidence_ids: [], limit: kind === 'confirmed_memory' ? 5 : 3 }));
  for (const name of ['contact_memory', 'owner_memory', 'pending_candidate']) {
    value.budgets[name].used_count = 0; value.budgets[name].used_chars = 0;
  }
  Object.assign(value.budgets.source_messages, { used_calls: 0, used_count: 0, used_tokens: 0 });
  return value;
}

test('空检索只说明没查到，独立预算耗尽和补查失败保留未知并显示实际输入', async () => {
  for (const status of ['empty', 'budget_exhausted', 'unavailable']) {
    const f = await generatedFixture((f) => {
      const original = f.records.evidence.evidence[0];
      f.records.evidence.evidence = [{ ...original, evidence_id: randomUUID(), kind: 'user_draft',
        text: '合成用户当前原意仍作为输入。', snapshot_status: 'user_input', selection_reason: '用户本次草稿。' }];
      const receipt = emptyRetrieval();
      receipt.status = status;
      if (status === 'budget_exhausted') {
        receipt.budgets.contact_memory.exhausted = true;
        Object.assign(receipt.budgets.source_messages, { used_calls: 3, exhausted: true });
        receipt.queries.push(...Array.from({ length: 3 }, () => ({ kind: 'message', purpose: 'source_window',
          status: 'empty', evidence_ids: [], limit: 16 })),
          { kind: 'message', purpose: 'source_window', status: 'budget_exceeded', evidence_ids: [], limit: 16 });
      }
      if (status === 'unavailable') receipt.queries.push({ kind: 'message', purpose: 'source_window',
        status: 'failed', evidence_ids: [], limit: 16 });
      f.records.evidence.retrieval = receipt;
    });
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    const html = await renderEvidence(f);
    const expected = { empty: '本次检索未查到相关依据；不表示没有这件事。',
      budget_exhausted: '本次检索预算已耗尽，未查到的内容仍为未知。',
      unavailable: '本次检索有读取失败，未获得的内容仍为未知。' };
    assert(html.includes(expected[status]), expected[status]);
    assert(html.includes('合成用户当前原意仍作为输入。'));
    assert(html.includes('联系人资料：0/5 条，0/600 字符'));
    assert(html.includes('本人资料：0/3 条，0/240 字符'));
    assert(html.includes('未确认参考：0/3 条，0/300 字符'));
    assert(!html.includes('本次已完成有界检索'));
    if (status === 'budget_exhausted') assert(html.includes('原话补查：3/3 次'));
    if (status === 'unavailable') assert(html.includes('原话窗口补查：读取失败，结果未知'));
  }
});

function contactRetrieval(f) {
  const value = emptyRetrieval();
  value.status = 'succeeded';
  value.overview_revisions.contact = { projection_revision: 'a'.repeat(64), memory_revision: 7 };
  value.queries[0] = { kind: 'confirmed_memory', purpose: 'recall', status: 'succeeded', evidence_ids: [f.memoryId], limit: 5 };
  Object.assign(value.budgets.contact_memory, { used_count: 1, used_chars: Array.from(f.records.evidence.evidence[0].text).length });
  return value;
}

test('原话补查计费明确标为估算，不把字符估计冒充供应商精确token', async () => {
  const f = await generatedFixture((f) => {
    const original = f.records.evidence.evidence[0];
    const messageId = randomUUID();
    const receipt = contactRetrieval(f);
    f.records.evidence.evidence.push({ ...original, evidence_id: messageId, kind: 'message', text: '这是合成补查原话。' });
    receipt.queries.push({ kind: 'message', purpose: 'source_window', status: 'succeeded', evidence_ids: [messageId], limit: 16 });
    Object.assign(receipt.budgets.source_messages, { used_calls: 1, used_count: 1, used_tokens: 3 });
    f.records.evidence.retrieval = receipt;
  });
  await f.bridge.loadEvidence(f.selection);
  const html = await renderEvidence(f);
  assert(html.includes('3/2048 估算 token'));
});

test('预算回执与实际使用资料矛盾时撤下旧依据，保留用户合法候选编辑', async () => {
  for (const field of ['used_count', 'used_chars']) {
    const f = await generatedFixture((f) => { f.records.evidence.retrieval = contactRetrieval(f); });
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    await f.bridge.editCandidate({ ...f.selection, text: '合成合法用户编辑仍应保留。' });
    f.records.evidence.retrieval.budgets.contact_memory[field] = 0;
    await f.bridge.loadEvidence(f.selection);
    const evidence = await f.bridge.getEvidenceState();
    assert.equal(evidence.phase, 'failed');
    assert.deepEqual(evidence.items, []);
    assert.equal(evidence.retrieval, undefined);
    assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '合成合法用户编辑仍应保留。');
    assert(!(await renderEvidence(f)).includes('合成当时资料：周末有空。'));
  }
});

for (const limit of [21, 256]) test(`查询回执${limit}超出约定上限时撤下旧依据并保留合法编辑，边界20仍可查看`, async () => {
  const f = await generatedFixture((f) => {
    const receipt = contactRetrieval(f);
    receipt.queries[0].limit = 20;
    f.records.evidence.retrieval = receipt;
  });
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
  assert.equal((await f.bridge.getEvidenceState()).retrieval.queries[0].limit, 20);
  const edit = '查询回执失效时仍保留的合法合成用户编辑。';
  await f.bridge.editCandidate({ ...f.selection, text: edit });
  f.records.evidence.retrieval.queries[0].limit = limit;
  await f.bridge.loadEvidence(f.selection);
  const rejected = await f.bridge.getEvidenceState();
  assert.equal(rejected.phase, 'failed');
  assert.deepEqual(rejected.items, []);
  assert.equal(rejected.retrieval, undefined);
  assert.equal((await f.bridge.getState()).result.candidates[0].editedText, edit);
  assert(!(await renderEvidence(f)).includes('合成当时资料：周末有空。'));
  f.records.evidence.retrieval.queries[0].limit = 20;
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
  assert.equal((await f.bridge.getEvidenceState()).retrieval.queries[0].limit, 20);
  assert.equal((await f.bridge.getState()).result.candidates[0].editedText, edit);
});

test('旧缺失或null检索回执保留未知，重读不沿用缓存导航也不补查当前资料', async () => {
  for (const legacy of [undefined, null]) {
    const f = await generatedFixture((f) => { f.records.evidence.retrieval = contactRetrieval(f); });
    await f.bridge.loadEvidence(f.selection);
    assert((await renderEvidence(f)).includes('本次已完成有界检索'));
    await f.bridge.editCandidate({ ...f.selection, text: '旧快照仍合法的合成用户编辑。' });
    f.records.evidence.retrieval = legacy;
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).retrieval, null);
    const html = await renderEvidence(f);
    assert(html.includes('本次快照未记录检索过程，不能据此判断是否查空或耗尽。'));
    assert(html.includes('旧快照未记录当时适用性'));
    assert(!html.includes('本次已完成有界检索'));
    assert(!html.includes('由联系人概览定位'));
    assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '旧快照仍合法的合成用户编辑。');
    assert(f.calls.every((request) => !request.path.endsWith('/relationship-overview') && !request.path.endsWith('/owner/overview')));
  }
});

test('不可信导航或检索回执拒绝展示，显式重试重新读取合法原快照', async () => {
  const bad = [
    (value) => { value.retrieval.version = 2; },
    (value) => { value.retrieval.status = 'guess'; },
    (value) => { value.retrieval.overview_revisions.contact.projection_revision = '伪概览修订'; },
    (value) => { value.retrieval.private_text = '无权追加的合成概览正文。'; },
    (value) => { value.retrieval.queries[0].evidence_ids = [randomUUID()]; },
    (value) => { value.retrieval.queries[0].kind = 'owner_memory'; },
    (value) => { value.retrieval.queries[0].status = 'failed'; },
    (value) => { value.retrieval.budgets.owner_memory.used_chars = 241; },
    (value) => { value.retrieval.budgets.source_messages.call_limit = 4; },
    (value) => { value.evidence[0].navigation.memory_id = randomUUID(); },
    (value) => { value.evidence[0].navigation.scope_kind = 'owner'; },
    (value) => { value.evidence[0].navigation.provenance_kind = 'unknown'; },
    (value) => { value.evidence[0].navigation.projection_revision = 'c'.repeat(64); },
    (value) => { value.retrieval = null; },
  ];
  for (const change of bad) {
    const f = await generatedFixture((f) => {
      f.records.evidence.retrieval = contactRetrieval(f);
      f.records.evidence.evidence[0].navigation = { scope_kind: 'contact', projection_revision: 'a'.repeat(64),
        memory_id: f.memoryId, memory_revision: 1, provenance_kind: 'source_supported' };
    });
    const valid = structuredClone(f.records.evidence);
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    change(f.records.evidence);
    await f.bridge.loadEvidence(f.selection);
    const rejected = await f.bridge.getEvidenceState();
    assert.equal(rejected.phase, 'failed');
    assert.deepEqual(rejected.items, []);
    assert.equal(rejected.retrieval, undefined);
    f.records.evidence = valid;
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    assert((await renderEvidence(f)).includes('由联系人概览定位'));
  }
});

test('来源通知清除已呈现或在途的检索快照，重复通知与旧响应不能恢复正文', async () => {
  for (const [order, foreign] of [['evidence-first', false], ['source-first', false], ['evidence-first', true], ['source-first', true]]) {
    const f = await generatedFixture((f) => { f.records.evidence.retrieval = contactRetrieval(f); });
    if (foreign) scopedScenarioSnapshots(f);
    const notifiedContact = foreign ? randomUUID() : f.scope.contactId;
    let release;
    let late;
    if (order === 'evidence-first') {
      await f.bridge.loadEvidence(f.selection);
      assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    } else {
      let reached;
      const waiting = new Promise((resolve) => { reached = resolve; });
      f.records.beforeResponse = (request) => request.path.endsWith('/evidence')
        ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
      late = f.bridge.loadEvidence(f.selection);
      await waiting;
    }
    f.records.failure = (request) => request.path.endsWith('/evidence')
      ? new ports.BackendRequestFailure('response', 404) : undefined;
    Object.assign(f.records.saved.turns[0], { state: 'redacted', input: null, reply: null,
      basis_changes: [], placeholder: '相关来源已删除' });
    Object.assign(f.records.saved.inputs[0], { state: 'redacted', content: null,
      basis_changes: [], placeholder: '相关来源已删除' });
    const deleting = f.replies.revalidateDeletedSource(notifiedContact);
    assert.equal((await f.bridge.getEvidenceState()).retrieval, undefined);
    assert.deepEqual((await f.bridge.getEvidenceState()).items, []);
    await deleting;
    await f.replies.revalidateDeletedSource(notifiedContact);
    if (late) { release(); await late; }
    await f.bridge.readSavedSession(f.scope);
    const state = await f.bridge.getState();
    const evidence = await f.bridge.getEvidenceState();
    assert.equal(state.result, null);
    assert.deepEqual(evidence.items, []);
    assert.equal(evidence.retrieval, undefined);
    assert.equal(evidence.ownerLayeredContext, undefined);
    assert.equal(evidence.ownerLayeredScenarioReads, undefined);
    for (const phrase of ['合成当时资料：周末有空。', '合成旧候选：先确认见面时间。']) {
      assert(!JSON.stringify({ state, evidence }).includes(phrase));
    }
    await assert.rejects(f.bridge.loadEvidence(f.selection), /候选依据已失效/);
  }
});

test('来源复验失败后显式重试保留合法编辑与依据变化，生成时导航版本不被当前概览回填', async () => {
  const f = await generatedFixture((f) => {
    f.records.evidence.retrieval = contactRetrieval(f);
    f.records.evidence.evidence[0].navigation = { scope_kind: 'contact', projection_revision: 'a'.repeat(64),
      memory_id: f.memoryId, memory_revision: 1, provenance_kind: 'source_supported' };
  });
  await f.bridge.editCandidate({ ...f.selection, text: '核对前合法的合成用户编辑。' });
  await f.bridge.loadEvidence(f.selection);
  f.records.failure = (request) => request.path.endsWith('/evidence') ? new ports.BackendRequestFailure('connection') : undefined;
  await f.replies.revalidateDeletedSource(f.scope.contactId);
  assert.equal((await f.bridge.getState()).sourceAvailability, 'failed');
  assert.equal((await f.bridge.getState()).result, null);
  assert.deepEqual((await f.bridge.getEvidenceState()).items, []);
  assert.equal((await f.bridge.getEvidenceState()).retrieval, undefined);
  f.records.failure = undefined;
  f.records.evidence.basis_changes = [{ evidence_id: f.memoryId, kind: 'confirmed_memory', reason: 'memory_revised' }];
  await f.bridge.retrySourceValidation(f.scope);
  const restored = await f.bridge.getState();
  assert.equal(restored.sourceAvailability, undefined);
  assert.equal(restored.result.candidates[0].editedText, '核对前合法的合成用户编辑。');
  assert.equal(restored.result.basisChanges[0].reason, 'memory_revised');
  await f.bridge.loadEvidence(f.selection);
  const evidence = await f.bridge.getEvidenceState();
  assert.equal(evidence.retrieval.overviewRevisions.contact.memoryRevision, 7);
  assert.equal(evidence.items[0].navigation.memoryRevision, 1);
  assert.equal(evidence.items[0].text, '合成当时资料：周末有空。');
  const html = await renderEvidence(f);
  assert(html.includes('依据已变化'));
  assert(html.includes('回执与导航版本对应生成时'));
  assert(f.calls.every((request) => !request.path.endsWith('/relationship-overview') && !request.path.endsWith('/owner/overview')));
});

test('切换范围、目录移除及断连重连取消旧依据读取，迟到成功或失败都不发布旧回执', async () => {
  for (const change of ['scope', 'directory', 'disconnect', 'reconnect']) {
    for (const outcome of ['success', 'failure']) {
      const f = await generatedFixture((f) => { f.records.evidence.retrieval = contactRetrieval(f); });
      let release, reached;
      const waiting = new Promise((resolve) => { reached = resolve; });
      const hold = (request) => request.path.endsWith('/evidence')
        ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
      if (outcome === 'success') f.records.beforeResponse = hold;
      else {
        f.records.failure = (request) => request.path.endsWith('/evidence') ? new ports.BackendRequestFailure('connection') : undefined;
        f.records.beforeFailure = hold;
      }
      const late = f.bridge.loadEvidence(f.selection);
      await waiting;
      if (change === 'scope') {
        const other = randomUUID();
        f.records.directory.push({ contactId: other, displayName: '另一合成范围', messageCount: 0, sourceCount: 0 });
        await f.contacts.refreshContacts();
        f.contacts.selectContact({ contactId: other, scopeRevision: f.contacts.getState().scopeRevision });
      } else if (change === 'directory') {
        f.records.directory = [];
        await f.contacts.refreshContacts();
      } else {
        f.records.generation = undefined;
        f.contacts.setConnection(undefined);
        for (const listener of f.backendListeners) listener({});
        if (change === 'reconnect') {
          f.records.generation = 8;
          f.contacts.setConnection(8);
          for (const listener of f.backendListeners) listener({});
          await f.contacts.refreshContacts();
          f.contacts.selectContact({ contactId: f.scope.contactId, scopeRevision: f.contacts.getState().scopeRevision });
        }
      }
      release(); await late;
      const evidence = await f.bridge.getEvidenceState();
      assert.equal(evidence.phase, 'idle');
      assert.deepEqual(evidence.items, []);
      assert.equal(evidence.retrieval, undefined);
      await assert.rejects(f.bridge.loadEvidence(f.selection), /候选依据已失效/);
    }
  }
});

test('同范围的新读取与显式重试接管旧请求，收起后不保留检索或导航缓存', async () => {
  for (const older of ['success', 'failure']) {
    const f = await generatedFixture((f) => { f.records.evidence.retrieval = contactRetrieval(f); });
    let release, reached;
    const waiting = new Promise((resolve) => { reached = resolve; });
    const hold = (request) => request.path.endsWith('/evidence')
      ? new Promise((resolve) => { release = resolve; reached(); }) : undefined;
    if (older === 'success') f.records.beforeResponse = hold;
    else {
      f.records.failure = (request) => request.path.endsWith('/evidence') ? new ports.BackendRequestFailure('connection') : undefined;
      f.records.beforeFailure = hold;
    }
    const late = f.bridge.loadEvidence(f.selection);
    await waiting;
    f.records.beforeResponse = undefined; f.records.beforeFailure = undefined;
    f.records.failure = older === 'success'
      ? (request) => request.path.endsWith('/evidence') ? new ports.BackendRequestFailure('connection') : undefined
      : undefined;
    await f.bridge.loadEvidence(f.selection);
    const expected = older === 'success' ? 'failed' : 'ready';
    assert.equal((await f.bridge.getEvidenceState()).phase, expected);
    release(); await late;
    assert.equal((await f.bridge.getEvidenceState()).phase, expected);
    if (older === 'success') assert.equal((await f.bridge.getEvidenceState()).retrieval, undefined);
    f.records.failure = undefined;
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    await f.bridge.closeEvidence(f.selection);
    const closed = await f.bridge.getEvidenceState();
    assert.equal(closed.phase, 'idle');
    assert.deepEqual(closed.items, []);
    assert.equal(closed.retrieval, undefined);
  }
});

test('实际分层背景和目录随候选快照展示，隐藏依赖不流入界面且收起后清空', async () => {
  const versionId = randomUUID(), scenarioId = randomUUID();
  const f = await generatedFixture((f) => {
    f.records.evidence.layered_status = 'loaded';
    f.records.evidence.layered_context = { schema_version: 1, scope_kind: 'contact', settings_generation: 2,
      organization_generation: 3, profile_version_id: versionId,
      profile_entries: [{ text: '合成已保存长期背景', temporal_status: 'historical', uncertainty: '仅反映过去',
        references: [{ memory_id: f.memoryId, revision: 1, provenance_kind: 'source_supported', timing: f.records.evidence.evidence[0].timing }] }],
      directory: [{ scenario_id: scenarioId, version_id: versionId, title: '合成工作主题', hint: '合成目录提示', paragraph_count: 2 }],
      read_policy: 'synthetic-contact-layered-v1', budget: { profile_entries: 4, directory_entries: 6, characters: 1800 },
      dependencies: [{ text: '隐藏参与依赖不能展示' }] };
  });
  await f.bridge.loadEvidence(f.selection);
  const state = await f.bridge.getEvidenceState();
  assert.equal(state.layeredContext?.profileVersionId, versionId);
  assert.equal(state.layeredStatus, 'loaded');
  assert.equal(state.layeredContext.dependencies, undefined);
  const html = await renderEvidence(f);
  for (const phrase of ['系统整理', '合成已保存长期背景', '合成工作主题', '合成目录提示', '未读取主题正文', '仅反映过去', versionId]) assert(html.includes(phrase), phrase);
  assert(!html.includes('隐藏参与依赖不能展示'));
  assert(!f.calls.some((call) => call.path.includes('/layered-context')));
  await f.bridge.closeEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).layeredContext, undefined);
});

test('分层资料回退状态保留原依据，旧快照不推断最新背景', async () => {
  const cases = [[undefined, '本次快照未记录分层资料'], ['not_allowed', '未授权'], ['unavailable', '不可用'],
    ['budget_omitted', '预算限制'], ['quality_closed', '未获质量资格']];
  for (const [status, phrase] of cases) {
    const f = await generatedFixture((f) => {
      if (status) { f.records.evidence.layered_status = status; f.records.evidence.layered_context = null; }
    });
    await f.bridge.loadEvidence(f.selection);
    const state = await f.bridge.getEvidenceState();
    assert.equal(state.phase, 'ready');
    assert.equal(state.items.length, 1);
    const html = await renderEvidence(f);
    assert(html.includes(phrase), phrase);
    assert(!html.includes('本次实际加入的联系人背景'));
  }
});

test('分层快照状态与正文矛盾时不展示正文，不影响候选编辑', async () => {
  const f = await generatedFixture((f) => {
    f.records.evidence.layered_status = 'quality_closed';
    f.records.evidence.layered_context = { profile_entries: [{ text: '不应泄漏的合成背景' }] };
  });
  await f.bridge.editCandidate({ ...f.selection, text: '合成用户编辑保留。' });
  await f.bridge.loadEvidence(f.selection);
  const evidence = await f.bridge.getEvidenceState();
  assert.equal(evidence.phase, 'failed');
  assert.equal(evidence.layeredContext, undefined);
  assert(!(await renderEvidence(f)).includes('不应泄漏的合成背景'));
  assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '合成用户编辑保留。');
});

function scenarioSnapshot(f) {
  const scenarioId = randomUUID(), versionId = randomUUID();
  const reference = { memory_id: f.memoryId, revision: 1, provenance_kind: 'source_supported',
    timing: f.records.evidence.evidence[0].timing };
  const context = { schema_version: 2, scope_kind: 'contact', settings_generation: 2,
    organization_generation: 3, profile_version_id: null, profile_entries: [],
    directory: [{ scenario_id: scenarioId, version_id: versionId, title: '合成冻结课程', hint: '共同课程的历史资料',
      paragraph_count: 2, paragraph_range: [0, 2] }],
    read_policy: 'synthetic-contact-layered-v2',
    scenario_read_budget: { call_limit: 3, paragraph_limit: 4, character_limit: 1800 }, budget: { profile_entries: 4, directory_entries: 6, characters: 1800 } };
  const receipt = { schema_version: 1, status: 'succeeded', reason: '已读取本次冻结目录中的主题正文。',
    scenario_id: scenarioId, paragraph_range: [0, 1],
    budget: { call_limit: 3, paragraph_limit: 4, character_limit: 1800, used_calls: 1, used_paragraphs: 1, used_characters: 420 },
    document: { scenario_id: scenarioId, version_id: versionId, title: '合成冻结课程', hint: '共同课程的历史资料',
      system_generated: true, updated_at: '2026-10-17T01:00:00Z', organization_generation: 3, paragraph_range: [0, 1],
      paragraphs: [{ text: '合成冻结正文：双方过去共同参加课程，近期安排未知。', references: [reference] }],
      dependencies: [{ text: '隐藏工具依赖不可展示' }] } };
  Object.assign(f.records.evidence, { layered_status: 'loaded', layered_context: context, layered_scenario_reads: [receipt] });
  return { scenarioId, versionId, receipt, context };
}

function scopedScenarioSnapshots(f) {
  const contact = scenarioSnapshot(f);
  Object.assign(contact.context, { schema_version: 3, read_policy: 'synthetic-scoped-layered-v3' });
  const owner = structuredClone(contact);
  owner.context.scope_kind = 'owner';
  owner.scenarioId = randomUUID(); owner.versionId = randomUUID();
  Object.assign(owner.context.directory[0], { scenario_id: owner.scenarioId, version_id: owner.versionId,
    title: '合成本人主题', hint: '本人的历史资料' });
  Object.assign(owner.receipt, { scenario_id: owner.scenarioId });
  Object.assign(owner.receipt.document, { scenario_id: owner.scenarioId, version_id: owner.versionId,
    title: '合成本人主题', hint: '本人的历史资料' });
  owner.receipt.document.paragraphs[0].text = '合成本人冻结正文：过去偏好提前安排，当前仍须核实。';
  owner.receipt.document.paragraphs[0].references[0].memory_id = randomUUID();
  Object.assign(owner.context.scenario_read_budget, { call_limit: 1, paragraph_limit: 2, character_limit: 900 });
  Object.assign(owner.receipt.budget, { call_limit: 1, paragraph_limit: 2, character_limit: 900, used_characters: 60 });
  Object.assign(f.records.evidence, { owner_layered_status: 'loaded', owner_layered_context: owner.context,
    owner_layered_scenario_reads: [owner.receipt] });
  return { contact, owner };
}

test('两侧实际分层材料穿过生产 Main 与 preload，各自显示范围、正文与独立预算', async () => {
  const f = await generatedFixture((f) => { scopedScenarioSnapshots(f); });
  await f.bridge.loadEvidence(f.selection);
  const state = await f.bridge.getEvidenceState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.layeredContext.schemaVersion, 3);
  assert.equal(state.layeredContext.scopeKind, 'contact');
  assert.equal(state.ownerLayeredContext.scopeKind, 'owner');
  assert.equal(state.ownerLayeredContext.readPolicy, 'synthetic-scoped-layered-v3');
  assert.equal(state.layeredScenarioReads[0].budget.callLimit, 3);
  assert.equal(state.ownerLayeredScenarioReads[0].budget.callLimit, 1);
  const html = await renderEvidence(f);
  for (const text of ['本次实际加入的本人背景与主题目录', '本次实际读取的本人主题正文', '合成本人冻结正文',
    '合成冻结正文', '60/900 字符', '420/1800 字符']) assert(html.includes(text), text);
  await f.bridge.closeEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).ownerLayeredContext, undefined);
  assert.equal((await f.bridge.getEvidenceState()).ownerLayeredScenarioReads, undefined);
});

test('本人资料变更隔离当前与迟到副本，权威复读仅撤下已失效候选并恢复合法编辑', async () => {
  for (const outcome of ['legal', 'missing', 'unavailable']) {
    const f = await generatedFixture((f) => { scopedScenarioSnapshots(f); });
    await f.bridge.editCandidate({ ...f.selection, text: '合成合法用户编辑应保留。' });
    await f.bridge.loadEvidence(f.selection);
    let release, entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    f.records.beforeResponse = (request) => request.path.endsWith('/evidence')
      ? new Promise((resolve) => { release = resolve; entered(); }) : undefined;
    const late = f.bridge.loadEvidence(f.selection); await reached;
    f.replies.beginOwnerContextChange();
    assert.equal((await f.bridge.getState()).result, null);
    assert.deepEqual((await f.bridge.getState()).savedSession.turns, []);
    assert.equal((await f.bridge.getEvidenceState()).ownerLayeredScenarioReads, undefined);
    f.records.beforeResponse = undefined;
    if (outcome !== 'legal') f.records.failure = (request) => request.path.endsWith('/evidence')
      ? new ports.BackendRequestFailure(outcome === 'missing' ? 'response' : 'connection', outcome === 'missing' ? 404 : undefined) : undefined;
    if (outcome === 'missing') {
      Object.assign(f.records.saved.turns[0], { state: 'redacted', input: null, reply: null, placeholder: '相关本人资料已删除' });
      Object.assign(f.records.saved.inputs[0], { state: 'redacted', content: null, placeholder: '相关本人资料已删除' });
    }
    await f.replies.revalidateOwnerContextChange();
    release(); await late;
    if (outcome === 'missing') assert.equal((await f.bridge.getState()).result, null);
    else {
      if (outcome === 'unavailable') {
        assert.equal((await f.bridge.getState()).result, null);
        assert.equal((await f.bridge.getState()).sourceAvailability, 'failed');
        f.records.failure = undefined; await f.bridge.retrySourceValidation(f.scope);
      }
      assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '合成合法用户编辑应保留。');
      await f.bridge.loadEvidence(f.selection);
      assert.equal((await f.bridge.getEvidenceState()).ownerLayeredContext.scopeKind, 'owner');
    }
  }
});

test('本人停用与重新启用沿生产管理桥协调缓存，合法历史可重新展开且保留独立输入', async () => {
  const f = await generatedFixture((f) => { scopedScenarioSnapshots(f); });
  const requestJson = f.backend.requestJson;
  let settingsGeneration = 0, release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  f.backend.requestJson = async request => {
    if (!request.path.startsWith('/api/memories/owner/layered-memory')) return requestJson(request);
    if (request.method === 'POST') {
      settingsGeneration++;
      if (request.path.endsWith('/disable')) { entered(); await new Promise(resolve => { release = resolve; }); }
    }
    return { generation: f.records.generation, data: layeredPayload({ scope_kind: 'owner', contact_id: null,
      settings_generation: settingsGeneration }) };
  };
  const memory = ports.installMemoryBridge(f.commands, f.backend, f.contacts);
  ports.coordinateOwnerContextChanges(memory, f.replies);
  const bridge = ports.createMemoryBridge(f.transport);
  await bridge.readOwnerLayeredMemory({});
  await f.bridge.editCandidate({ ...f.selection, text: '合成停用后保留的合法编辑。' });
  await f.bridge.loadEvidence(f.selection);
  const disabling = bridge.manageOwnerLayeredMemory({ action: 'disable', settingsGeneration: 0 });
  await reached;
  assert.equal((await f.bridge.getState()).result, null);
  assert.deepEqual((await f.bridge.getState()).savedSession.turns, []);
  assert.equal((await f.bridge.getEvidenceState()).ownerLayeredContext, undefined);
  release(); await disabling;
  await bridge.manageOwnerLayeredMemory({ action: 'enable', settingsGeneration: 1, purposeConfirmed: true });
  assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '合成停用后保留的合法编辑。');
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).ownerLayeredContext.scopeKind, 'owner');
  assert.equal(f.contacts.getState().draft, '合成当前草稿。');
});

test('本人两处事实管理与分层撤回均沿生产桥复验隐藏依赖，不以直接引用漏删为依据', async () => {
  for (const action of ['correct', 'delete', 'legacy-correct', 'withdraw-profile', 'withdraw-scenario']) {
    const f = await generatedFixture((f) => { scopedScenarioSnapshots(f); });
    const requestJson = f.backend.requestJson;
    const fact = { memory_id: randomUUID(), level: 'owner', text: '合成本人隐藏参与资料', category: 'common_fact', topic: 'other',
      source_ids: [randomUUID()], status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 1,
      supersedes_memory_id: null, source_candidate_id: null, valid_at: null, invalid_at: null,
      timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
    let changed = false;
    f.backend.requestJson = async request => {
      if (request.path.startsWith('/api/memories/owner')) {
        if (request.method === 'POST') {
          assert.equal((await f.bridge.getState()).result, null);
          assert.equal((await f.bridge.getEvidenceState()).ownerLayeredContext, undefined);
          changed = true;
          Object.assign(f.records.saved.turns[0], { state: 'redacted', input: null, reply: null, placeholder: '相关本人资料已删除' });
          Object.assign(f.records.saved.inputs[0], { state: 'redacted', content: null, placeholder: '相关本人资料已删除' });
          f.records.failure = r => r.path.endsWith('/evidence') ? new ports.BackendRequestFailure('response', 404) : undefined;
        }
        return { generation: f.records.generation, data: request.path === '/api/memories/owner'
          ? { memories: changed ? [] : [fact] }
          : (changed ? layeredPayload : profilePayload)({ scope_kind: 'owner', contact_id: null }) };
      }
      if (request.path.endsWith('/memory-candidates')) return { generation: f.records.generation, data: { candidates: [] } };
      return requestJson(request);
    };
    const memory = ports.installMemoryBridge(f.commands, f.backend, f.contacts);
    ports.coordinateOwnerContextChanges(memory, f.replies);
    const bridge = ports.createMemoryBridge(f.transport);
    await f.bridge.loadEvidence(f.selection);
    if (action === 'legacy-correct') {
      await bridge.refresh({ ...f.scope, section: 'owner' });
      await bridge.correct({ ...f.scope, level: 'owner', memoryId: fact.memory_id, revision: 1, text: '合成修正', category: 'common_fact' });
    } else if (action === 'correct' || action === 'delete') {
      await bridge.readOwnerMemories();
      await (action === 'correct' ? bridge.correctOwnerMemory({ memoryId: fact.memory_id, revision: 1, text: '合成修正', category: 'common_fact' })
        : bridge.deleteOwnerMemory({ memoryId: fact.memory_id, revision: 1 }));
    } else {
      await bridge.readOwnerLayeredMemory({});
      await bridge.manageOwnerLayeredMemory({ action, settingsGeneration: 1, organizationGeneration: 1,
        ...(action === 'withdraw-profile' ? { profileVersionId: layeredIds.profile } : { scenarioVersionId: layeredIds.version }) });
    }
    assert.equal(changed, true, action);
    assert.equal((await f.bridge.getState()).result, null, action);
    assert.equal((await f.bridge.getEvidenceState()).ownerLayeredScenarioReads, undefined, action);
    assert(!JSON.stringify(await f.bridge.getState()).includes('合成旧候选'), action);
  }
});

test('本人变更取消已发出的生成，迟到完成结果不能替换权威重读的历史', async () => {
  const f = await generatedFixture((f) => { scopedScenarioSnapshots(f); });
  const requestJson = f.backend.requestJson;
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  f.backend.requestJson = async request => {
    const response = await requestJson(request);
    if (request.path.endsWith('/replies')) {
      response.data.candidates[0].text = '合成已失效的迟到生成正文';
      entered(); await new Promise(resolve => { release = resolve; });
    }
    return response;
  };
  const generating = f.bridge.generate({ ...f.scope, newRequest: true }); await reached;
  f.replies.beginOwnerContextChange();
  await f.replies.revalidateOwnerContextChange();
  release(); await generating;
  assert(!JSON.stringify(await f.bridge.getState()).includes('合成已失效的迟到生成正文'));
  assert.equal(f.contacts.getState().draft, '合成当前草稿。');
});

test('本人范围只接收新协议，错置外层范围和借用另一侧预算或目录的正文均拒绝展示', async () => {
  const mutations = [
    ({ owner }) => { owner.context.scope_kind = 'contact'; },
    ({ contact }) => { contact.context.scope_kind = 'owner'; },
    ({ owner }) => { Object.assign(owner.context, { schema_version: 2, read_policy: 'synthetic-contact-layered-v2' }); },
    ({ owner }) => { owner.context.read_policy = 'synthetic-contact-layered-v2'; },
    ({ owner, contact }) => { owner.receipt.budget = structuredClone(contact.receipt.budget); },
    ({ owner, contact }) => { owner.receipt.document.version_id = contact.versionId; },
    ({ owner, contact }) => { owner.receipt.scenario_id = contact.scenarioId; },
  ];
  for (const mutate of mutations) {
    const f = await generatedFixture((f) => { mutate(scopedScenarioSnapshots(f)); });
    await f.bridge.loadEvidence(f.selection);
    const state = await f.bridge.getEvidenceState();
    assert.equal(state.phase, 'failed');
    assert.equal(state.ownerLayeredContext, undefined);
    assert.equal(state.ownerLayeredScenarioReads, undefined);
  }
});

test('历史分层协议只接受匹配版本，不给旧版补授主题正文读取额度', async () => {
  const cases = [
    { schema_version: 1, read_policy: 'synthetic-contact-layered-v2' },
    { schema_version: 2, read_policy: 'synthetic-contact-layered-v1' },
    { schema_version: 3, read_policy: 'synthetic-contact-layered-v2' },
    { schema_version: 1, read_policy: 'synthetic-contact-layered-v1' },
  ];
  for (const protocol of cases) {
    const f = await generatedFixture((f) => {
      const snapshot = scenarioSnapshot(f);
      Object.assign(snapshot.context, protocol);
    });
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'failed');
  }
  const f = await generatedFixture((f) => {
    const snapshot = scenarioSnapshot(f);
    Object.assign(snapshot.context, { schema_version: 1, read_policy: 'synthetic-contact-layered-v1' });
    delete snapshot.context.scenario_read_budget;
  });
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'failed');
});

test('主题工具实际读取的冻结正文、段落范围与直接引用进入候选依据', async () => {
  let snapshot;
  const f = await generatedFixture((f) => { snapshot = scenarioSnapshot(f); });
  await f.bridge.loadEvidence(f.selection);
  const state = await f.bridge.getEvidenceState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.layeredScenarioReads?.[0].document.versionId, snapshot.versionId);
  assert.deepEqual(state.layeredContext.directory[0].paragraphRange, [0, 2]);
  const html = await renderEvidence(f);
  for (const phrase of ['本次实际读取的联系人主题正文', '合成冻结正文：双方过去共同参加课程，近期安排未知。',
    '读取成功', '第 1 段', '1/3 次', '1/4 段', '420/1800 字符', snapshot.versionId, f.memoryId, '来源支持']) assert(html.includes(phrase), phrase);
  assert(!html.includes('未读取主题正文'));
  assert(!html.includes('隐藏工具依赖不可展示'));
  assert(!JSON.stringify(state).includes('隐藏工具依赖不可展示'));
  assert(!f.calls.some((call) => call.path.includes('/layered-memory')));
  await f.bridge.closeEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).layeredScenarioReads, undefined);
});

test('主题正文版本或目录身份矛盾时拒绝展示，不把别的正文当作冻结依据', async () => {
  const f = await generatedFixture((f) => {
    const snapshot = scenarioSnapshot(f);
    snapshot.receipt.document.title = '不属于冻结目录的标题';
  });
  await f.bridge.loadEvidence(f.selection);
  assert.equal((await f.bridge.getEvidenceState()).phase, 'failed');
  assert(!(await renderEvidence(f)).includes('合成冻结正文'));
});

test('拒绝的主题读取只展示确定回执，不追加正文或把未知写成不存在', async () => {
  const cases = [['duplicate', '重复读取'], ['out_of_range', '段落越界'], ['not_in_directory', '主题不在本次目录'],
    ['invalid_arguments', '读取参数无效'], ['stale', '冻结版本已失效'], ['budget_exceeded', '读取预算已耗尽']];
  const f = await generatedFixture((f) => {
    const snapshot = scenarioSnapshot(f);
    for (const [status, label] of cases) {
      const receipt = structuredClone(snapshot.receipt);
      delete receipt.document;
      Object.assign(receipt, { status, reason: `合成确定原因：${label}。` });
      if (status === 'invalid_arguments') Object.assign(receipt, { scenario_id: null, paragraph_range: null });
      if (status === 'out_of_range') receipt.paragraph_range = [3, -1];
      f.records.evidence.layered_scenario_reads.push(receipt);
    }
  });
  await f.bridge.loadEvidence(f.selection);
  const state = await f.bridge.getEvidenceState(), html = await renderEvidence(f);
  assert.equal(state.phase, 'ready');
  assert.equal(state.layeredScenarioReads.length, 7);
  for (const [, label] of cases) assert(html.includes(`合成确定原因：${label}。`), label);
  assert.equal(html.match(/合成冻结正文：/g)?.length, 1);
  assert(html.includes('未读取部分仍为未知'));
  assert(!html.includes('没有资料'));
});

test('明确无主题读取与旧快照缺少回执分别显示，不补读当前文档', async () => {
  for (const [reads, expected] of [[[], '本次未调用主题正文读取工具'], [undefined, '本次快照未记录主题正文读取过程']]) {
    const f = await generatedFixture((f) => { f.records.evidence.layered_scenario_reads = reads; });
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    assert((await renderEvidence(f)).includes(expected), expected);
    assert(!f.calls.some((call) => call.path.includes('/layered-memory')));
  }
});

test('矛盾的工具正文、段落或引用被拒绝，失败状态不保留先前正文且候选仍可编辑', async () => {
  const mutations = [
    (receipt) => { receipt.document.version_id = randomUUID(); },
    (receipt) => { receipt.document.organization_generation += 1; },
    (receipt) => { receipt.document.paragraph_range = [0, 2]; },
    (receipt) => { receipt.document.paragraphs[0].references[0].revision = 0; },
    (receipt) => { receipt.status = 'duplicate'; },
    (receipt) => { receipt.budget.used_characters = -1; },
  ];
  for (const mutate of mutations) {
    let snapshot;
    const f = await generatedFixture((f) => { snapshot = scenarioSnapshot(f); });
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).phase, 'ready');
    await f.bridge.editCandidate({ ...f.selection, text: '合成用户编辑保持。' });
    mutate(snapshot.receipt);
    await f.bridge.loadEvidence(f.selection);
    const state = await f.bridge.getEvidenceState();
    assert.equal(state.phase, 'failed');
    assert.equal(state.layeredScenarioReads, undefined);
    assert(!(await renderEvidence(f)).includes('合成冻结正文'));
    assert.equal((await f.bridge.getState()).result.candidates[0].editedText, '合成用户编辑保持。');
  }
});

test('来源删除或联系人切换撤下已读主题正文，迟到读取不能恢复原正文', async () => {
  for (const action of ['delete', 'switch']) {
    const f = await generatedFixture((f) => { scenarioSnapshot(f); });
    await f.bridge.loadEvidence(f.selection);
    assert.equal((await f.bridge.getEvidenceState()).layeredScenarioReads.length, 1);
    let release, entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    f.records.beforeResponse = (request) => request.path.endsWith('/evidence')
      ? new Promise((resolve) => { release = resolve; entered(); }) : undefined;
    const late = f.bridge.loadEvidence(f.selection);
    await reached;
    if (action === 'delete') {
      f.records.beforeResponse = undefined;
      f.records.failure = (request) => request.path.endsWith('/evidence') ? new ports.BackendRequestFailure('response', 404) : undefined;
      await f.replies.revalidateDeletedSource(f.scope.contactId);
    } else {
      const other = randomUUID();
      f.records.directory.push({ contactId: other, displayName: '另一个合成联系人', messageCount: 0, sourceCount: 0 });
      await f.contacts.refreshContacts();
      f.contacts.selectContact({ contactId: other, scopeRevision: f.contacts.getState().scopeRevision });
    }
    release(); await late;
    const state = await f.bridge.getEvidenceState();
    assert.equal(state.layeredScenarioReads, undefined);
    assert(!JSON.stringify(state).includes('合成冻结正文'));
  }
});

test('联系人与本人冻结分层依据保留各自计划和适用期，旧引用不从当前资料补填', async () => {
  const f = await generatedFixture((f) => {
    const scopes = scopedScenarioSnapshots(f);
    for (const [index, scoped] of Object.values(scopes).entries()) {
      const ref = scoped.receipt.document.paragraphs[0].references[0];
      Object.assign(ref, { conditions: { version: 1, items: [{ text: index === 0 ? '出差期间' : '旅行期间', evidence: [{ message_id: ref.memory_id, char_start: 0, char_end: 4 }], source_supported: true }] }, valid_at: '2020-06-01T00:00:00+08:00', invalid_at: '2020-06-03T00:00:00+08:00',
        event: { version: 1, stage: index === 0 ? 'planned' : 'cancelled', stage_verified: false, stage_evidence: [],
          occurrence_start: '2020-06-02T09:00:00+08:00', occurrence_end: null, occurrence_verified: false, occurrence_evidence: [] } });
      scoped.context.profile_version_id = randomUUID();
      scoped.context.profile_entries = [{ text: '合成冻结背景。', temporal_status: 'historical', uncertainty: '只作历史参考。',
        references: [structuredClone(ref), { memory_id: randomUUID(), revision: 1, provenance_kind: 'manual_entry', timing: ref.timing }] }];
    }
  });
  await f.bridge.loadEvidence(f.selection);
  const state = await f.bridge.getEvidenceState();
  assert.equal(state.phase, 'ready');
  for (const [context, reads, expectedStage] of [[state.layeredContext, state.layeredScenarioReads, 'planned'],
    [state.ownerLayeredContext, state.ownerLayeredScenarioReads, 'cancelled']]) {
    for (const ref of [context.profileEntries[0].references[0], reads[0].document.paragraphs[0].references[0]]) {
      assert.equal(ref.conditions.items[0].text, expectedStage === 'planned' ? '出差期间' : '旅行期间');
      assert.equal(ref.conditions.items[0].sourceSupported, true);
      assert.equal(ref.event.stage, expectedStage);
      assert.equal(ref.event.occurrenceStart, '2020-06-02T09:00:00+08:00');
      assert.equal(ref.validAt, '2020-06-01T00:00:00+08:00');
      assert.equal(ref.invalidAt, '2020-06-03T00:00:00+08:00');
    }
    const legacy = context.profileEntries[0].references[1];
    assert.equal(legacy.conditions, null); assert.equal(legacy.event, null); assert.equal(legacy.validAt, null); assert.equal(legacy.invalidAt, null);
  }
  const html = await renderEvidence(f);
  assert.match(html, /适用条件：出差期间/); assert.match(html, /适用条件：旅行期间/);
  assert.match(html, /来源支持限定，当前是否满足未知/);
  assert.match(html, /事件阶段：计划/); assert.match(html, /事件阶段：取消/);
  assert.match(html, /事件阶段：未知/); assert.match(html, /适用期间：2020年6月1日/);
  assert.doesNotMatch(html, /事件阶段：已发生/);
});

test('冻结与恢复的变化依据贯穿原始资料、双范围背景及主题，缺失时间不丢失变化说明', async () => {
  const evolution = { version: 1, kind: 'unresolved_conflict', explanation: '后续来源与已有状态冲突，尚未解决。',
    related_versions: [{ memory_id: layeredIds.memory, revision: 2 }], evidence_message_ids: [layeredIds.version],
    source_supported: true, claim_changed: false, condition_changed: true };
  const f = await generatedFixture(f => {
    f.records.evidence.evidence[0].evolution = structuredClone(evolution);
    const scopes = scopedScenarioSnapshots(f);
    for (const scoped of Object.values(scopes)) {
      const ref = scoped.receipt.document.paragraphs[0].references[0];
      ref.evolution = structuredClone(evolution);
      scoped.context.profile_version_id = randomUUID();
      scoped.context.profile_entries = [{ text: '合成冻结背景。', temporal_status: 'uncertain', uncertainty: '后续来源尚有冲突。', references: [structuredClone(ref)] }];
      delete ref.timing;
    }
  });
  await f.bridge.loadEvidence(f.selection);
  let state = await f.bridge.getEvidenceState();
  assert.equal(state.phase, 'ready');
  const refs = [state.items[0], state.layeredContext.profileEntries[0].references[0], state.ownerLayeredContext.profileEntries[0].references[0],
    state.layeredScenarioReads[0].document.paragraphs[0].references[0], state.ownerLayeredScenarioReads[0].document.paragraphs[0].references[0]];
  for (const ref of refs) {
    assert.equal(ref.evolution.kind, 'unresolved_conflict');
    assert.equal(ref.evolution.conditionChanged, true);
    assert.equal(ref.evolution.claimChanged, false);
    assert.equal(ref.evolution.relatedVersions[0].revision, 2);
    assert.deepEqual(ref.evolution.evidenceMessageIds, [layeredIds.version]);
  }
  const html = await renderEvidence(f);
  assert.equal(html.match(/变化类型：未解决矛盾/g)?.length, 5);
  assert.equal(html.match(/仅来源支持，不认证现实/g)?.length, 5);
  assert.match(html, /当前主张仍有不确定性/);
  await f.bridge.closeEvidence(f.selection);
  await f.bridge.loadEvidence(f.selection);
  state = await f.bridge.getEvidenceState();
  assert.equal(state.items[0].evolution.explanation, '后续来源与已有状态冲突，尚未解决。');
});
