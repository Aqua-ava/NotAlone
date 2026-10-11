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
    assert.throws(() => samples.noteManualPaste({ ...selection, text: fragment }));
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
      + `export { BackendRequestFailure } from ${JSON.stringify(path.resolve('src/main/backend/json-client.ts'))};\n`
      + `export { installStyleSampleBridge } from ${JSON.stringify(path.resolve('src/main/style-samples/bridge.ts'))};\n`);
    const modulePath = path.join(owned, 'controller.mjs');
    await build({ entryPoints: [entry], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { StyleSampleController, BackendRequestFailure, installStyleSampleBridge } = await import(pathToFileURL(modulePath).href);
    const contactId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const requestId = '33333333-3333-4333-8333-333333333333';
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const sampleId = '55555555-5555-4555-8555-555555555555';
    const candidateText = '需要清除未保存副本的合成候选。';
    const saved = { sample_id: sampleId, text: '主动保存且独立保留的合成样本。', origin_kind: 'manual',
      origin_id: null, source_ids: [], saved_at: '2026-10-11T00:00:00Z', sending_status: 'unknown' };
    const selection = { contactId, scopeRevision: 1 };
    const restoredSession = { phase: 'ready', sessionId, turns: [{
      turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      inputVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', requestKey: 'synthetic-restored-turn',
      state: 'completed', input: { content: { draft: '恢复来源测试的合成输入。' } },
      reply: { replyRequestId: requestId, candidates: [{ candidateId, text: candidateText }], contextEvidenceIds: [] },
      placeholder: null,
    }] };
    function fixture({ savedSession } = {}) {
      let generation = 1;
      let state = { revision: 1, contactId, scopeRevision: 1, result: { replyRequestId: requestId,
        assistantSessionId: sessionId, candidates: [{ original: { candidateId, text: candidateText }, editedText: candidateText }] },
      messages: { items: [{ messageId: '66666666-6666-4666-8666-666666666666', speaker: 'user', text: '独立原始本人消息。' }] } };
      if (savedSession) state = { ...state, result: null, savedSession: structuredClone(savedSession) };
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
        const receipt = samples.noteManualPaste({ ...selection, text: candidateText.slice(0, 8) });
        samples.updateManualText({ ...selection, text: candidateText.slice(0, 8), pastedText: candidateText.slice(0, 8), ...receipt });
        samples.updateManualText({ ...selection, text: '粘贴候选后编辑但未保存。' });
      };
      return { samples, backend, contacts, replies, writes, reads, emit, deleted, copyPaste, get state() { return state; },
        setGeneration: (value) => { generation = value; } };
    }

    for (const sourceShape of ['current', 'history']) for (const sequence of ['clear', 'later-copy', 'delete', 'later-copy-delete']) {
      await t.test(`来源不可核验的粘贴立即拒绝，清空后独立键入可保存：${sourceShape}/${sequence}`, async () => {
        const prefix = '甲'.repeat(65_536);
        const history = structuredClone(restoredSession);
        history.turns[0].reply.candidates[0].text = prefix;
        const f = sourceShape === 'history' ? fixture({ savedSession: history }) : fixture();
        if (sourceShape === 'current') f.emit({ result: { ...f.state.result,
          candidates: [{ original: { candidateId, text: prefix }, editedText: prefix }] } });
        await f.samples.refresh(selection);
        assert.throws(() => f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId,
          candidateId, text: prefix, invalidSelection: true }));
        f.samples.updateManualText({ ...selection, text: '' });
        if (sequence.includes('later-copy')) f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text });
        if (sequence.includes('delete')) f.deleted({});
        if (sequence.includes('delete') && sourceShape === 'history') f.emit({ savedSession: { phase: 'idle', turns: [] } });
        assert.throws(() => f.samples.noteManualPaste({ ...selection, text: prefix.slice(0, 4096) }));
        f.samples.updateManualText({ ...selection, text: '被拒片段不能编辑后改为手工来源。' });
        await assert.rejects(f.samples.saveManual({ ...selection, text: '被拒片段不能编辑后改为手工来源。' }));
        assert.equal(f.writes.length, 0);
        f.samples.updateManualText({ ...selection, text: '' });
        const independent = '清空后直接键入的独立合成文字。';
        assert.throws(() => f.samples.noteManualPaste({ ...selection, text: independent }));
        await assert.rejects(f.samples.saveManual({ ...selection, text: independent }));
        assert.equal(f.writes.length, 0);
        f.samples.updateManualText({ ...selection, text: '' });
        f.samples.updateManualText({ ...selection, text: independent });
        await f.samples.saveManual({ ...selection, text: independent });
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
      });
    }

    await t.test('验源完成但未实际插入时，新键入的独立文字仍是manual', async () => {
      const f = fixture();
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
      f.samples.noteManualPaste({ ...selection, text: candidateText });
      const text = '尚未插入候选时直接键入的独立文字。';
      f.samples.updateManualText({ ...selection, text });
      await f.samples.saveManual({ ...selection, text });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });

    for (const invalidation of ['typed', 'clear', 'next-paste', 'scope', 'connection', 'delete', 'projection']) {
      await t.test(`待插入凭证经${invalidation}后失效，不能挂上旧来历`, async () => {
        const f = fixture();
        f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
        const receipt = f.samples.noteManualPaste({ ...selection, text: candidateText });
        let nextReceipt;
        if (invalidation === 'typed') f.samples.updateManualText({ ...selection, text: '新键入的独立文字。' });
        if (invalidation === 'clear') f.samples.updateManualText({ ...selection, text: '' });
        if (invalidation === 'next-paste') nextReceipt = f.samples.noteManualPaste({ ...selection, text: candidateText });
        if (invalidation === 'scope') f.emit({ scopeRevision: 2 });
        if (invalidation === 'connection') f.setGeneration(2);
        if (invalidation === 'delete') f.deleted();
        if (invalidation === 'projection') f.emit({});
        assert.throws(() => f.samples.updateManualText({ ...selection, text: candidateText, pastedText: candidateText, ...receipt }));
        assert.equal(f.writes.length, 0);
        if (nextReceipt) {
          f.samples.updateManualText({ ...selection, text: candidateText, pastedText: candidateText, ...nextReceipt });
          f.samples.updateManualText({ ...selection, text: '新凭证提交后的编辑。' });
          await f.samples.saveManual({ ...selection, text: '新凭证提交后的编辑。' });
          assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
          assert.throws(() => f.samples.updateManualText({ ...selection, text: candidateText, pastedText: candidateText, ...nextReceipt }));
        }
      });
    }
    await t.test('取消未插入的待验片段不丢失已有候选编辑的真实来历', async () => {
      const f = fixture(); f.copyPaste();
      const receipt = f.samples.noteManualPaste({ ...selection, text: candidateText.slice(0, 8) });
      f.samples.updateManualText({ ...selection, text: '已有候选编辑在待插入期间继续改写。' });
      await f.samples.saveManual({ ...selection, text: '已有候选编辑在待插入期间继续改写。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
      assert.throws(() => f.samples.updateManualText({ ...selection, text: candidateText.slice(0, 8),
        pastedText: candidateText.slice(0, 8), ...receipt }));
    });
    for (const tamper of ['fragment', 'result', 'token', 'length']) await t.test(`粘贴凭证不能配合篡改${tamper}提交`, () => {
      const f = fixture();
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
      const receipt = f.samples.noteManualPaste({ ...selection, text: candidateText });
      const update = { ...selection, text: candidateText, pastedText: candidateText, ...receipt };
      if (tamper === 'fragment') update.pastedText = '任意其他文字。';
      if (tamper === 'result') update.text = '不含实际粘贴内容。';
      if (tamper === 'token') update.pasteId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      if (tamper === 'length') update.text += '长'.repeat(4096);
      assert.throws(() => f.samples.updateManualText(update));
      assert.equal(f.writes.length, 0);
    });

    await t.test('已证来源的长粘贴可有界插入，再编辑仍保留候选来历', async () => {
      const f = fixture(); const text = '合成较长说法'.repeat(850);
      f.emit({ result: { ...f.state.result, candidates: [{ original: { candidateId, text }, editedText: text }] } });
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text });
      const receipt = f.samples.noteManualPaste({ ...selection, text });
      const insertedText = text.slice(0, 4096);
      f.samples.updateManualText({ ...selection, text: insertedText, pastedText: text, insertedText, ...receipt });
      f.samples.updateManualText({ ...selection, text: '有界插入后明确编辑的合成文字。' });
      await f.samples.saveManual({ ...selection, text: '有界插入后明确编辑的合成文字。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
    });

    for (const existingCandidate of [false, true]) await t.test(`提交回包迟到前取消插入，保留${existingCandidate ? '已有候选' : '独立手写'}来历`, async () => {
      const f = fixture();
      if (existingCandidate) f.copyPaste();
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
      const receipt = f.samples.noteManualPaste({ ...selection, text: candidateText });
      f.samples.updateManualText({ ...selection, text: candidateText, pastedText: candidateText, ...receipt });
      const text = '提交回包之前新键入的合成表达。';
      f.samples.updateManualText({ ...selection, text, cancelPasteId: receipt.pasteId });
      await f.samples.saveManual({ ...selection, text });
      assert.deepEqual(f.writes[0].origin, existingCandidate ? { kind: 'candidate', id: candidateId } : { kind: 'manual' });
    });

    await t.test('同一句已登记多个候选来历时，粘贴阶段即拒绝而非等保存', async () => {
      const f = fixture();
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
      f.emit({ result: { ...f.state.result, candidates: [
        ...f.state.result.candidates,
        { original: { candidateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', text: candidateText }, editedText: candidateText },
      ] } });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: candidateText }));
      assert.equal(f.writes.length, 0);
      await assert.rejects(f.samples.saveManual({ ...selection, text: '歧义粘贴不能编辑后失去来源。' }));
    });

    await t.test('恢复后只在已保存讨论可见的完成候选保留来历，删除后清未保存编辑', async () => {
      const f = fixture({ savedSession: restoredSession }); await f.samples.refresh(selection);
      assert.equal(f.state.result, null);
      f.copyPaste();
      await f.samples.saveManual({ ...selection, text: '恢复候选粘贴后主动保存的合成编辑。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
      f.samples.updateManualText({ ...selection, text: '恢复候选粘贴后继续编辑但未保存。' });
      const before = f.samples.getState(); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, before.erasureRevision + 1);
      assert.deepEqual(f.samples.getState().samples, before.samples);
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: candidateText.slice(0, 8) }));
      f.samples.updateManualText({ ...selection, text: '恢复候选旧剪贴板再次编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '恢复候选旧剪贴板再次编辑。' }));
      assert.equal(f.writes.length, 1);
      f.samples.updateManualText({ ...selection, text: '' });
      await f.samples.saveManual({ ...selection, text: '删除恢复讨论后独立手写。' });
      assert.deepEqual(f.writes[1].origin, { kind: 'manual' });
    });
    await t.test('恢复历史候选的已知整文在没有粘贴事件时仍按实际会话清除', () => {
      const f = fixture({ savedSession: restoredSession });
      f.samples.updateManualText({ ...selection, text: candidateText }); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, 1);
    });
    const invalidCopies = [
      ...['idle', 'loading', 'failed'].map((phase) => ({ name: `${phase}历史投影`, saved: { ...restoredSession, phase } })),
      ...['running', 'failed', 'redacted', 'unavailable'].map((state) => ({ name: `${state}历史轮次`,
        saved: { ...restoredSession, turns: [{ ...restoredSession.turns[0], state }] } })),
      { name: '混合候选与其他正文', copy: { text: `${candidateText}\n第二来源的合成正文。` } },
      { name: '没有可核实正文的空选区', copy: { text: '' }, paste: '空选区之后首次粘贴的合成文字。' },
      { name: '未知实际请求', copy: { replyRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
      { name: '未知实际候选', copy: { candidateId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } },
    ];
    for (const item of invalidCopies) await t.test(`${item.name}复制拒绝后不能通过粘贴编辑洗成manual`, async () => {
      const f = fixture({ savedSession: item.saved ?? restoredSession });
      const copy = { ...selection, replyRequestId: requestId, candidateId, text: candidateText.slice(0, 8), ...item.copy };
      assert.throws(() => f.samples.noteCandidateCopy(copy));
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: item.paste ?? copy.text }));
      f.samples.updateManualText({ ...selection, text: '来源不可确认的片段粘贴后编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '来源不可确认的片段粘贴后编辑。' }));
      assert.equal(f.writes.length, 0);
      f.samples.updateManualText({ ...selection, text: '' });
      await f.samples.saveManual({ ...selection, text: '清空后独立手写的合成文字。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
    await t.test('迟到旧scope复制不覆盖当前已核实的历史候选来历', async () => {
      const f = fixture({ savedSession: restoredSession }); f.copyPaste();
      assert.throws(() => f.samples.noteCandidateCopy({ ...selection, scopeRevision: 0,
        replyRequestId: requestId, candidateId, text: '旧范围中的无关合成文字。' }));
      await f.samples.saveManual({ ...selection, text: '当前恢复候选的独立编辑。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
      f.deleted(); assert.equal(f.samples.getState().erasureRevision, 1);
    });
    await t.test('无效复制实际粘贴被拒后，清空可直接键入不同独立文字', async () => {
      const f = fixture({ savedSession: restoredSession });
      const fragment = candidateText.slice(0, 8);
      assert.throws(() => f.samples.noteCandidateCopy({ ...selection,
        replyRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', candidateId, text: fragment }));
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: fragment }));
      f.samples.updateManualText({ ...selection, text: '未知来历复制后编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '未知来历复制后编辑。' }));
      f.samples.updateManualText({ ...selection, text: '' });
      const independent = '清空后直接键入的独立合成文字。';
      f.samples.updateManualText({ ...selection, text: independent });
      await f.samples.saveManual({ ...selection, text: independent });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
      f.samples.updateManualText({ ...selection, text: '' });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: fragment }));
      f.samples.updateManualText({ ...selection, text: '原无效片段再次编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '原无效片段再次编辑。' }));
      assert.equal(f.writes.length, 1);
    });
    for (const changedScope of [false, true]) await t.test(`${changedScope ? '切换范围' : '主动清空'}撤销尚未粘贴的未知选区通配冲突`, async () => {
      const f = fixture({ savedSession: restoredSession });
      assert.throws(() => f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: '' }));
      const currentSelection = { ...selection, scopeRevision: changedScope ? 2 : 1 };
      if (changedScope) f.emit({ scopeRevision: 2 });
      else f.samples.updateManualText({ ...selection, text: '' });
      const text = '新范围或主动清空后键入的独立合成文字。';
      f.samples.updateManualText({ ...currentSelection, text });
      await f.samples.saveManual({ ...currentSelection, text });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
    for (const changedScope of [false, true]) await t.test(`超长选区的有界前缀即使像合法候选，${changedScope ? '切换范围' : '清空'}后原剪贴板仍不能洗为manual`, async () => {
      const prefix = '甲'.repeat(65_536);
      assert.equal(prefix.length, 65_536);
      const actualSelection = `${prefix}另一来源的超长选区尾部。`;
      const history = structuredClone(restoredSession);
      history.turns[0].reply.candidates[0].text = prefix;
      const f = fixture({ savedSession: history });
      const copied = { ...selection, replyRequestId: requestId, candidateId,
        text: actualSelection.slice(0, 65_536), invalidSelection: true };
      assert.throws(() => f.samples.noteCandidateCopy(copied), /复制来历已失效/);
      const currentSelection = { ...selection, scopeRevision: changedScope ? 2 : 1 };
      if (changedScope) f.emit({ scopeRevision: 2 });
      else f.samples.updateManualText({ ...selection, text: '' });
      assert.throws(() => f.samples.noteManualPaste({ ...currentSelection, text: actualSelection.slice(0, 65_536) }));
      f.samples.updateManualText({ ...currentSelection, text: '超长原剪贴板重新粘贴后截短。' });
      await assert.rejects(f.samples.saveManual({ ...currentSelection, text: '超长原剪贴板重新粘贴后截短。' }));
      assert.equal(f.writes.length, 0);
      f.samples.updateManualText({ ...currentSelection, text: '' });
      const independent = '主动清空后键入的独立合成文字。';
      f.samples.updateManualText({ ...currentSelection, text: independent });
      await f.samples.saveManual({ ...currentSelection, text: independent });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
      f.samples.updateManualText({ ...currentSelection, text: '' });
      assert.throws(() => f.samples.noteManualPaste({ ...currentSelection, text: prefix }));
      f.samples.updateManualText({ ...currentSelection, text: '独立保存后再贴原超长选区。' });
      await assert.rejects(f.samples.saveManual({ ...currentSelection, text: '独立保存后再贴原超长选区。' }));
      assert.equal(f.writes.length, 1);
    });
    for (const sourceShape of ['current', 'history']) for (const clearFirst of [false, true]) await t.test(`${sourceShape === 'current' ? '当前' : '恢复'}合法前缀被明确拒绝后${clearFirst ? '先清空' : ''}，首次较短粘贴不能洗为manual`, async () => {
      const prefix = '甲'.repeat(65_536);
      const history = structuredClone(restoredSession);
      history.turns[0].reply.candidates[0].text = prefix;
      const f = sourceShape === 'history' ? fixture({ savedSession: history }) : fixture();
      if (sourceShape === 'current') f.emit({ result: { ...f.state.result,
        candidates: [{ original: { candidateId, text: prefix }, editedText: prefix }] } });
      assert.throws(() => f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId,
        text: prefix, invalidSelection: true }), /复制来历已失效/);
      if (clearFirst) {
        f.samples.updateManualText({ ...selection, text: '合成占位输入。' });
        f.samples.updateManualText({ ...selection, text: '' });
      }
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: prefix.slice(0, 4096) }));
      f.samples.updateManualText({ ...selection, text: '明确无效选区的短前缀编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '明确无效选区的短前缀编辑。' }));
      assert.equal(f.writes.length, 0);
      f.samples.updateManualText({ ...selection, text: '' });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: prefix.slice(0, 4096) }));
      f.samples.updateManualText({ ...selection, text: '清空重贴同一短片段仍有失效来源。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '清空重贴同一短片段仍有失效来源。' }));
      assert.equal(f.writes.length, 0);
      f.samples.updateManualText({ ...selection, text: '' });
      const independent = '清空后键入独立合成文字。';
      f.samples.updateManualText({ ...selection, text: independent });
      await f.samples.saveManual({ ...selection, text: independent });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
      f.samples.updateManualText({ ...selection, text: '' });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: prefix }));
      f.samples.updateManualText({ ...selection, text: '不同文字保存后仍保留原被拒复制摘要。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '不同文字保存后仍保留原被拒复制摘要。' }));
      assert.equal(f.writes.length, 1);
    });
    await t.test('实际具名桥接兼容普通五字段，并强制拒绝有界无效选区及非法标记', async () => {
      const f = fixture({ savedSession: restoredSession });
      const handlers = new Map();
      installStyleSampleBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} },
        f.backend, f.contacts, f.replies);
      const invoke = (channel, payload) => handlers.get(`style-samples:${channel}`)(payload);
      const copied = { ...selection, replyRequestId: requestId, candidateId, text: candidateText.slice(0, 8) };
      invoke('note-candidate-copy', copied);
      const receipt = invoke('note-manual-paste', { ...selection, text: copied.text });
      for (const fields of [
        { pasteId: receipt.pasteId }, { pastedText: copied.text }, { insertedText: copied.text },
        { cancelPasteId: 'not-a-uuid' }, { cancelPasteId: receipt.pasteId, pasteId: receipt.pasteId, pastedText: copied.text },
        { pasteId: receipt.pasteId, pastedText: copied.text, insertedText: '' },
        { pasteId: receipt.pasteId, pastedText: copied.text, extra: '不接收额外字段' },
      ]) assert.throws(() => invoke('update-manual-text', { ...selection, text: copied.text, ...fields }), /样本操作无效/);
      invoke('update-manual-text', { ...selection, text: copied.text, pastedText: copied.text, ...receipt });
      invoke('update-manual-text', { ...selection, text: '普通五字段复制后编辑。' });
      await invoke('save-manual', { ...selection, text: '普通五字段复制后编辑。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
      invoke('update-manual-text', { ...selection, text: '' });
      for (const invalidSelection of [false, undefined, 'true']) {
        assert.throws(() => invoke('note-candidate-copy', { ...copied, invalidSelection }), /样本操作无效/);
      }
      assert.throws(() => invoke('note-candidate-copy', { ...copied, invalidSelection: true, extra: '不接受额外字段' }), /样本操作无效/);
      assert.throws(() => invoke('note-candidate-copy', { ...copied, text: '甲'.repeat(65_537), invalidSelection: true }), /样本操作无效/);
      assert.throws(() => invoke('note-candidate-copy', { ...copied, invalidSelection: true }), /复制来历已失效/);
      invoke('update-manual-text', { ...selection, text: '' });
      assert.throws(() => invoke('note-manual-paste', { ...selection, text: copied.text }));
      invoke('update-manual-text', { ...selection, text: '有界无效选区再次粘贴后编辑。' });
      await assert.rejects(invoke('save-manual', { ...selection, text: '有界无效选区再次粘贴后编辑。' }));
      assert.equal(f.writes.length, 1);
    });
    const invalidOriginalCopies = [
      { name: '混合来源', text: `${candidateText.slice(0, 8)}\n另一来源的合成片段。` },
      { name: '未知实际请求', text: candidateText.slice(0, 8), replyRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { name: '有界无效混合选区', text: `${candidateText}\n${'乙'.repeat(72_009)}`.slice(0, 65_536), invalidSelection: true },
    ];
    for (const copied of invalidOriginalCopies) for (const deletedSession of [false, true]) {
      await t.test(`${copied.name}首次另贴文字${deletedSession ? '并删除实际会话' : ''}后仍保留原复制摘要`, async () => {
        const f = fixture({ savedSession: restoredSession });
        assert.throws(() => f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, ...copied }));
        const independent = '首次另贴的独立合成文字。';
        assert.throws(() => f.samples.noteManualPaste({ ...selection, text: independent }));
        f.samples.updateManualText({ ...selection, text: '首次另贴后编辑的合成文字。' });
        await assert.rejects(f.samples.saveManual({ ...selection, text: '首次另贴后编辑的合成文字。' }));
        assert.equal(f.writes.length, 0);
        if (deletedSession) f.deleted();
        f.samples.updateManualText({ ...selection, text: '' });
        assert.throws(() => f.samples.noteManualPaste({ ...selection, text: copied.text }));
        f.samples.updateManualText({ ...selection, text: '原复制片段重贴后编辑。' });
        await assert.rejects(f.samples.saveManual({ ...selection, text: '原复制片段重贴后编辑。' }));
        assert.equal(f.writes.length, 0);
        f.samples.updateManualText({ ...selection, text: '' });
        f.samples.updateManualText({ ...selection, text: independent });
        await f.samples.saveManual({ ...selection, text: independent });
        assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
        f.samples.updateManualText({ ...selection, text: '' });
        assert.throws(() => f.samples.noteManualPaste({ ...selection, text: copied.text }));
        f.samples.updateManualText({ ...selection, text: '独立保存之后再贴原片段。' });
        await assert.rejects(f.samples.saveManual({ ...selection, text: '独立保存之后再贴原片段。' }));
        assert.equal(f.writes.length, 1);
      });
    }
    await t.test('后来复制合法候选不使之前无效复制的摘要失效', async () => {
      const f = fixture({ savedSession: restoredSession });
      const invalidText = invalidOriginalCopies[0].text;
      assert.throws(() => f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: invalidText }));
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: candidateText });
      f.samples.updateManualText({ ...selection, text: '' });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: invalidText }));
      f.samples.updateManualText({ ...selection, text: '复制其他候选后重贴无效片段。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '复制其他候选后重贴无效片段。' }));
      assert.equal(f.writes.length, 0);
    });
    await t.test('合法候选片段的来源摘要在后来复制列表样本及删除会话后仍有效', async () => {
      const f = fixture({ savedSession: restoredSession }); await f.samples.refresh(selection);
      const fragment = candidateText.slice(0, 8);
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: fragment });
      f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text });
      f.deleted();
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: fragment }));
      f.samples.updateManualText({ ...selection, text: '后来复制列表后重贴已删候选片段。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '后来复制列表后重贴已删候选片段。' }));
      assert.equal(f.writes.length, 0);
    });
    await t.test('后来复制列表样本后，仍可找回未删除合法候选片段的真实来历', async () => {
      const f = fixture({ savedSession: restoredSession }); await f.samples.refresh(selection);
      const fragment = candidateText.slice(0, 8);
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: fragment });
      f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text });
      const receipt = f.samples.noteManualPaste({ ...selection, text: fragment });
      f.samples.updateManualText({ ...selection, text: fragment, pastedText: fragment, ...receipt });
      f.samples.updateManualText({ ...selection, text: '旧合法片段粘贴后继续编辑。' });
      await f.samples.saveManual({ ...selection, text: '旧合法片段粘贴后继续编辑。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'candidate', id: candidateId });
      f.deleted();
      assert.equal(f.samples.getState().erasureRevision, 1);
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: fragment }));
      f.samples.updateManualText({ ...selection, text: '删除实际来源会话后重贴旧片段。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '删除实际来源会话后重贴旧片段。' }));
      assert.equal(f.writes.length, 1);
    });
    await t.test('普通历史投影刷新和后来复制不能解除显式无效有界选区', async () => {
      const prefix = '甲'.repeat(65_536);
      const history = structuredClone(restoredSession);
      history.turns[0].reply.candidates[0].text = prefix;
      const f = fixture({ savedSession: history }); await f.samples.refresh(selection);
      assert.throws(() => f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId,
        text: prefix, invalidSelection: true }));
      f.emit({ savedSession: structuredClone(history) });
      f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: prefix }));
      f.samples.updateManualText({ ...selection, text: '刷新和复制其他项后编辑无效选区。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '刷新和复制其他项后编辑无效选区。' }));
      assert.equal(f.writes.length, 0);
    });
    for (const unavailable of ['connection', 'projection']) await t.test(`${unavailable === 'connection' ? '旧连接' : '不可读历史'}候选片段不能通过摘要回找降为manual`, async () => {
      const f = fixture({ savedSession: restoredSession }); await f.samples.refresh(selection);
      const fragment = candidateText.slice(0, 8);
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: requestId, candidateId, text: fragment });
      f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text });
      if (unavailable === 'connection') f.setGeneration(2);
      else f.emit({ savedSession: { ...restoredSession, phase: 'failed' } });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: fragment }));
      f.samples.updateManualText({ ...selection, text: '不能核实的旧片段再次编辑。' });
      await assert.rejects(f.samples.saveManual({ ...selection, text: '不能核实的旧片段再次编辑。' }));
      assert.equal(f.writes.length, 0);
      f.samples.updateManualText({ ...selection, text: '' });
      await f.samples.saveManual({ ...selection, text: '清空后独立手写的本次合成文字。' });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
    await t.test('同会话候选片段清空，旧剪贴板不能洗成manual，保存样本保持', async () => {
      const f = fixture(); await f.samples.refresh(selection); f.copyPaste();
      const before = f.samples.getState(); f.deleted();
      assert.equal(f.samples.getState().erasureRevision, before.erasureRevision + 1);
      assert.deepEqual(f.samples.getState().samples, before.samples);
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: candidateText.slice(0, 8) }));
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
    await t.test('已失效复制指纹不误认后来直接键入的不同文字', async () => {
      const f = fixture(); f.copyPaste(); f.deleted();
      f.samples.updateManualText({ ...selection, text: '' });
      const text = '删除后直接键入的独立合成新文字。';
      f.samples.updateManualText({ ...selection, text });
      await f.samples.saveManual({ ...selection, text });
      assert.deepEqual(f.writes[0].origin, { kind: 'manual' });
    });
    await t.test('独立样本列表复制保留原来历，不变为manual', async () => {
      const f = fixture(); await f.samples.refresh(selection);
      f.samples.noteSavedSampleCopy({ ...selection, sampleId, text: saved.text.slice(0, 8) });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: saved.text.slice(0, 8) }));
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
    await t.test('第二候选粘贴立即拒绝，不将未插入的来源挂到首段输入', () => {
      const f = fixture(); f.copyPaste();
      const secondSession = '88888888-8888-4888-8888-888888888888';
      const secondRequest = '99999999-9999-4999-8999-999999999999';
      const secondCandidate = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const secondText = '第二个合成候选片段。';
      f.emit({ result: { replyRequestId: secondRequest, assistantSessionId: secondSession,
        candidates: [{ original: { candidateId: secondCandidate, text: secondText }, editedText: secondText }] } });
      f.samples.noteCandidateCopy({ ...selection, replyRequestId: secondRequest, candidateId: secondCandidate, text: secondText });
      assert.throws(() => f.samples.noteManualPaste({ ...selection, text: secondText }));
      f.samples.updateManualText({ ...selection, text: '两个候选混合后继续编辑。' });
      f.deleted({ sessionId: secondSession }); assert.equal(f.samples.getState().erasureRevision, 0);
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
