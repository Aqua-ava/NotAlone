import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { historicalReplyFixture } from './fixtures/historical-reply-basis.mjs';

test('尚未核验助手会话时不调用旧回复接口', async () => {
  const f = await historicalReplyFixture(), original = f.backend.requestJson;
  f.backend.requestJson = async request => request.path.endsWith('/assistant-sessions') && request.method === 'GET'
    ? { generation: f.records.generation, data: { sessions: [], current_session_id: null } } : original(request);
  try {
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.enterWorkspace(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '合成的首次表达想法' });
    await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true, workspaceAction: 'express' }), /助手会话/);
    assert.equal(f.calls.some(call => /\/replies(?:\/prepare)?$/.test(call.path)), false);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('首次明确开始 SQLite 会话保留想法并拒绝旧生成接口', async () => {
  const f = await historicalReplyFixture(), original = f.backend.requestJson;
  let created = false;
  f.backend.requestJson = async request => {
    if (request.path.endsWith('/assistant-sessions') && request.method === 'GET') return { generation: f.records.generation,
      data: created ? { sessions: [{ session_id: f.sessionId, is_current: true }], current_session_id: f.sessionId }
        : { sessions: [], current_session_id: null } };
    if (request.path.endsWith('/assistant-sessions') && request.method === 'POST') {
      created = true; return { generation: f.records.generation, data: { session_id: f.sessionId } };
    }
    if (request.path.endsWith(f.sessionId) && request.method === 'GET') return { generation: f.records.generation,
      data: { mode: 'sqlite', session_id: f.sessionId, entries: [], runtime_recovery: 'none' } };
    return original(request);
  };
  try {
    await f.bridge.readSavedSession(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '合成的首次表达想法' });
    await f.bridge.newSavedSession(f.scope);
    assert.equal(f.contacts.getState().draft, '合成的首次表达想法');
    assert.deepEqual(f.replies.getState().savedSession.discussionEntries, []);
    await assert.rejects(f.bridge.generate({ ...f.scope, newRequest: true, workspaceAction: 'express' }), /助手会话/);
    assert.equal(f.calls.some(call => /\/replies(?:\/prepare)?$/.test(call.path)), false);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('空目录页面提供明确开始入口并保留当前草稿', async () => {
  const { ports } = await import('./fixtures/historical-reply-basis.mjs');
  const markup = ports.renderToStaticMarkup(ports.createElement(ports.UnifiedReplyWorkspace, {
    contacts: { state: { selectedContactId: 'contact', scopeRevision: 1, draft: '首次的合成想法' } },
    replies: { state: { contactId: 'contact', scopeRevision: 1, phase: 'idle', mode: 'rewrite_draft',
      generationBlock: null, options: { inputKind: 'workspace', tone: 'original', instruction: '', includeRelationshipContext: true },
      savedSession: { phase: 'ready', sessionId: null }, messages: { phase: 'idle', items: [] } } },
  }));
  assert.match(markup, /开始助手会话/);
  assert.match(markup, /首次的合成想法/);
  assert.doesNotMatch(markup, /帮我表达|帮我想想/);
});

test('旧会话读取失败后明确新开讨论保留当前独立草稿，并清空旧讨论输入', async () => {
  const f = await historicalReplyFixture(), original = f.backend.requestJson;
  const newSessionId = randomUUID();
  f.backend.requestJson = async request => {
    if (request.path.endsWith('/assistant-sessions') && request.method === 'POST') return {
      generation: f.records.generation, data: { session_id: newSessionId } };
    if (request.path.endsWith(f.sessionId) && request.method === 'GET') throw new Error('合成的旧讨论读取失败');
    if (request.path.endsWith(newSessionId) && request.method === 'GET') return {
      generation: f.records.generation,
      data: { mode: 'sqlite', session_id: newSessionId, entries: [], runtime_recovery: 'none' } };
    return original(request);
  };
  try {
    await f.bridge.updateOptions({ ...f.scope, options: { ...f.replies.getState().options,
      inputKind: 'workspace', contextText: '旧讨论补充的合成聊天', instruction: '旧讨论的合成要求' } });
    await f.bridge.readSavedSession(f.scope);
    assert.equal(f.replies.getState().savedSession.phase, 'failed');
    f.contacts.setDraft({ ...f.scope, text: '读取失败时新写下的合成想法' });
    await f.bridge.newSavedSession(f.scope);
    const state = f.replies.getState();
    assert.equal(f.contacts.getState().draft, '读取失败时新写下的合成想法');
    assert.equal(state.savedSession.sessionId, newSessionId);
    assert.equal(state.savedSession.phase, 'ready');
    assert.deepEqual(state.savedSession.discussionEntries, []);
    assert.equal(state.result, null);
    assert.equal(state.options.contextText, undefined);
    assert.equal(state.options.instruction, '');
    assert.equal(state.targetMessageId, null);
    assert.equal(state.requirements, '');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('等待旧讨论读取时编辑的本地想法不会被迟到的恢复结果覆盖', async () => {
  const f = await historicalReplyFixture(), original = f.backend.requestJson;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let restoring = false;
  f.backend.requestJson = async request => {
    if (restoring && request.path.endsWith(f.sessionId) && request.method === 'GET') {
      entered.resolve(); await release.promise;
    }
    return original(request);
  };
  try {
    await f.bridge.readSavedSession(f.scope);
    await f.bridge.enterWorkspace(f.scope);
    f.contacts.setDraft({ ...f.scope, text: '缓存中的合成旧想法' });
    f.contacts.invalidateReadingScope();
    const scope = { contactId: f.scope.contactId, scopeRevision: f.contacts.getState().scopeRevision };
    restoring = true;
    const reading = f.bridge.readSavedSession(scope);
    await entered.promise;
    f.contacts.setDraft({ ...scope, text: '等待期间新写下的合成想法' });
    release.resolve(); await reading;
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    await f.bridge.enterWorkspace(scope);
    assert.equal(f.contacts.getState().draft, '等待期间新写下的合成想法');
  } finally { release.resolve(); await f.replies.beginGenerationClosing(() => {}); }
});
