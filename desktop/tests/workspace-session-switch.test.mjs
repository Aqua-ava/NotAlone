import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { historicalReplyFixture, renderSession, ports } from './fixtures/historical-reply-basis.mjs';

test('历史目录刷新失败仍要求明确继续，Main和工作区都保持生成门禁', async () => {
  const f = await historicalReplyFixture(), currentId = randomUUID(), originalRequest = f.backend.requestJson;
  let historical = false, fail = false, catalogGate;
  const renderWorkspace = state => ports.renderToStaticMarkup(ports.createElement(ports.UnifiedReplyWorkspace,
    { contacts: { state: f.contacts.getState() }, replies: { state } }));
  const disabledSuggestion = /<button(?=[^>]*aria-label="帮我想想")(?=[^>]*disabled="")[^>]*>/;
  f.backend.requestJson = async request => {
    if (request.path.endsWith('/assistant-sessions') && request.method === 'GET') {
      if (catalogGate) await catalogGate;
      if (fail) throw new ports.BackendRequestFailure('response', 503, 'unavailable');
      return { generation: f.records.generation, data: { sessions: [
        { session_id: f.sessionId, is_current: !historical },
        ...(historical ? [{ session_id: currentId, is_current: true }] : []),
      ], current_session_id: historical ? currentId : f.sessionId } };
    }
    return originalRequest(request);
  };
  try {
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.enterWorkspace(f.scope);
    assert.doesNotMatch(renderWorkspace(await f.bridge.getState()), disabledSuggestion,
      '首次已确认当前会话仍可正常生成');
    historical = true;
    await f.bridge.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
    await f.bridge.enterWorkspace(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '合成未明确继续的历史输入' });
    let releaseCatalog;
    catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    const refreshing = f.bridge.listSavedSessions(f.scope);
    try {
      const loading = await f.bridge.getState();
      assert.equal(loading.sessionCatalog.phase, 'loading');
      assert.match(renderWorkspace(loading), disabledSuggestion);
      await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true }), /明确继续/);
    } finally { catalogGate = undefined; releaseCatalog(); await refreshing; }
    fail = true;
    await f.bridge.listSavedSessions(f.scope);
    const failed = await f.bridge.getState(), mark = f.calls.length;
    assert.equal(failed.sessionCatalog.phase, 'failed');
    assert.equal(failed.sessionCatalog.currentSessionId, currentId);
    let generationError;
    await f.bridge.generate({ ...f.scope, newRequest: true, workspaceAction: 'suggest' })
      .catch(error => { generationError = error.message; });
    assert.equal(f.calls.slice(mark).filter(call => call.method === 'POST'
      && /\/(replies(?:\/prepare)?|continue)$/.test(call.path)).length, 0,
    '目录故障不能向未经继续的历史段发出准备或生成');
    assert.match(generationError, /明确继续/);
    assert.match(renderWorkspace(failed), disabledSuggestion);
    fail = false;
    await f.bridge.listSavedSessions(f.scope);
    await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true }), /明确继续/);
    await f.bridge.resumeSavedSession({ ...f.scope, sessionId: f.sessionId });
    assert.equal((await f.bridge.getState()).sessionCatalog.currentSessionId, f.sessionId);
    assert.equal(f.calls.filter(call => call.path.endsWith('/resume')).length, 1);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('生产Main与preload的历史查看只读，明确继续才切换当前', async () => {
  const f = await historicalReplyFixture();
  const currentId = randomUUID(), originalRequest = f.backend.requestJson;
  f.backend.requestJson = async request => request.path.endsWith('/assistant-sessions') && request.method === 'GET'
    ? { generation: f.records.generation, data: { sessions: [{ session_id: f.sessionId, is_current: false },
      { session_id: currentId, is_current: true }], current_session_id: currentId } }
    : request.path.endsWith('/resume') ? (f.calls.push(request), { generation: f.records.generation,
      data: { session_id: f.sessionId } }) : originalRequest(request);
  try {
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.listSavedSessions(f.scope);
    await f.bridge.viewSavedSession({ ...f.scope, sessionId: f.sessionId });
    assert.equal(f.replies.getState().savedSession.sessionId, f.sessionId);
    assert.equal(f.replies.getState().sessionCatalog.currentSessionId, currentId);
    assert.equal(f.calls.some(call => call.method === 'POST'), false, '回看不能创建默认会话或切换当前');
    assert.match(renderSession(f.replies.getState()), /继续此会话/);
    await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true, workspaceAction: 'suggest' }), /明确继续此会话/);
    await f.bridge.resumeSavedSession({ ...f.scope, sessionId: f.sessionId });
    assert.equal(f.replies.getState().sessionCatalog.currentSessionId, f.sessionId);
    assert.equal(f.calls.filter(call => call.path.endsWith('/resume')).length, 1);
    assert.equal(f.calls.some(call => /\/(replies|continue)$/.test(call.path)), false);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('首次只读打开空目录不建立默认会话', async () => {
  const f = await historicalReplyFixture(), originalRequest = f.backend.requestJson;
  f.backend.requestJson = async request => request.path.endsWith('/assistant-sessions') && request.method === 'GET'
    ? { generation: f.records.generation, data: { sessions: [], current_session_id: null } } : originalRequest(request);
  try {
    await f.bridge.readSavedSession(f.scope);
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    assert.equal(f.replies.getState().savedSession.sessionId, null);
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('会话目录报告切换完成时可立即进入工作区，清空临时想法和要求', async () => {
  const f = await historicalReplyFixture();
  const emptyId = randomUUID(), originalRequest = f.backend.requestJson;
  f.backend.requestJson = async request => {
    if (request.path.endsWith('/assistant-sessions') && request.method === 'POST') {
      return { generation: f.records.generation, data: { session_id: emptyId } };
    }
    if (request.path.endsWith(emptyId)) return { generation: f.records.generation,
      data: { session_id: emptyId, current_input_version_id: null, turns: [], inputs: [] } };
    return originalRequest(request);
  };
  await f.bridge.readSavedSession(f.scope);
  await f.bridge.enterWorkspace(f.scope);
  f.contacts.setDraft({ ...f.scope, text: '未提交的合成想法' });
  await f.bridge.updateOptions({ ...f.scope, options: { tone: 'warm', instruction: '临时要求',
    inputKind: 'workspace', includeRelationshipContext: false, contextText: '临时聊天背景' } });
  let attempted = false, migration;
  const unsubscribe = f.replies.onStateChanged(state => {
    if (!attempted && state.savedSession?.sessionId === emptyId && state.sessionCatalog?.phase === 'ready') {
      attempted = true;
      migration = f.bridge.enterWorkspace(f.scope).then(() => null, error => error.message);
    }
  });
  try {
    await f.bridge.newSavedSession(f.scope);
    assert.equal(attempted, true);
    assert.equal(await migration, null, '完成通知不能早于切换锁释放，否则自动进入工作区会永久失败');
    assert.equal(f.contacts.getState().draft, '');
    const state = await f.bridge.getState();
    assert.equal(state.options.inputKind, 'workspace');
    assert.equal(state.options.instruction, '');
    assert.equal(state.options.contextText ?? '', '');
    assert.equal(state.options.tone, 'original');
    assert.deepEqual(state.savedSession.turns, []);
  } finally { unsubscribe(); await f.replies.beginGenerationClosing(() => {}); }
});

test('工作区明确继续只附在本次生成请求，不成为后续默认确认', async () => {
  const f = await historicalReplyFixture();
  try {
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.enterWorkspace(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '合成想法' });
    await f.bridge.generate({ ...f.scope, newRequest: true, workspaceAction: 'express', allowIncompleteHistory: true });
    const request = f.calls.find(call => call.path.endsWith('/replies/prepare'));
    assert.equal(request.body.allow_incomplete_history, true);
    assert.equal(f.replies.getState().options.allowIncompleteHistory, undefined);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('恢复助手对话后保留当时的不完整历史警告', async () => {
  const f = await historicalReplyFixture();
  try {
    f.records.saved.turns[0].input.allow_incomplete_history = true;
    await f.bridge.readSavedSession(f.scope);
    assert.match(renderSession(f.replies.getState()), /历史覆盖不完整/);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});
