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
  assert.equal(saved.items[0].event, null);
  const scopeRevision = contacts.getState().scopeRevision;
  const state = { revision: 1, scopeRevision, contactId, replyRequestId: requestId, candidateId, phase: 'ready', items: saved.items };
  const html = ports.renderToStaticMarkup(ports.createElement(ports.ReplyEvidence, {
    evidence: { state, error: '' }, selection: { contactId, scopeRevision, replyRequestId: requestId, candidateId },
    candidate: { citationIds: [memoryId] }, number: 1, waiting: false,
  }));
  assert.match(html, /是否仍适用，尚不确定/);
  assert.match(html, /生成时适用性/);
});

test('回复冻结依据保留过去计划的来源、事件和适用期间，不以保存日期替代来源', async () => {
  const contactId = randomUUID(), requestId = randomUUID(), memoryId = randomUUID(), messageId = randomUUID();
  const event = { version: 1, stage: 'planned', stage_verified: true,
    stage_evidence: [{ message_id: messageId, char_start: 0, char_end: 6 }],
    occurrence_start: '2020-06-02T09:00:00+08:00', occurrence_end: null, occurrence_verified: true,
    occurrence_evidence: [{ message_id: messageId, char_start: 0, char_end: 2 }] };
  const data = { reply_request_id: requestId, evidence: [{ evidence_id: memoryId, kind: 'confirmed_memory',
    text: '合成计划：明天看医生。', selection_reason: '过去的计划。', snapshot_status: 'active', cited: true,
    valid_at: '2020-06-01T00:00:00+08:00', invalid_at: '2020-06-03T00:00:00+08:00', event,
    timing: { recorded_at: '2026-10-20T09:00:00+08:00', source_started_at: '2020-06-01T23:30:00-07:00',
      source_ended_at: '2020-06-01T23:30:00-07:00', source_time_complete: false,
      current_status: 'historical', current_status_reason: '来源中的计划日期已过去，未确认发生。' } }] };
  const backend = { requestJson: async () => ({ generation: 4, data }) };
  const saved = await ports.readReplyEvidence(backend, contactId, requestId, new AbortController().signal);
  assert.equal(saved.items[0].event?.stage, 'planned');
  assert.equal(saved.items[0].event.occurrenceStart, '2020-06-02T09:00:00+08:00');
  const candidateId = randomUUID();
  const html = ports.renderToStaticMarkup(ports.createElement(ports.ReplyEvidence, {
    evidence: { state: { revision: 1, scopeRevision: 1, contactId, replyRequestId: requestId, candidateId, phase: 'ready', items: saved.items }, error: '' },
    selection: { contactId, scopeRevision: 1, replyRequestId: requestId, candidateId }, candidate: { citationIds: [memoryId] }, number: 1, waiting: false,
  }));
  assert.match(html, /来源日期：2020年6月1日/);
  assert.match(html, /来源日期不完整/);
  assert.match(html, /适用期间/);
  assert.match(html, /事件阶段：计划/);
  assert.match(html, /保存时间：2026-10-20/);
  assert.doesNotMatch(html, /时间待核实|时间已核实|事件阶段：已发生/);
});
