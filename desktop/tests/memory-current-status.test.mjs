import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { MemoryReadingController } from './src/main/memory/controller';
  export { CandidateMaterialGroups } from './src/renderer/SqliteCandidateReferences';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs', write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const ports = compiledModule.exports;

test('生产资料控制器保留明确核实状态和原因', async () => {
  const contactId = randomUUID(), memoryId = randomUUID(), requestId = randomUUID(), candidateId = randomUUID();
  const timing = { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false,
    current_status: 'stable', current_status_reason: '明确长期偏好，日期未知不降级。' };
  let data = { memories: [{ memory_id: memoryId, level: 'contact', contact_id: contactId, text: '合成偏好：不喜欢甜食。',
    category: 'preference', topic: 'other', source_ids: [randomUUID()], confidence: 1, risk_flags: [], adoption_method: 'manual',
    status: 'active', revision: 1, supersedes_memory_id: null, source_candidate_id: null, timing, valid_at: null, invalid_at: null }] };
  const backend = { getConnectionGeneration: () => 4, requestJson: async () => ({ generation: 4, data }) };
  const contacts = new ports.ContactSession(async () => ({ generation: 4,
    contacts: [{ contactId, displayName: '合成联系人', messageCount: 0, sourceCount: 1 }] }));
  contacts.setConnection(4); await contacts.refreshContacts();
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const controller = new ports.MemoryReadingController(backend, contacts);
  await controller.refresh({ contactId, scopeRevision: contacts.getState().scopeRevision, section: 'contact' });
  assert.equal(controller.getState().contact.items[0].timing.currentStatus, 'stable');
  assert.equal(controller.getState().contact.items[0].timing.currentStatusReason, timing.current_status_reason);
});

test('SQLite候选依据按原快照显示聊天日期，不借保存日期补造当前状态', () => {
  const text = '合成计划：明天看医生。（聊天时间：2020-06-01，约6年前）';
  const html = ports.renderToStaticMarkup(ports.createElement(ports.CandidateMaterialGroups, { items: [
    { itemNo: 1, kind: 'memory', scopeKind: 'contact', qualification: 'auto', versionNo: 1, text },
  ] }));
  assert.ok(html.includes(text));
  assert.match(html, /自动采纳记忆/);
  assert.doesNotMatch(html, /当前仍适用|已发生|保存时间|2026-10-20/);
});
