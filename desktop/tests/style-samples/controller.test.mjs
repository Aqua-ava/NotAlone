import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('无法归属单个样本的复制片段不能在粘贴编辑后保存为无来源手工文字', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-style-copy-conflict-'));
  try {
    const modulePath = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/style-samples/controller.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { StyleSampleController } = await import(pathToFileURL(modulePath).href);
    const contactId = '11111111-1111-4111-8111-111111111111';
    const first = { sample_id: '22222222-2222-4222-8222-222222222222', text: '合成样本甲。',
      origin_kind: 'manual', origin_id: null, source_ids: [], saved_at: '2026-10-11T00:00:00Z', sending_status: 'unknown' };
    const second = { ...first, sample_id: '33333333-3333-4333-8333-333333333333', text: '合成样本乙。' };
    const writes = [];
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      requestJson: async (request) => {
        if (request.method === 'POST') writes.push(request.body);
        return { generation: 1, data: request.method === 'POST' ? { sample: first } : { samples: [first, second] } };
      } };
    const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: contactId,
      scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] }) };
    const replies = { onStateChanged: () => () => {}, getState: () => ({ contactId, scopeRevision: 1,
      result: null, messages: { items: [] } }) };
    const samples = new StyleSampleController(backend, contacts, replies);
    const selection = { contactId, scopeRevision: 1 };
    await samples.refresh(selection);
    const fragment = `${first.text}\n${second.text}`;
    assert.throws(() => samples.noteSavedSampleCopy({ ...selection, sampleId: first.sample_id, text: fragment }));
    samples.noteManualPaste({ ...selection, text: fragment });
    samples.updateManualText({ ...selection, text: '跨项粘贴后只留下合成短句。' });
    await assert.rejects(samples.saveManual({ ...selection, text: '跨项粘贴后只留下合成短句。' }));
    assert.equal(writes.length, 0);
    samples.updateManualText({ ...selection, text: '' });
    await samples.saveManual({ ...selection, text: '清空后主动手写的独立合成文字。' });
    assert.deepEqual(writes[0].origin, { kind: 'manual' });
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('已核实的确切会话删除只清关联未保存表达，并保留独立样本和输入', async (t) => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-style-session-erasure-'));
  try {
    const entry = path.join(owned, 'entry.ts');
    await writeFile(entry, `export { StyleSampleController } from ${JSON.stringify(path.resolve('src/main/style-samples/controller.ts'))};\n`
      + `export { BackendRequestFailure } from ${JSON.stringify(path.resolve('src/main/backend/json-client.ts'))};\n`);
    const modulePath = path.join(owned, 'controller.mjs');
    await build({ entryPoints: [entry], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { StyleSampleController, BackendRequestFailure } = await import(pathToFileURL(modulePath).href);
    const contactId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const requestId = '33333333-3333-4333-8333-333333333333';
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const sampleId = '55555555-5555-4555-8555-555555555555';
    const candidateText = '需要清除未保存副本的合成候选。';
    const saved = { sample_id: sampleId, text: '主动保存且独立保留的合成样本。', origin_kind: 'manual',
      origin_id: null, source_ids: [], saved_at: '2026-10-11T00:00:00Z', sending_status: 'unknown' };
    const selection = { contactId, scopeRevision: 1 };
    function fixture() {
      let generation = 1;
      let state = { revision: 1, contactId, scopeRevision: 1, result: { replyRequestId: requestId,
        assistantSessionId: sessionId, candidates: [{ original: { candidateId, text: candidateText }, editedText: candidateText }] },
      messages: { items: [{ messageId: '66666666-6666-4666-8666-666666666666', speaker: 'user', text: '独立原始本人消息。' }] } };
      const writes = [], reads = [], listeners = new Set();
      const backend = { getConnectionGeneration: () => generation, onStateChanged: () => () => {},
        requestJson: async (request) => {
          if (request.path.endsWith('/evidence')) {
            reads.push(request.path);
            if (backend.evidenceGate) return backend.evidenceGate;
            if (backend.evidenceStatus !== 200) throw new BackendRequestFailure('response', backend.evidenceStatus);
            return { generation, data: { reply_request_id: requestId, evidence: [] } };
          }
          if (request.method === 'POST') writes.push(request.body);
          return { generation, data: request.method === 'POST' ? { sample: saved } : { samples: [saved] } };
        }, evidenceStatus: 200, evidenceGate: undefined };
      const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: contactId,
        scopeRevision: state.scopeRevision, directoryPhase: 'ready', contacts: [{ contactId }] }) };
      const replies = { onStateChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        getState: () => state };
      const samples = new StyleSampleController(backend, contacts, replies);
      const emit = (update) => { state = { ...state, ...update, revision: state.revision + 1 }; for (const listener of listeners) listener(state); };
      const deleted = (update = {}) => emit({ result: null, confirmedSessionDeletion: {
        sessionId, contactId, scopeRevision: 1, connectionGeneration: 1, revision: state.revision + 1, ...update } });
      const copyPaste = () => {
        samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText.slice(0, 8) });
        samples.noteManualPaste({ ...selection, text: candidateText.slice(0, 8) });
        samples.updateManualText({ ...selection, text: '粘贴候选后编辑但未保存。' });
      };
      return { samples, backend, writes, reads, emit, deleted, copyPaste, get state() { return state; },
        setGeneration: (value) => { generation = value; } };
    }

    await t.test('同会话候选片段清空，旧剪贴板不能洗成manual，保存样本保持', async () => {
      const f = fixture(); await f.samples.refresh(selection); f.copyPaste();
      const before = f.samples.getState(); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, before.erasureRevision + 1);
      assert.deepEqual(f.samples.getState().samples, before.samples);
      f.samples.noteManualPaste({ ...selection, text: candidateText.slice(0, 8) });
      f.samples.updateManualText({ ...selection, text: '再次粘贴旧片段后编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '再次粘贴旧片段后编辑。' }));
      assert.equal(f.writes.length, 0);
      f.samples.updateManualText({ ...selection, text: '' });
      await f.samples.saveManual({ ...selection, text: '清空后新写的独立合成文字。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
      f.emit({}); assert.equal(f.samples.getState().erasureRevision, before.erasureRevision + 1);
    });
    await t.test('复制但未粘贴的候选不清无关手写', async () => {
      const f = fixture(); f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
      f.samples.updateManualText({ ...selection, text: '独立手写不来自候选。' }); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, 0);
      await f.samples.saveManual({ ...selection, text: '独立手写不来自候选。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
    await t.test('已失效复制指纹不误认后来粘贴的不同文字', async () => {
      const f = fixture(); f.copyPaste(); f.deleted();
      f.samples.updateManualText({ ...selection, text: '' });
      const text = '删除后从别处粘贴的独立合成新文字。';
      f.samples.noteManualPaste({ ...selection, text }); f.samples.updateManualText({ ...selection, text });
      await f.samples.saveManual({ ...selection, text });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
    await t.test('独立样本列表复制保留原来历，不变为manual', async () => {
      const f = fixture(); await f.samples.refresh(selection);
      f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text.slice(0, 8) });
      f.samples.noteManualPaste({ ...selection, text: saved.text.slice(0, 8) });
      f.samples.updateManualText({ ...selection, text: '列表样本粘贴后编辑。' }); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, 0);
      await assert.rejects(f.samples.saveManual({ ...selection, text: '列表样本粘贴后编辑。' }));
      assert.equal(f.writes.length, 0);
    });
    await t.test('原始本人消息来历不属于助手讨论删除', async () => {
      const f = fixture(); f.samples.updateManualText({ ...selection, text: '独立原始本人消息。' }); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, 0);
      await f.samples.saveManual({ ...selection, text: '独立原始本人消息。' });
      assert.equal(f.writes[0].origin.kind, 'message');
    });
    for (const [name, update] of [
      ['其他联系人', { contactId: '77777777-7777-4777-8777-777777777777' }],
      ['旧范围版本', { scopeRevision: 0 }], ['旧连接', { connectionGeneration: 0 }], ['旧发布序号', { revision: 0 }],
    ]) await t.test(`${name}回执不清当前输入`, () => {
      const f = fixture(); f.copyPaste(); f.deleted(update);
      assert.equal(f.samples.getState().erasureRevision, 0);
    });
    await t.test('普通清投影及失败状态不冒充已确认删除', () => {
      const f = fixture(); f.copyPaste(); f.emit({ result: null, phase: 'failed' });
      assert.equal(f.samples.getState().erasureRevision, 0);
    });
    await t.test('相同已知候选整文即使没有粘贴事件也清除', () => {
      const f = fixture(); f.samples.updateManualText({ ...selection, text: candidateText }); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, 1);
    });
    await t.test('混合两候选片段时删除第二来源也清除，不能只记首来源', () => {
      const f = fixture(); f.copyPaste();
      const secondSession = '88888888-8888-4888-8888-888888888888';
      const secondRequest = '99999999-9999-4999-8999-999999999999';
      const secondCandidate = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const secondText = '第二个合成候选片段。';
      f.emit({ result: { replyRequestId: secondRequest, assistantSessionId: secondSession,
        candidates: [{ original: { candidateId: secondCandidate, text: secondText }, editedText: secondText }] } });
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: secondRequest, candidateId: secondCandidate, text: secondText });
      f.samples.noteManualPaste({ ...selection, text: secondText });
      f.samples.updateManualText({ ...selection, text: '两个候选混合后继续编辑。' });
      f.deleted({ sessionId: secondSession }); assert.equal(f.samples.getState().erasureRevision, 1);
    });
    await t.test('跨会话候选沿真实依据读取失效后清除，仍可读则保留', async () => {
      for (const status of [404, 200, 503]) {
        const f = fixture(); f.copyPaste(); f.backend.evidenceStatus = status;
        f.deleted({ sessionId: '88888888-8888-4888-8888-888888888888' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(f.reads, [`/api/contacts/${contactId}/replies/${requestId}/evidence`]);
        assert.equal(f.samples.getState().erasureRevision, status === 404 ? 1 : 0);
      }
    });
    await t.test('跨会话来源复核迟到时不清新连接独立输入', async () => {
      const f = fixture(); f.copyPaste();
      let reject;
      f.backend.evidenceGate = new Promise((_resolve, no) => { reject = no; });
      f.deleted({ sessionId: '88888888-8888-4888-8888-888888888888' });
      f.setGeneration(2); f.samples.updateManualText({ ...selection, text: '' });
      f.samples.updateManualText({ ...selection, text: '新连接独立手写。' });
      reject(new BackendRequestFailure('response', 404));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.samples.getState().erasureRevision, 0);
      await f.samples.saveManual({ ...selection, text: '新连接独立手写。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
  } finally { await rm(owned, { recursive: true, force: true }); }
});
