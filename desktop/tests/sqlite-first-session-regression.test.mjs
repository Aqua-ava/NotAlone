import assert from 'node:assert/strict';
import test from 'node:test';
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
