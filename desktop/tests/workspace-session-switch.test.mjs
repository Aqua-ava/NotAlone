import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { historicalReplyFixture } from './fixtures/historical-reply-basis.mjs';

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
