import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('长期偏好目录在联系人切换后丢弃迟到读取，并只显示当前联系人和全局项', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-preferences-controller-'));
  try {
    const modulePath = path.join(owned, 'controller.mjs');
    await build({ entryPoints: ['src/main/expression-preferences/controller.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { ExpressionPreferenceController } = await import(pathToFileURL(modulePath).href);
    const contactA = '11111111-1111-4111-8111-111111111111';
    const contactB = '22222222-2222-4222-8222-222222222222';
    const preference = (identifier, contact, text) => ({ preference_id: identifier, text,
      scope: { contact_id: contact, reply_mode: null }, revision: 1,
      confirmed_operation_key: '33333333-3333-4333-8333-333333333333', origin: { kind: 'manual' },
      source_ids: [], confirmed_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' });
    const global = preference('44444444-4444-4444-8444-444444444444', null, '全局少用感叹号');
    const first = preference('55555555-5555-4555-8555-555555555555', contactA, '只对甲用短句');
    const second = preference('66666666-6666-4666-8666-666666666666', contactB, '只对乙保留称呼');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let waiting = false;
    let directory = [global, first];
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      requestJson: async (options) => {
        assert.equal(options.path, `/api/expression-preferences?contact_id=${selected}`);
        if (waiting) { waiting = false; return gate; }
        return { generation: 1, data: { preferences: directory } }; } };
    let selected = contactA;
    let scopeRevision = 1;
    const contacts = { onStateChanged: () => () => {}, getState: () => ({ selectedContactId: selected,
      scopeRevision, directoryPhase: 'ready', contacts: [{ contactId: contactA }, { contactId: contactB }] }) };
    const controller = new ExpressionPreferenceController(backend, contacts);
    await controller.refresh({ contactId: selected, scopeRevision });
    assert.deepEqual(controller.getState().preferences.map((item) => item.text), ['全局少用感叹号', '只对甲用短句']);
    waiting = true;
    const pending = controller.refresh({ contactId: selected, scopeRevision });
    selected = contactB;
    scopeRevision = 2;
    controller.synchronizeScope();
    release({ generation: 1, data: { preferences: [global, first, second] } });
    await pending;
    assert.deepEqual(controller.getState().preferences, []);
    waiting = false;
    directory = [global, second];
    await controller.refresh({ contactId: selected, scopeRevision });
    assert.deepEqual(controller.getState().preferences.map((item) => item.text), ['全局少用感叹号', '只对乙保留称呼']);
    const beforeErasure = controller.getState().erasureRevision;
    directory = [];
    await controller.invalidateSource(contactB);
    assert.deepEqual(controller.getState().preferences, []);
    assert.equal(controller.getState().erasureRevision, beforeErasure + 1);
    directory = [global, first];
    await controller.refresh({ contactId: selected, scopeRevision });
    assert.equal(controller.getState().phase, 'error');
    assert.deepEqual(controller.getState().preferences, []);
  } finally { await rm(owned, { recursive: true, force: true }); }
});
