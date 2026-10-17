import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPreferenceBackend } from './http-support.mjs';

test('React 所用的具名 preload 操作沿真实 HTTP 管理偏好，严格拒绝额外身份与隐式保存', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ installExpressionPreferenceBridge, createExpressionPreferenceBridge, backend, contacts, selection }) => {
    const handlers = new Map(), listeners = new Map();
    const commands = { handle: (name, handler, role) => { assert.equal(role, 'helper'); handlers.set(name, handler); },
      publish: (name, state) => { for (const listener of listeners.get(name) ?? []) listener(undefined, state); } };
    installExpressionPreferenceBridge(commands, backend, contacts);
    const transport = { invoke: async (name, ...args) => handlers.get(name)(...args),
      on: (name, listener) => listeners.set(name, [...listeners.get(name) ?? [], listener]),
      removeListener: (name, listener) => listeners.set(name, listeners.get(name).filter((entry) => entry !== listener)) };
    const bridge = createExpressionPreferenceBridge(transport);
    const events = [];
    const unsubscribe = bridge.onStateChanged((state) => events.push(state));
    await bridge.refresh(selection());
    const save = { ...selection(), text: '明确保存的全局要求。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true };
    await assert.rejects(bridge.save({ ...save, ownerId: selection().contactId }));
    await assert.rejects(bridge.save({ ...save, confirmLongTerm: false }));
    assert.deepEqual((await bridge.getState()).preferences, []);
    await bridge.save(save);
    const item = (await bridge.getState()).preferences[0];
    await bridge.update({ ...save, preferenceId: item.preferenceId, expectedRevision: 1, text: '用户修改后的要求。' });
    assert.equal((await bridge.getState()).preferences[0].text, '用户修改后的要求。');
    await bridge.remove({ ...selection(), preferenceId: item.preferenceId, expectedRevision: 2 });
    assert.deepEqual((await bridge.getState()).preferences, []);
    assert.ok(events.some((state) => state.preferences.length === 1 && state.preferences[0].revision === 2));
    unsubscribe();
  }, { bridge: true });
});
