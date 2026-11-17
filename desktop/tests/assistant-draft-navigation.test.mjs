import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteAssistantFixture } from './fixtures/sqlite-assistant-session.mjs';

test('新开、回看与明确继续同一联系人的讨论均保留未提交独立想法', async t => {
  const f = await sqliteAssistantFixture(t);
  const text = '只属于本次表达的独立想法，不是历史讨论或关系事实';
  f.contacts.setDraft({ ...f.scope(), text });
  await f.bridge.newSavedSession(f.scope());
  const current = f.replies.getState().savedSession.sessionId;
  assert.notEqual(current, f.sessionId);
  assert.equal(f.contacts.getState().draft, text);
  await f.bridge.viewSavedSession({ ...f.scope(), sessionId: f.sessionId });
  assert.equal(f.control.currentSessionId, current, '回看不改变当前讨论');
  assert.equal(f.contacts.getState().draft, text);
  assert.equal(f.replies.getState().savedSession.discussionEntries[0].text, '合成历史讨论输入');
  await f.bridge.resumeSavedSession({ ...f.scope(), sessionId: f.sessionId });
  assert.equal(f.control.currentSessionId, f.sessionId, '只有明确继续才切换当前讨论');
  assert.equal(f.contacts.getState().draft, text);
  assert.equal(f.calls.some(call => /reply-candidates|\/entries$/.test(call.path)), false, '独立输入不会因导航送给模型');
});
