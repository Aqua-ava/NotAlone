import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { historicalReplyFixture, ports } from './fixtures/historical-reply-basis.mjs';

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

async function generatedFixture(arrange) {
  const f = await historicalReplyFixture();
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
    '合成来源原话：那时周末有空。', '合成当时资料：过去周末有空。', '生成时核实状态', '历史资料',
    '未确认记忆候选', '当前未核实', '稳定事实或明确偏好', '本候选已引用', '生成上下文，未被候选引用']) {
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
    assert(html.includes('旧快照未记录当前核实状态'));
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
  for (const order of ['evidence-first', 'source-first']) {
    const f = await generatedFixture((f) => { f.records.evidence.retrieval = contactRetrieval(f); });
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
    const deleting = f.replies.revalidateDeletedSource(f.scope.contactId);
    assert.equal((await f.bridge.getEvidenceState()).retrieval, undefined);
    assert.deepEqual((await f.bridge.getEvidenceState()).items, []);
    await deleting;
    await f.replies.revalidateDeletedSource(f.scope.contactId);
    if (late) { release(); await late; }
    await f.bridge.readSavedSession(f.scope);
    const state = await f.bridge.getState();
    const evidence = await f.bridge.getEvidenceState();
    assert.equal(state.result, null);
    assert.deepEqual(evidence.items, []);
    assert.equal(evidence.retrieval, undefined);
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
