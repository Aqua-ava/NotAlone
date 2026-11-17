import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { SqliteMemoryManagementController } from './src/main/memory/sqlite-management';
  export { SqliteMemoryDocumentsPanel } from './src/renderer/SqliteMemoryDocumentsPanel';
  export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { SqliteMemoryManagementController, SqliteMemoryDocumentsPanel, createElement, renderToStaticMarkup } = module.exports;

function fixture() {
  const contactId = randomUUID(), documentId = randomUUID(), publicationId = randomUUID(), memoryId = randomUUID(), calls = [];
  const statement = { text: '可能倾向先了解细节。', kind: 'inference', section: 'insights',
    basis: '几次合成讨论都先核对具体安排。', uncertainty: '样本有限，不能推为稳定人格。', temporalStatus: 'uncertain',
    leftClaim: null, rightClaim: null, resolutionState: null, resolutionText: null,
    references: [{ memory_id: memoryId, revision: 1, level: 'contact', provenance_kind: 'source_supported', memoryText: '合成正式记忆的来源原话。' }] };
  const data = { scope: { scopeKind: 'contact', contactId }, status: 'completed',
    publication: { id: publicationId, members: [{ documentId, versionNo: '1' }] },
    documents: [{ id: documentId, versionNo: '1', scopeKind: 'contact', contactId, kind: 'profile', title: '合成长期概览', statements: [statement] }] };
  const backend = { getConnectionGeneration: () => 1, requestJson: async request => { calls.push(request); return { generation: 1, data }; } };
  const controller = new SqliteMemoryManagementController(backend, () => {}, { getState: () => ({ selectedContactId: contactId, scopeRevision: 1 }) });
  return { controller, statement, calls, input: { scope: { scopeKind: 'contact', contactId }, displayContactId: contactId, scopeRevision: 1 } };
}

test('当前SQLite长期概览读取与展示保留推断分类、依据和局限，不升级为稳定事实', async () => {
  const f = fixture(), snapshot = await f.controller.readDocuments(f.input), statement = snapshot.view.documents[0].statements[0];
  assert.equal(f.calls[0].path, `/api/memory-documents?scope_kind=contact&contact_id=${f.input.scope.contactId}`);
  assert.equal(statement.kind, 'inference'); assert.equal(statement.temporalStatus, 'uncertain');
  assert.equal(statement.basis, f.statement.basis); assert.equal(statement.uncertainty, f.statement.uncertainty);
  const html = renderToStaticMarkup(createElement(SqliteMemoryDocumentsPanel, { level: 'L3', onRetry() {},
    state: { snapshot, availability: 'available', notice: '', busy: false } }));
  for (const text of ['推断', f.statement.text, f.statement.basis, f.statement.uncertainty, '合成正式记忆的来源原话。']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /稳定事实|已确认人格/);
});

test('当前概览缺少明确分类或合法引用时拒绝，不从旧展示协议补造资格', async () => {
  for (const damage of ['kind', 'references']) {
    const f = fixture(); if (damage === 'kind') delete f.statement.kind; else f.statement.references = [];
    await assert.rejects(f.controller.readDocuments(f.input));
  }
});
