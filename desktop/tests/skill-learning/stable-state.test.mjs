import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillLearningController, ids } from '../layered-memory/support.mjs';

test('Skill后台复验保持请求频率，相同目录与历史不重复发布，变化和故障仍发布', async () => {
  let enabled = false, failed = false, calls = 0;
  const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: ids.contact,
    scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId: ids.contact }] }) };
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    ++calls;
    if (failed) throw new Error('合成断连');
    return { generation: 1, data: request.path.endsWith('/skills') ? { skills: [] }
      : { enabled, scope_revision: 1, drafts: [], task: null, recent_outcomes: [] } };
  } };
  const controller = new SkillLearningController(backend, contacts), selection = { contactId: ids.contact, scopeRevision: 1 };
  await controller.refresh(selection);
  await controller.openHistory(selection);
  const events = [], initialRevision = controller.getState().revision;
  controller.onStateChanged(state => events.push(state));
  calls = 0;
  for (let i = 0; i < 20; i++) await controller.poll(selection);
  assert.equal(calls, 40);
  assert.equal(events.length, 0);
  assert.equal(controller.getState().revision, initialRevision);
  enabled = true;
  await controller.poll(selection);
  assert.equal(events.length, 1);
  assert.equal(events[0].enabled, true);
  failed = true;
  await controller.poll(selection);
  assert.equal(controller.getState().phase, 'failed');
  assert.equal(controller.getState().history.phase, 'failed');
  assert.ok(events.length > 1);
});
