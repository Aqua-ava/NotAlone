import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('组内复制只接身份并从当前展示的受信版本取文本', async (t) => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-message-copy-'));
  try {
    const bundle = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/candidate-copy/controller.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { CandidateCopyController, candidateCopyRequest } = await import(pathToFileURL(bundle).href);
    const contactId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const replyRequestId = '33333333-3333-4333-8333-333333333333';
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const versionId = '55555555-5555-4555-8555-555555555555';
    const firstId = '66666666-6666-4666-8666-666666666666';
    const secondId = '77777777-7777-4777-8777-777777777777';
    const turnId = '88888888-8888-4888-8888-888888888888';
    const selection = { contactId, scopeRevision: 1, replyRequestId, candidateId, hideAfterCopy: false };
    const messageRequest = { ...selection, versionId, messageId: secondId };
    const texts = ['最近还好吗？', '方便时聊聊，不急着安排。'];
    function fixture(restored = false) {
      const original = { candidateId, text: '原始第一条。\n\n原始第二条。' };
      const messages = texts.map((text, index) => ({ messageId: index ? secondId : firstId, text }));
      const versions = [{ versionId: candidateId, versionNumber: 0, parentVersionId: null,
        messages: messages.map((message, index) => ({ ...message, text: `原始第${index + 1}条。` })),
        text: original.text, requirements: null },
      { versionId, versionNumber: 1, parentVersionId: candidateId, messages,
        text: texts.join('\n\n'), requirements: '不增加安排承诺。' }];
      const state = { contactId, scopeRevision: 1, phase: 'ready',
        selectedCandidateId: restored ? null : candidateId,
        result: restored ? null : { replyRequestId, assistantSessionId: sessionId, input: { mode: 'rewrite_draft' },
          candidates: [{ original, editedText: texts.join('\n\n') }] },
        candidateVersions: { phase: 'ready', sessionId, items: [{ candidateId, phase: 'ready',
          displayVersionId: versionId, history: { sessionId, turnId, candidateId,
            defaultDisplayVersionId: versionId, selectedVersionId: versionId, versions } }] },
        explicitCandidateSelection: { phase: 'ready', selection: { sessionId, candidateId, versionId } },
        savedSession: { phase: 'ready', sessionId, turns: [{ turnId, state: 'completed',
          reply: { replyRequestId, candidates: [original] } }] } };
      const contact = { selectedContactId: contactId, scopeRevision: 1, directoryPhase: 'ready' };
      const connection = { generation: 1 };
      const writes = [], copied = [];
      let hidden = 0;
      const controller = new CandidateCopyController({ getConnectionGeneration: () => connection.generation },
        { getState: () => structuredClone(contact) }, { getState: () => structuredClone(state) },
        (request, text) => copied.push({ request, text }));
      const surface = { writeText: async (text) => { writes.push(text); }, hideWindow: () => { hidden += 1; } };
      return { controller, surface, writes, copied, state, contact, connection, hidden: () => hidden };
    }
    await t.test('原五字段整组复制兼容，回执只说明复制', async () => {
      assert.deepEqual(candidateCopyRequest([selection]), selection);
      const f = fixture();
      await f.controller.copy(selection, f.surface);
      assert.deepEqual(f.writes, [texts.join('\n\n')]);
      assert.deepEqual(f.copied, [{ request: selection, text: texts.join('\n\n') }]);
      assert.equal(f.hidden(), 0);
    });
    for (const selectedCandidateId of [null, firstId]) await t.test('改写候选无需先选中即可按身份复制当前文本', async () => {
      const f = fixture();
      f.state.selectedCandidateId = selectedCandidateId;
      await f.controller.copy(selection, f.surface);
      assert.deepEqual(f.writes, [texts.join('\n\n')]);
      assert.deepEqual(f.copied, [{ request: selection, text: texts.join('\n\n') }]);
    });
    await t.test('改写复制仍拒绝其他轮次和未知候选', async () => {
      const f = fixture();
      await assert.rejects(f.controller.copy({ ...selection, replyRequestId: firstId }, f.surface));
      await assert.rejects(f.controller.copy({ ...selection, candidateId: firstId }, f.surface));
      assert.deepEqual(f.writes, []);
    });
    for (const mode of ['reply_to_message', 'initiate_conversation']) await t.test(`${mode}不借旧五字段绕过版本身份复制整组`, async () => {
      const f = fixture();
      f.state.result.input.mode = mode;
      f.state.explicitCandidateSelection.selection = null;
      await assert.rejects(f.controller.copy(selection, f.surface));
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.copied, []);
    });
    await t.test('可选消息与版本UUID必须成对且不接Renderer正文', () => {
      assert.deepEqual(candidateCopyRequest([messageRequest]), messageRequest);
      for (const request of [
        { ...selection, messageId: secondId }, { ...selection, versionId },
        { ...messageRequest, versionId: null }, { ...messageRequest, messageId: 'not-an-id' },
        { ...messageRequest, text: '任意正文' }, { ...messageRequest, sessionId },
        { ...messageRequest, hideAfterCopy: 1 },
      ]) assert.throws(() => candidateCopyRequest([request]));
    });
    await t.test('按消息身份复制当前版本的一条，不能复制整组或原文', async () => {
      const f = fixture();
      await f.controller.copy(messageRequest, f.surface);
      assert.deepEqual(f.writes, [texts[1]]);
      assert.deepEqual(f.copied, [{ request: messageRequest, text: texts[1] }]);
      assert.equal(f.hidden(), 0);
    });
    await t.test('恢复后从实际完成turn核request，不要求瞬时result副本', async () => {
      const f = fixture(true);
      await f.controller.copy(messageRequest, f.surface);
      assert.deepEqual(f.writes, [texts[1]]);
      assert.deepEqual(f.copied, [{ request: messageRequest, text: texts[1] }]);
    });
    for (const terminal of ['deleted', 'missing']) await t.test(`旧SID${terminal}记录不阻断新SID当前展示的消息版本`, async () => {
      const f = fixture(true);
      f.state.sessionDeletion = terminal;
      f.state.confirmedSessionDeletion = { sessionId: firstId, contactId, scopeRevision: 1,
        connectionGeneration: 1, revision: 10 };
      await f.controller.copy(messageRequest, f.surface);
      assert.deepEqual(f.writes, [texts[1]]);
      f.state.confirmedSessionDeletion.sessionId = sessionId;
      await assert.rejects(f.controller.copy(messageRequest, f.surface));
      assert.deepEqual(f.writes, [texts[1]]);
    });
    for (const selectionState of [undefined, { phase: 'ready', selection: null },
      { phase: 'ready', selection: { sessionId, candidateId, versionId: candidateId } }]) {
      await t.test('无需明确选中即可复制当前展示的保存版本', async () => {
        const f = fixture(true);
        f.state.explicitCandidateSelection = selectionState;
        await f.controller.copy(messageRequest, f.surface);
        assert.deepEqual(f.writes, [texts[1]]);
      });
    }
    await t.test('未保存草稿不能借旧版本身份复制保存前的正文', async () => {
      const f = fixture(true);
      f.state.candidateDrafts = [{ candidateId, versionId,
        messages: [{ messageId: firstId, text: '尚未保存的改动' }, { messageId: secondId, text: texts[1] }],
        requirements: '不增加安排承诺。' }];
      await assert.rejects(f.controller.copy(messageRequest, f.surface));
      assert.deepEqual(f.writes, []);
    });
    await t.test('草稿与保存版本一致时正常复制', async () => {
      const f = fixture(true);
      const version = f.state.candidateVersions.items[0].history.versions[1];
      f.state.candidateDrafts = [{ candidateId, versionId, messages: structuredClone(version.messages),
        requirements: version.requirements }];
      await f.controller.copy(messageRequest, f.surface);
      assert.deepEqual(f.writes, [texts[1]]);
    });
    const unavailable = [
      ['显示其他版本不能复制旧请求', (f) => { f.state.candidateVersions.items[0].displayVersionId = candidateId; }],
      ['版本读取失败', (f) => { f.state.candidateVersions.phase = 'failed'; }],
      ['该候选版本保存中', (f) => { f.state.candidateVersions.items[0].phase = 'saving'; }],
      ['已选会话不同', (f) => { f.state.savedSession.sessionId = firstId; }],
      ['确切会话删除已确认', (f) => { f.state.sessionDeletion = 'deleted'; }],
      ['来源尚未核验', (f) => { f.state.sourceAvailability = 'checking'; }],
      ['当前scope已变化', (f) => { f.contact.scopeRevision = 2; }],
      ['当前联系人已变化', (f) => { f.contact.selectedContactId = firstId; }],
      ['请求不属于该完成轮', (f) => { f.state.savedSession.turns[0].reply.replyRequestId = firstId; }],
      ['恢复轮尚未完成', (f) => { f.state.savedSession.turns[0].state = 'running'; }],
      ['恢复历史不可读', (f) => { f.state.savedSession.phase = 'failed'; }],
    ];
    for (const [name, invalidate] of unavailable) await t.test(name, async () => {
      const f = fixture(true); invalidate(f);
      await assert.rejects(f.controller.copy(messageRequest, f.surface));
      assert.deepEqual(f.writes, []); assert.deepEqual(f.copied, []); assert.equal(f.hidden(), 0);
    });
    await t.test('未知组内消息不退回整组或别的候选', async () => {
      const f = fixture();
      await assert.rejects(f.controller.copy({ ...messageRequest, messageId: turnId }, f.surface));
      assert.deepEqual(f.writes, []); assert.deepEqual(f.copied, []);
    });
    for (const [name, invalidate] of [
      ['写入期间连接换代', (f) => { f.connection.generation = 2; }],
      ['写入期间展示版本变化', (f) => { f.state.candidateVersions.items[0].displayVersionId = candidateId; }],
      ['写入期间开始编辑', (f) => { f.state.candidateDrafts = [{ candidateId, versionId, messages: [], requirements: '' }]; }],
      ['写入期间来源失效', (f) => { f.state.sourceAvailability = 'failed'; }],
    ]) await t.test(name, async () => {
      const f = fixture();
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      f.surface.writeText = async (text) => { f.writes.push(text); await barrier; };
      const pending = f.controller.copy({ ...messageRequest, hideAfterCopy: true }, f.surface);
      await assert.rejects(f.controller.copy(messageRequest, f.surface));
      invalidate(f); release();
      await assert.rejects(pending);
      assert.deepEqual(f.writes, [texts[1]]); assert.deepEqual(f.copied, []); assert.equal(f.hidden(), 0);
    });
  } finally { await rm(owned, { recursive: true, force: true }); }
});
