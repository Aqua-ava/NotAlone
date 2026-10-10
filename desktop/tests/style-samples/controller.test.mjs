import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
