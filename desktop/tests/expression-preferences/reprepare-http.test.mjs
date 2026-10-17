import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPreferenceBackend } from './http-support.mjs';

test('真实HTTP在首次prepare后修改偏好会封旧键，明确核对后才新prepare并读取revision2', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, ReplySession, ContactSession,
    contactSummaries, backend, contactIds }) => {
    const contacts = new ContactSession(async () => ({ generation: 1,
      contacts: contactSummaries((await backend.requestJson({ method: 'GET', path: '/api/contacts' })).data) }));
    contacts.setConnection(1); await contacts.refreshContacts();
    contacts.selectContact({ contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision });
    const scope = { contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision };
    const replies = new ReplySession(contacts, backend, () => null), preferences = new ExpressionPreferenceController(backend, contacts);
    try {
      await preferences.save({ ...scope, text: '准备时明确保存的合成旧偏好。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true });
      const preference = preferences.getState().preferences[0], calls = [], original = backend.requestJson;
      backend.requestJson = async (request) => {
        calls.push(request);
        const result = await original(request);
        if (request.path.endsWith('/replies/prepare') && calls.filter((item) => item.path.endsWith('/replies/prepare')).length === 1) {
          await preferences.update({ ...scope, preferenceId: preference.preferenceId, expectedRevision: 1,
            text: '用户明确修改的合成新偏好。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true });
        }
        return result;
      };
      contacts.setDraft({ ...scope, text: '整个恢复过程保持的用户草稿。' });
      await replies.generate({ ...scope, newRequest: false });
      assert.equal(replies.getState().errorCode, 'prepared_context_reprepare_required');
      assert.equal(replies.getState().canRetry, false); assert.equal(replies.getState().result, null);
      assert.equal(calls.filter((item) => item.path.endsWith('/replies/prepare')).length, 1);
      await replies.generate({ ...scope, newRequest: false });
      assert.equal(calls.filter((item) => item.path.endsWith('/replies/prepare')).length, 1);
      await replies.generate({ ...scope, newRequest: true });
      const prepared = calls.filter((item) => item.path.endsWith('/replies/prepare'));
      assert.equal(prepared.length, 2); assert.notEqual(prepared[0].body.idempotency_key, prepared[1].body.idempotency_key);
      assert.equal(calls.filter((item) => item.path.endsWith('/preparation-format')).length, 1);
      assert.equal(contacts.getState().draft, '整个恢复过程保持的用户草稿。');
      assert.equal(replies.getState().result.input.draftText, '整个恢复过程保持的用户草稿。');
      assert.equal(replies.getState().result.expressionPreferences[0].revision, 2);
      assert.equal(replies.getState().result.expressionPreferences[0].text, '用户明确修改的合成新偏好。');
      await replies.readSavedSession(scope);
      const saved = replies.getState().savedSession;
      assert.equal(saved.turns.length, 2); assert.equal(saved.turns[0].state, 'failed');
      assert.equal(saved.turns[0].requiresReprepare, true); assert.equal(saved.turns[0].generationActive, false);
      assert.equal(prepared[1].body.expected_input_version_id, saved.turns[0].inputVersionId);
    } finally { replies.beginGenerationClosing(); }
  });
});
