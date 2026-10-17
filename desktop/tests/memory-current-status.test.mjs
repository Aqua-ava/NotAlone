import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { MemoryReadingController } from './src/main/memory/controller';
  export { readReplyEvidence } from './src/main/reply/evidence-read';
  export { ReplyEvidence } from './src/renderer/ReplyEvidence';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, packages: 'external', jsx: 'automatic', platform: 'node', format: 'cjs', write: false });
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
const ports = compiledModule.exports;

test('生产资料控制器保留核实状态，旧回复快照只显示未知且不借当前资料补填', async () => {
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
  const { current_status, current_status_reason, ...legacy } = timing;
  data = { reply_request_id: requestId, evidence: [{ evidence_id: memoryId, kind: 'confirmed_memory', text: '合成旧快照。',
    selection_reason: '生成时参考资料。', snapshot_status: 'active', cited: true, valid_at: null, invalid_at: null, timing: legacy }] };
  const saved = await ports.readReplyEvidence(backend, contactId, requestId, new AbortController().signal);
  assert.equal(saved.items[0].timing.currentStatus, 'current_unverified');
  const scopeRevision = contacts.getState().scopeRevision;
  const state = { revision: 1, scopeRevision, contactId, replyRequestId: requestId, candidateId, phase: 'ready', items: saved.items };
  const html = ports.renderToStaticMarkup(ports.createElement(ports.ReplyEvidence, {
    evidence: { state, error: '' }, selection: { contactId, scopeRevision, replyRequestId: requestId, candidateId },
    candidate: { citationIds: [memoryId] }, number: 1, waiting: false,
  }));
  assert.match(html, /当前未核实/);
  assert.match(html, /生成时核实状态/);
});
