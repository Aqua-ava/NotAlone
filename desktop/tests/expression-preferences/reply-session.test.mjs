import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPreferenceBackend } from './http-support.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withPreferencePanels } from './react-support.mjs';

test('删除未用于当前候选的偏好后，公开复核恢复合法候选与用户编辑', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, ReplySession, ContactSession,
    contactSummaries, backend, contactIds }) => {
    const contacts = new ContactSession(async () => ({ generation: 1,
      contacts: contactSummaries((await backend.requestJson({ method: 'GET', path: '/api/contacts' })).data) }));
    contacts.setConnection(1);
    await contacts.refreshContacts();
    contacts.selectContact({ contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision });
    const selection = { contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision };
    const replies = new ReplySession(contacts, backend, () => null);
    const preferences = new ExpressionPreferenceController(backend, contacts, {
      started: () => replies.beginExpressionPreferenceDeletion(), settled: () => replies.revalidateExpressionPreferences(),
    });
    try {
      await preferences.save({ ...selection, text: '仅主动联系适用的合成要求。', appliesTo: 'contact',
        replyMode: 'initiate_conversation', confirmLongTerm: true });
      const preference = preferences.getState().preferences[0];
      contacts.setDraft({ ...selection, text: '用户独立编辑的合成草稿。' });
      await replies.generate(selection);
      const generated = replies.getState().result;
      assert.ok(generated);
      assert.deepEqual(generated.expressionPreferenceIds, []);
      replies.editCandidate({ ...selection, replyRequestId: generated.replyRequestId,
        candidateId: generated.candidates[0].original.candidateId, text: '保留未受删除影响的用户编辑。' });
      await preferences.remove({ ...selection, preferenceId: preference.preferenceId, expectedRevision: 1 });
      const restored = replies.getState();
      assert.equal(restored.phase, 'ready');
      assert.equal(restored.result?.replyRequestId, generated.replyRequestId);
      assert.equal(restored.result?.candidates[0].editedText, '保留未受删除影响的用户编辑。');
      assert.equal(contacts.getState().draft, '用户独立编辑的合成草稿。');
    } finally { replies.beginGenerationClosing(); }
  });
});

test('多轮实际 HTTP 生成恢复后，每个历史轮次显示自己的偏好正文范围与版本，删除清全部旧依据', { timeout: 30000 }, async () => {
  await withPreferencePanels(async ({ AssistantSessionPanel }) => {
    await withPreferenceBackend(async ({ ExpressionPreferenceController, ReplySession, ContactSession,
      contactSummaries, backend, contactIds }) => {
      const contacts = new ContactSession(async () => ({ generation: 1,
        contacts: contactSummaries((await backend.requestJson({ method: 'GET', path: '/api/contacts' })).data) }));
      contacts.setConnection(1);
      await contacts.refreshContacts();
      contacts.selectContact({ contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision });
      const selection = { contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision };
      const replies = new ReplySession(contacts, backend, () => null);
      const recovered = new ReplySession(contacts, backend, () => null);
      const preferences = new ExpressionPreferenceController(backend, contacts);
      try {
        await preferences.refresh(selection);
        await preferences.save({ ...selection, text: '第一轮生成时的旧要求：保留称呼。',
          appliesTo: 'contact', replyMode: 'rewrite_draft', confirmLongTerm: true });
        const firstPreference = preferences.getState().preferences[0];
        contacts.setDraft({ ...selection, text: '第一轮用户明确草稿。' });
        await replies.generate(selection);
        assert.equal(replies.getState().phase, 'ready');
        const first = replies.getState().result;
        await preferences.update({ ...selection, preferenceId: firstPreference.preferenceId, expectedRevision: 1,
          text: '第二轮生成时的新要求：用短句。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true });
        const secondPreference = preferences.getState().preferences[0];
        contacts.setDraft({ ...selection, text: '第二轮用户明确的新草稿。' });
        await replies.generate(selection);
        assert.equal(replies.getState().phase, 'ready');
        const second = replies.getState().result;
        await recovered.readSavedSession(selection);
        const state = recovered.getState();
        assert.equal(state.result, null);
        assert.equal(state.savedSession.phase, 'ready');
        assert.equal(state.savedSession.turns.length, 2);
        for (const [index, [expected, result]] of [[firstPreference, first], [secondPreference, second]].entries()) {
          const turn = state.savedSession.turns[index];
          assert.equal(turn.reply.replyRequestId, result.replyRequestId);
          assert.deepEqual(turn.reply.expressionPreferences, [{ preferenceId: expected.preferenceId, text: expected.text,
            scope: expected.scope, revision: expected.revision }]);
        }
        const markup = renderToStaticMarkup(React.createElement(AssistantSessionPanel, { replies: { state } }));
        const articles = [...markup.matchAll(/<article\b[^>]*\baria-label="第(\d+)轮讨论"[^>]*>([\s\S]*?)<\/article>/g)];
        assert.equal(articles.length, 2);
        assert.match(articles[0][2], /第一轮生成时的旧要求：保留称呼。/);
        assert.match(articles[0][2], /当前联系人 · 改写草稿 · 生成时版本1/);
        assert.doesNotMatch(articles[0][2], /第二轮生成时的新要求/);
        assert.match(articles[1][2], /第二轮生成时的新要求：用短句。/);
        assert.match(articles[1][2], /本人全局 · 全部输入模式 · 生成时版本2/);
        assert.doesNotMatch(articles[1][2], /第一轮生成时的旧要求/);
        await preferences.remove({ ...selection, preferenceId: secondPreference.preferenceId, expectedRevision: 2 });
        await recovered.readSavedSession(selection);
        const erased = recovered.getState();
        assert.ok(erased.savedSession.turns.every((turn) => turn.state === 'redacted' && turn.reply === null));
        const erasedMarkup = renderToStaticMarkup(React.createElement(AssistantSessionPanel, { replies: { state: erased } }));
        assert.doesNotMatch(erasedMarkup, /第一轮生成时的旧要求|第二轮生成时的新要求/);
      } finally { replies.beginGenerationClosing(); recovered.beginGenerationClosing(); }
    });
  });
});

test('React 生产回复控制器读取偏好回执，修改偏好保留用户编辑，删除隔离候选但保留本次输入', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, ReplySession, ContactSession, CandidateCopyController,
    StyleSampleController, contactSummaries, backend, contactIds }) => {
    const contacts = new ContactSession(async () => ({ generation: 1,
      contacts: contactSummaries((await backend.requestJson({ method: 'GET', path: '/api/contacts' })).data) }));
    contacts.setConnection(1);
    await contacts.refreshContacts();
    contacts.selectContact({ contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision });
    const selection = { contactId: contactIds[0], scopeRevision: contacts.getState().scopeRevision };
    const replies = new ReplySession(contacts, backend, () => null);
    const preferences = new ExpressionPreferenceController(backend, contacts, {
      started: () => replies.beginExpressionPreferenceDeletion(), settled: () => replies.revalidateExpressionPreferences(),
    });
    const recovered = new ReplySession(contacts, backend, () => null);
    try {
      contacts.setDraft({ ...selection, text: '本次草稿由用户明确输入。' });
      await preferences.refresh(selection);
      replies.updateOptions({ ...selection, options: { tone: 'original', instruction: '仅这一次使用的合成指令。', includeRelationshipContext: false } });
      await replies.generate(selection);
      const once = replies.getState().result;
      assert.ok(once);
      const chosen = { ...selection, replyRequestId: once.replyRequestId, candidateId: once.candidates[0].original.candidateId };
      replies.selectCandidate(chosen);
      const clipboard = [];
      const samples = new StyleSampleController(backend, contacts, replies);
      const copies = new CandidateCopyController(backend, contacts, replies, (request, text) => samples.recordCopied(request, text));
      await copies.copy({ ...chosen, hideAfterCopy: false }, { writeText: async (text) => clipboard.push(text), hideWindow() {} });
      assert.deepEqual(clipboard, [once.candidates[0].editedText]);
      await samples.saveCandidate(chosen);
      assert.equal(samples.getState().samples.length, 1);
      await preferences.refresh(selection);
      assert.deepEqual(preferences.getState().preferences, []);
      replies.updateOptions({ ...selection, options: { tone: 'original', instruction: '', includeRelationshipContext: false } });
      await preferences.save({ ...selection, text: '后续尽量简短。', appliesTo: 'contact', replyMode: null, confirmLongTerm: true });
      const item = preferences.getState().preferences[0];
      await replies.generate(selection);
      const generated = replies.getState();
      assert.equal(generated.phase, 'ready', JSON.stringify(generated));
      assert.deepEqual(generated.result.expressionPreferenceIds, [item.preferenceId]);
      const receipt = [{ preferenceId: item.preferenceId, text: item.text, scope: item.scope, revision: 1 }];
      assert.deepEqual(generated.result.expressionPreferences, receipt);
      const edit = { ...selection, replyRequestId: generated.result.replyRequestId,
        candidateId: generated.result.candidates[0].original.candidateId, text: '用户正在编辑的合法候选。' };
      replies.editCandidate(edit);
      await preferences.update({ ...selection, preferenceId: item.preferenceId, expectedRevision: 1,
        text: '后续保留称呼。', appliesTo: 'contact', replyMode: null, confirmLongTerm: true });
      assert.equal(replies.getState().result.candidates[0].editedText, edit.text);
      assert.deepEqual(replies.getState().result.expressionPreferences, receipt);
      await recovered.readSavedSession(selection);
      assert.equal(recovered.getState().result, null);
      assert.equal(recovered.getState().savedSession.phase, 'ready');
      assert.deepEqual(recovered.getState().savedSession.turns.at(-1).reply.expressionPreferences, receipt);
      contacts.setDraft({ ...selection, text: '用户另行编辑的当前草稿。' });
      replies.updateOptions({ ...selection, options: { tone: 'original', instruction: '本次仍按用户明确的指令。', includeRelationshipContext: false } });
      await preferences.remove({ ...selection, preferenceId: item.preferenceId, expectedRevision: 2 });
      assert.equal(replies.getState().result, null);
      assert.equal(replies.getState().sourceAvailability, undefined);
      assert.equal(contacts.getState().draft, '用户另行编辑的当前草稿。');
      assert.equal(replies.getState().options.instruction, '本次仍按用户明确的指令。');
      await recovered.readSavedSession(selection);
      assert.ok(recovered.getState().savedSession.turns.every((turn) => !turn.reply?.expressionPreferences?.length));
      assert.ok(!JSON.stringify(recovered.getState()).includes(item.text));
    } finally { replies.beginGenerationClosing(); recovered.beginGenerationClosing(); }
  });
});

test('本人全局偏好在隐藏甲联系人删除后，A→B→A清候选回执与编辑并保留两边独立草稿', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, ReplySession, ContactSession,
    contactSummaries, backend, contactIds }) => {
    const contacts = new ContactSession(async () => ({ generation: 1,
      contacts: contactSummaries((await backend.requestJson({ method: 'GET', path: '/api/contacts' })).data) }));
    contacts.setConnection(1); await contacts.refreshContacts();
    const select = (contactId) => {
      contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
      return { contactId, scopeRevision: contacts.getState().scopeRevision };
    };
    let selection = select(contactIds[0]);
    const replies = new ReplySession(contacts, backend, () => null);
    const preferences = new ExpressionPreferenceController(backend, contacts, {
      started: () => replies.beginExpressionPreferenceDeletion(), settled: () => replies.revalidateExpressionPreferences(),
    });
    try {
      await preferences.save({ ...selection, text: '隐藏联系人也必须失效的本人全局合成偏好。',
        appliesTo: 'owner', replyMode: null, confirmLongTerm: true });
      const preference = preferences.getState().preferences[0];
      contacts.setDraft({ ...selection, text: '甲独立输入的草稿。' });
      await replies.generate(selection); await replies.readSavedSession(selection);
      const result = replies.getState().result;
      replies.editCandidate({ ...selection, replyRequestId: result.replyRequestId,
        candidateId: result.candidates[0].original.candidateId, text: '依赖已删偏好的甲候选编辑。' });
      selection = select(contactIds[1]); replies.getState();
      contacts.setDraft({ ...selection, text: '乙独立输入的草稿。' });
      selection = select(contactIds[0]); replies.getState(); await replies.readSavedSession(selection);
      assert.equal(replies.getState().result.expressionPreferences[0].text, preference.text);
      assert.equal(replies.getState().result.candidates[0].editedText, '依赖已删偏好的甲候选编辑。');
      selection = select(contactIds[1]); replies.getState();
      await preferences.refresh(selection);
      await preferences.remove({ ...selection, preferenceId: preference.preferenceId, expectedRevision: 1 });
      assert.equal(contacts.getState().draft, '乙独立输入的草稿。');
      selection = select(contactIds[0]); replies.getState(); await replies.readSavedSession(selection);
      const state = replies.getState();
      assert.equal(state.result, null);
      assert.deepEqual(state.candidateDrafts ?? [], []);
      assert.equal(state.canRetry, false);
      assert.ok(!JSON.stringify(state).includes(preference.text));
      assert.ok(!JSON.stringify(state).includes('依赖已删偏好的甲候选编辑。'));
      assert.equal(contacts.getState().draft, '甲独立输入的草稿。');
    } finally { replies.beginGenerationClosing(); }
  });
});
