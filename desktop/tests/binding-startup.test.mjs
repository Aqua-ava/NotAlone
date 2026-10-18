import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'notalone-binding-startup-'));
const result = await build({ entryPoints: ['src/main/bindings/controller.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'controller.mjs'), result.outputFiles[0].text);
const { BindingConsentController } = await import(path.join(directory, 'controller.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

function fixture({ withBinding = false, revokeFails = false } = {}) {
  let generation, listener;
  const calls = [];
  const binding = { binding_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    conversation_locator: 'wxid_synthetic', display_name: '合成联系人', status: 'active' };
  let active = withBinding ? [binding] : [];
  const backend = {
    getConnectionGeneration: () => generation,
    onStateChanged: (callback) => { listener = callback; },
    async requestJson({ path }) {
      calls.push(path);
      if (path === '/api/sync/cli-bindings/revoke') {
        if (revokeFails) throw new Error('合成撤销失败');
        active = []; return { generation, data: { ...binding, status: 'revoked' } };
      }
      const data = path === '/api/setup/status' ? { runtime_owner_configured: true }
        : path === '/api/sync/cli-bindings' ? { bindings: active }
        : path === '/api/sync/cli-sessions' ? { sessions: [{ username: 'wxid_synthetic', display_name: '合成联系人', last_timestamp: null, bound_contact_id: null }] }
        : { sync_enabled: false };
      return { generation, data };
    },
  };
  const controller = new BindingConsentController(backend, {});
  async function connect(value) {
    generation = value; listener();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { controller, calls, connect };
}

test('启动、重连和新宿主不主动读取微信会话，仍加载已保存授权', async () => {
  for (let restart = 0; restart < 2; restart++) {
    const { controller, calls, connect } = fixture();
    await connect(1);
    await connect(undefined);
    await connect(2);
    assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
    assert.equal(controller.getState().phase, 'ready');
    assert.equal(controller.getState().syncEnabled, false);
    assert.equal(controller.getState().sessionIssue, 'not-requested');
    assert.equal(calls.filter((path) => path === '/api/sync/cli-bindings').length, 2);
  }
});

test('明确刷新才读取微信列表，重连后清除旧列表且不自动再读取', async () => {
  const { controller, calls, connect } = fixture();
  await connect(1);
  calls.length = 0;
  await controller.refresh();
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 1);
  assert.equal(controller.getState().sessions.length, 1);
  assert.equal(controller.getState().sessionIssue, null);
  await connect(undefined);
  await connect(2);
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 1);
  assert.deepEqual(controller.getState().sessions, []);
});

for (const revokeFails of [false, true]) test(`启动后直接撤销${revokeFails ? '失败' : '成功'}仍不读取微信列表`, async () => {
  const { controller, calls, connect } = fixture({ withBinding: true, revokeFails });
  await connect(1);
  const state = controller.getState();
  assert.equal(state.bindings.length, 1);
  await controller.revokeBinding({ scopeRevision: state.scopeRevision,
    contactId: state.bindings[0].contactId, bindingId: state.bindings[0].bindingId });
  assert.equal(calls.filter((path) => path === '/api/sync/cli-sessions').length, 0);
  assert.equal(controller.getState().bindings.length, revokeFails ? 1 : 0);
  assert.equal(controller.getState().sessionIssue, 'not-requested');
});
