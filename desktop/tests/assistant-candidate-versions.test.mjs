import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

async function controller() {
  const output = await build({ stdin: { contents: `
    export { AssistantCandidateVersionSession, AssistantCandidateSourceUnavailable } from './src/main/reply/assistant-candidate-versions';
    export { BackendRequestFailure } from './src/main/backend/json-client';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}
function fixture() {
  const scope = { contactId: randomUUID(), scopeRevision: 4, sessionId: randomUUID() };
  const candidateId = randomUUID(), versionId = randomUUID(), messageId = randomUUID();
  const history = { session_id: scope.sessionId, turn_id: randomUUID(), candidate_id: candidateId,
    candidate_group_id: randomUUID(), candidate_number: 1, default_display_version_id: versionId,
    selected_version_id: null, versions: [
      { version_id: candidateId, version_number: 0, parent_version_id: null, text: '明天见。',
        messages: [{ message_id: messageId, text: '明天见。' }], requirements: null, created_at: '2026-10-11T01:00:00+00:00' },
      { version_id: versionId, version_number: 1, parent_version_id: candidateId, text: '那我们明天见。',
        messages: [{ message_id: messageId, text: '那我们明天见。' }], requirements: '本次语气自然。', created_at: '2026-10-11T01:01:00+00:00' },
    ] };
  const calls = [];
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    calls.push(request);
    return { generation: 7, data: request.path.endsWith('/selections') ? { selection: null } : history };
  } };
  return { scope, candidateId, versionId, messageId, history, calls, backend };
}

test('读取显示最新版及完整稳定消息身份，默认展示不创建明确选择', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  const f = fixture(), session = new AssistantCandidateVersionSession(f.backend);
  session.setScope(f.scope);
  await session.read({ ...f.scope, candidateId: f.candidateId });
  const state = session.getState();
  assert.equal(state.candidateVersions.sessionId, f.scope.sessionId);
  assert.equal(state.candidateVersions.items[0].displayVersionId, f.versionId);
  assert.deepEqual(state.candidateVersions.items[0].history.versions.map((version) => version.messages), [
    [{ messageId: f.messageId, text: '明天见。' }], [{ messageId: f.messageId, text: '那我们明天见。' }],
  ]);
  assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: null });
  assert(f.calls.every((request) => request.method === 'GET'));
});

test('保存完整消息组的新版本保留父版及本次要求，编辑不隐式选择', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  const f = fixture(), session = new AssistantCandidateVersionSession(f.backend);
  session.setScope(f.scope);
  await session.read({ ...f.scope, candidateId: f.candidateId });
  const newVersionId = randomUUID();
  f.history.versions.push({ version_id: newVersionId, version_number: 2, parent_version_id: f.versionId,
    text: '好，那明天见。', messages: [{ message_id: f.messageId, text: '好，那明天见。' }],
    requirements: '只调整这一版的文字。', created_at: '2026-10-11T01:02:00+00:00' });
  f.history.default_display_version_id = newVersionId;
  const edit = { ...f.scope, candidateId: f.candidateId, editKey: randomUUID(), parentVersionId: f.versionId,
    messages: [{ messageId: f.messageId, text: '好，那明天见。' }], requirements: '只调整这一版的文字。' };
  await session.save(edit);
  const view = session.getState().candidateVersions.items[0];
  assert.equal(view.displayVersionId, newVersionId);
  assert.deepEqual(view.history.versions.at(-1), { versionId: newVersionId, versionNumber: 2,
    parentVersionId: f.versionId, text: '好，那明天见。', messages: edit.messages,
    requirements: '只调整这一版的文字。', createdAt: '2026-10-11T01:02:00+00:00' });
  assert.deepEqual(session.getState().explicitCandidateSelection, { phase: 'ready', selection: null });
  assert.deepEqual(f.calls.find((request) => request.method === 'POST').body, {
    edit_key: edit.editKey, parent_version_id: f.versionId,
    messages: [{ message_id: f.messageId, text: '好，那明天见。' }], requirements: '只调整这一版的文字。',
  });
});

test('明确查看旧版只改变展示，保留最新版身份且不写入选择', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  const f = fixture(), session = new AssistantCandidateVersionSession(f.backend);
  session.setScope(f.scope);
  await session.read({ ...f.scope, candidateId: f.candidateId });
  session.show({ ...f.scope, candidateId: f.candidateId, versionId: f.candidateId });
  const state = session.getState();
  assert.equal(state.candidateVersions.items[0].displayVersionId, f.candidateId);
  assert.equal(state.candidateVersions.items[0].history.defaultDisplayVersionId, f.versionId);
  assert.equal(state.explicitCandidateSelection.selection, null);
  assert(f.calls.every((request) => request.method === 'GET'));
});

test('旧选择键回执不倒转当前明确选择，展示旧版也不隐式采用', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  const f = fixture(), oldReceipt = { selection_id: randomUUID(), selection_number: 1,
    session_id: f.scope.sessionId, candidate_id: f.candidateId, version_id: f.candidateId };
  const currentReceipt = { ...oldReceipt, selection_id: randomUUID(), selection_number: 2, version_id: f.versionId };
  f.backend.requestJson = async (request) => {
    f.calls.push(request);
    return { generation: 7, data: request.path.endsWith('/selections')
      ? request.method === 'POST' ? oldReceipt : { selection: currentReceipt } : f.history };
  };
  const session = new AssistantCandidateVersionSession(f.backend);
  session.setScope(f.scope);
  await session.read({ ...f.scope, candidateId: f.candidateId });
  session.show({ ...f.scope, candidateId: f.candidateId, versionId: f.candidateId });
  const request = { ...f.scope, candidateId: f.candidateId, versionId: f.candidateId, selectionKey: randomUUID() };
  await session.select(request);
  const state = session.getState();
  assert.deepEqual(state.explicitCandidateSelection, { phase: 'ready', selection: {
    selectionId: currentReceipt.selection_id, selectionNumber: 2,
    sessionId: f.scope.sessionId, candidateId: f.candidateId, versionId: f.versionId,
  } });
  assert.equal(state.candidateVersions.items[0].displayVersionId, f.candidateId);
  assert.deepEqual(f.calls.find((call) => call.method === 'POST').body, {
    selection_key: request.selectionKey, candidate_id: f.candidateId, version_id: f.candidateId,
  });
});

test('同会话读取多个候选保留各自受信历史，不用数组位置替代身份', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  const first = fixture(), second = fixture();
  second.history.session_id = first.scope.sessionId;
  first.backend.requestJson = async (request) => ({ generation: 7, data: request.path.endsWith('/selections')
    ? { selection: null } : request.path.includes(first.candidateId) ? first.history : second.history });
  const session = new AssistantCandidateVersionSession(first.backend);
  session.setScope(first.scope);
  await session.read({ ...first.scope, candidateId: first.candidateId });
  await session.read({ ...first.scope, candidateId: second.candidateId });
  assert.deepEqual(session.getState().candidateVersions.items.map((item) => ({
    candidateId: item.candidateId, displayVersionId: item.displayVersionId,
  })), [{ candidateId: first.candidateId, displayVersionId: first.versionId },
    { candidateId: second.candidateId, displayVersionId: second.versionId }]);
  assert.deepEqual(session.getCachedTurnCandidates(first.scope), [
    { turnId: first.history.turn_id, candidateIds: [first.candidateId] },
    { turnId: second.history.turn_id, candidateIds: [second.candidateId] },
  ]);
  for (const wrongScope of [
    { ...first.scope, contactId: randomUUID() },
    { ...first.scope, scopeRevision: first.scope.scopeRevision + 1 },
    { ...first.scope, sessionId: randomUUID() },
  ]) assert.throws(() => session.getCachedTurnCandidates(wrongScope));
});

test('切换联系人、会话或连接后迟到响应不能复活旧版本正文', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  for (const change of ['contact', 'session', 'generation']) {
    const f = fixture(); let release, generation = 7;
    f.backend.getConnectionGeneration = () => generation;
    f.backend.requestJson = (request) => request.path.endsWith('/selections')
      ? Promise.resolve({ generation: 7, data: { selection: null } })
      : new Promise((resolve) => { release = () => resolve({ generation: 7, data: f.history }); });
    const session = new AssistantCandidateVersionSession(f.backend);
    session.setScope(f.scope);
    const reading = session.read({ ...f.scope, candidateId: f.candidateId });
    if (change === 'generation') generation = 8;
    else session.setScope({ ...f.scope, scopeRevision: 5,
      ...(change === 'contact' ? { contactId: randomUUID() } : { sessionId: randomUUID() }) });
    release(); await reading;
    assert(!JSON.stringify(session.getState()).includes('明天见。'));
    assert.equal(session.getState().explicitCandidateSelection.selection, null);
  }
});

test('拒绝变换消息身份、聚合正文或外范围历史，失败清除该候选受信正文', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  for (const change of ['message', 'aggregate', 'session', 'parent', 'default']) {
    const f = fixture(), session = new AssistantCandidateVersionSession(f.backend);
    session.setScope(f.scope);
    await session.read({ ...f.scope, candidateId: f.candidateId });
    if (change === 'message') f.history.versions[1].messages[0].message_id = randomUUID();
    if (change === 'aggregate') f.history.versions[1].text = '伪造聚合正文';
    if (change === 'session') f.history.session_id = randomUUID();
    if (change === 'parent') f.history.versions[1].parent_version_id = randomUUID();
    if (change === 'default') f.history.default_display_version_id = f.candidateId;
    await assert.rejects(session.read({ ...f.scope, candidateId: f.candidateId }));
    assert.equal(session.getState().candidateVersions.items[0].history, null);
    assert.equal(session.getState().candidateVersions.items[0].phase, 'failed');
  }
});

test('另一候选的迟到读取不回退用户已经明确展开的旧版本', async () => {
  const { AssistantCandidateVersionSession } = await controller();
  const first = fixture(), second = fixture(); second.history.session_id = first.scope.sessionId;
  const session = new AssistantCandidateVersionSession(first.backend);
  session.setScope(first.scope);
  await session.read({ ...first.scope, candidateId: first.candidateId });
  let release;
  first.backend.requestJson = (request) => request.path.endsWith('/selections')
    ? Promise.resolve({ generation: 7, data: { selection: null } })
    : new Promise((resolve) => { release = () => resolve({ generation: 7, data: second.history }); });
  const reading = session.read({ ...first.scope, candidateId: second.candidateId });
  session.show({ ...first.scope, candidateId: first.candidateId, versionId: first.candidateId });
  release(); await reading;
  assert.equal(session.getState().candidateVersions.items.find((item) => item.candidateId === first.candidateId).displayVersionId,
    first.candidateId);
});

for (const operation of ['read', 'save', 'select', 'reconcile']) {
  test(`同scope较新读取接管展示后，${operation}已确认来源失效仍传递范围身份`, async () => {
    const ports = await controller(), first = fixture(), second = fixture();
    second.history.session_id = first.scope.sessionId;
    const actualSelection = { selection_id: randomUUID(), selection_number: 1,
      session_id: first.scope.sessionId, candidate_id: first.candidateId, version_id: first.versionId };
    first.backend.requestJson = async (request) => ({ generation: 7, data: request.path.endsWith('/selections')
      ? { selection: actualSelection } : request.path.includes(first.candidateId) ? first.history : second.history });
    const session = new ports.AssistantCandidateVersionSession(first.backend);
    session.setScope(first.scope);
    await session.read({ ...first.scope, candidateId: first.candidateId });
    await session.read({ ...first.scope, candidateId: second.candidateId });
    let release, reached, slow = true;
    const blocked = new Promise((resolve) => { reached = resolve; });
    const normal = first.backend.requestJson;
    first.backend.requestJson = (request) => {
      const primary = operation === 'reconcile' ? request.path.endsWith('/selections') && request.method === 'GET'
        : operation === 'select' ? request.path.endsWith('/selections') && request.method === 'POST'
          : request.path.includes(second.candidateId) && request.method === (operation === 'save' ? 'POST' : 'GET');
      if (!slow || !primary) return normal(request);
      slow = false; reached(); return new Promise((_resolve, reject) => {
        release = () => reject(new ports.BackendRequestFailure('response', 409,
          'assistant_candidate_version_conflict', 'source_unavailable'));
      });
    };
    const identity = { ...first.scope, candidateId: second.candidateId };
    const pending = operation === 'read' ? session.read(identity)
      : operation === 'save' ? session.save({ ...identity, editKey: randomUUID(), parentVersionId: second.versionId,
        messages: [{ messageId: second.messageId, text: '本轮合成尚未保存修改。' }], requirements: null })
        : operation === 'select' ? session.select({ ...identity, versionId: second.versionId, selectionKey: randomUUID() })
          : session.reconcile(first.scope, [first.candidateId, second.candidateId]);
    await blocked;
    await session.read({ ...first.scope, candidateId: first.candidateId });
    session.show({ ...first.scope, candidateId: first.candidateId, versionId: first.candidateId });
    release(); await assert.rejects(pending, (error) => {
      assert(error instanceof ports.AssistantCandidateSourceUnavailable);
      assert.deepEqual(error.scope, first.scope);
      assert.equal(error.generation, 7);
      assert.equal(error.candidateId, operation === 'reconcile' ? null : second.candidateId);
      return true;
    });
    assert.equal(session.getState().candidateVersions.items.find((item) => item.candidateId === first.candidateId).displayVersionId,
      first.candidateId);
    assert.equal(session.getState().explicitCandidateSelection.phase, 'ready');
    assert.equal(session.getState().explicitCandidateSelection.selection.versionId, first.versionId);
  });
}

test('read、save、select和reconcile仅传递确认来源失效及最小范围身份', async () => {
  const ports = await controller();
  for (const operation of ['read', 'save', 'select', 'reconcile']) {
    const f = fixture(), session = new ports.AssistantCandidateVersionSession(f.backend);
    session.setScope(f.scope);
    const identity = { ...f.scope, candidateId: f.candidateId };
    await session.read(identity);
    f.backend.requestJson = async () => { throw new ports.BackendRequestFailure('response', 409,
      'assistant_candidate_version_conflict', 'source_unavailable'); };
    const edited = { ...identity, editKey: randomUUID(), parentVersionId: f.versionId,
      messages: [{ messageId: f.messageId, text: '本次合成未保存编辑。' }], requirements: '本次合成未保存要求。' };
    await assert.rejects(operation === 'read' ? session.read(identity)
      : operation === 'save' ? session.save(edited)
        : operation === 'select' ? session.select({ ...identity, versionId: f.versionId, selectionKey: randomUUID() })
          : session.reconcile(f.scope, [f.candidateId]), (error) => {
      assert(error instanceof ports.AssistantCandidateSourceUnavailable);
      assert.deepEqual(error.scope, f.scope);
      assert.equal(error.generation, 7);
      assert.equal(error.candidateId, operation === 'reconcile' ? null : f.candidateId);
      assert(!JSON.stringify(error).includes('合成未保存'));
      assert.deepEqual(Object.keys(error.scope).sort(), ['contactId', 'scopeRevision', 'sessionId']);
      return true;
    });
    assert.equal(session.getState().explicitCandidateSelection.selection, null);
    if (operation !== 'reconcile') assert.equal(session.getState().candidateVersions.items[0].history, null);
  }
});

test('非404和409来源确认响应保留受信历史，不误传递来源删除', async () => {
  const ports = await controller();
  for (const failure of [new ports.BackendRequestFailure('connection'),
    new ports.BackendRequestFailure('response', 503, 'assistant_candidate_version_save_failed', 'source_unavailable'),
    new ports.BackendRequestFailure('response', 409, 'assistant_candidate_version_conflict'),
    new ports.BackendRequestFailure('response', 404, 'route_not_found')]) {
    const f = fixture(), session = new ports.AssistantCandidateVersionSession(f.backend);
    session.setScope(f.scope);
    await session.read({ ...f.scope, candidateId: f.candidateId });
    f.backend.requestJson = async () => { throw failure; };
    await assert.rejects(session.read({ ...f.scope, candidateId: f.candidateId }),
      (error) => !(error instanceof ports.AssistantCandidateSourceUnavailable));
    const state = session.getState();
    assert.equal(state.candidateVersions.items[0].history.versions[1].text, '那我们明天见。');
    assert.equal(state.candidateVersions.items[0].displayVersionId, f.versionId);
  }
});

test('read、save、select和reconcile结果operation已失效仍传递同scope来源409且不发布旧结果', async () => {
  const ports = await controller();
  for (const operation of ['read', 'save', 'select', 'reconcile']) {
    const f = fixture(), session = new ports.AssistantCandidateVersionSession(f.backend);
    session.setScope(f.scope);
    const identity = { ...f.scope, candidateId: f.candidateId };
    await session.read(identity);
    let release, current = true;
    f.backend.requestJson = () => new Promise((_resolve, reject) => {
      release = () => reject(new ports.BackendRequestFailure('response', 409,
        'assistant_candidate_version_conflict', 'source_unavailable'));
    });
    const reading = operation === 'read' ? session.read(identity, () => current)
      : operation === 'save' ? session.save({ ...identity, editKey: randomUUID(), parentVersionId: f.versionId,
        messages: [{ messageId: f.messageId, text: '旧操作合成编辑。' }], requirements: null }, () => current)
        : operation === 'select' ? session.select({ ...identity, versionId: f.versionId, selectionKey: randomUUID() }, () => current)
          : session.reconcile(f.scope, [f.candidateId], () => current);
    const before = session.getState(); current = false;
    release(); await assert.rejects(reading, (error) => {
      assert(error instanceof ports.AssistantCandidateSourceUnavailable);
      assert.deepEqual(error.scope, f.scope);
      assert.equal(error.generation, 7);
      assert.equal(error.candidateId, operation === 'reconcile' ? null : f.candidateId);
      return true;
    });
    assert.deepEqual(session.getState(), before);
  }
});

test('真实旧scope、SID或generation的来源迟到失效不报告也不污染新视图', async () => {
  const ports = await controller();
  for (const change of ['contact', 'revision', 'session', 'generation']) {
    const first = fixture(), second = fixture();
    let generation = 7, release;
    first.backend.getConnectionGeneration = () => generation;
    const session = new ports.AssistantCandidateVersionSession(first.backend);
    session.setScope(first.scope);
    await session.read({ ...first.scope, candidateId: first.candidateId });
    first.backend.requestJson = () => new Promise((_resolve, reject) => {
      release = () => reject(new ports.BackendRequestFailure('response', 409,
        'assistant_candidate_version_conflict', 'request_invalidated'));
    });
    const reading = session.read({ ...first.scope, candidateId: first.candidateId });
    const nextScope = { ...first.scope,
      ...(change === 'contact' ? { contactId: second.scope.contactId } : {}),
      ...(change === 'revision' ? { scopeRevision: first.scope.scopeRevision + 1 } : {}),
      ...(change === 'session' ? { sessionId: second.scope.sessionId } : {}) };
    if (change === 'generation') generation = 8;
    session.setScope(nextScope);
    second.history.session_id = nextScope.sessionId;
    first.backend.requestJson = async (request) => ({ generation, data: request.path.endsWith('/selections')
      ? { selection: null } : second.history });
    await session.read({ ...nextScope, candidateId: second.candidateId });
    const before = session.getState();
    release(); await assert.doesNotReject(reading);
    assert.deepEqual(session.getState(), before);
    assert.equal(session.getState().candidateVersions.items.find((item) => item.candidateId === second.candidateId).displayVersionId,
      second.versionId);
  }
});

for (const outcome of ['success', 'connection_failure']) {
  test(`reconcile选择GET在途时明确show旧版，${outcome}收尾不回退展示或隐式选择`, async () => {
    const ports = await controller(), f = fixture();
    const actual = { selection_id: randomUUID(), selection_number: 2,
      session_id: f.scope.sessionId, candidate_id: f.candidateId, version_id: f.versionId };
    const session = new ports.AssistantCandidateVersionSession(f.backend);
    session.setScope(f.scope);
    await session.read({ ...f.scope, candidateId: f.candidateId });
    let release, reached;
    const blocked = new Promise((resolve) => { reached = resolve; });
    f.backend.requestJson = (request) => {
      f.calls.push(request);
      reached(); return new Promise((resolve, reject) => {
        release = () => outcome === 'success' ? resolve({ generation: 7, data: { selection: actual } })
          : reject(new ports.BackendRequestFailure('transport'));
      });
    };
    const reading = session.reconcile(f.scope, [f.candidateId]).then(() => null, (error) => error);
    await blocked;
    session.show({ ...f.scope, candidateId: f.candidateId, versionId: f.candidateId });
    release(); const error = await reading;
    assert.equal(Boolean(error), outcome !== 'success');
    const state = session.getState();
    assert.equal(state.candidateVersions.items[0].displayVersionId, f.candidateId);
    assert.equal(state.candidateVersions.items[0].history.defaultDisplayVersionId, f.versionId);
    assert.equal(state.candidateVersions.phase, outcome === 'success' ? 'ready' : 'failed');
    assert.equal(state.explicitCandidateSelection.phase, outcome === 'success' ? 'ready' : 'failed');
    assert.equal(state.explicitCandidateSelection.selection?.versionId ?? null, outcome === 'success' ? f.versionId : null);
    assert(f.calls.every((request) => request.method === 'GET'));
  });
}
