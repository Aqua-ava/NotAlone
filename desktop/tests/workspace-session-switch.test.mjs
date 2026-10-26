import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { historicalReplyFixture, renderSession } from './fixtures/historical-reply-basis.mjs';

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
