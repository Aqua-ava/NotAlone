import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `export { installForegroundBridge } from './src/main/foreground/bridge';
  export { createForegroundBridge } from './src/preload/foreground';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { installForegroundBridge, createForegroundBridge } = module.exports;
const contactId = '10000000-0000-4000-8000-000000000001';

function fixture(t) {
  let generation = 1;
  const state = { scopeRevision: 1, selectedContactId: contactId, directoryPhase: 'ready',
    contacts: [{ contactId, displayName: '合成联系人' }] };
  const calls = [], handlers = new Map(), confirmations = [];
  const backend = { getConnectionGeneration: () => generation, onStateChanged: () => () => {},
    clearManualInput() {}, confirmManualInput: (...args) => confirmations.push(args),
    requestJson: async request => { calls.push(request); return { generation, data: { confirmed: true } }; } };
  const contacts = { getState: () => state, onStateChanged: () => () => {}, selectContact: () => state };
  const foreground = installForegroundBridge({ handle: (name, handler) => handlers.set(name, handler), publish() {} }, backend, contacts);
  t.after(() => foreground.dispose());
  return { foreground, calls, handlers, confirmations, backend, reconnect: () => { generation++; } };
}

test('前台桥只读状态，旧桌面证明确认不再注册或暴露给页面', async t => {
  const f = fixture(t);
  assert.equal(f.handlers.has('foreground:confirm'), false);
  const bridge = createForegroundBridge({ invoke: async (name, ...args) => f.handlers.get(name)(...args), on() {}, removeListener() {} });
  assert.deepEqual(Object.keys(bridge).sort(), ['getState', 'onStateChanged']);
  await assert.rejects(bridge.getState('extra'));
  assert.equal((await bridge.getState()).confirmation, 'required');
  assert.deepEqual(f.calls, []);
});

test('顶栏选择仍走独立人工输入确认，不依赖前台观察或写入桌面证明', async t => {
  const f = fixture(t), select = f.handlers.get('contacts:confirm-manual');
  await assert.rejects(Promise.resolve().then(() => select({ contactId, scopeRevision: 1, observationId: contactId })));
  assert.deepEqual(f.calls, []);
  await select({ contactId, scopeRevision: 1 });
  assert.deepEqual(f.calls, [{ method: 'POST', path: `/api/contacts/${contactId}/manual-confirmation`, body: {}, maxResponseBytes: 4096 }]);
  assert.deepEqual(f.confirmations, [[contactId, 1]]);
  assert.equal(f.foreground.getGenerationBlock(), null);
});

test('手选等待期间连接换代，旧回执不能确认新范围', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.backend.requestJson = async request => { f.calls.push(request); await gate.promise; return { generation: 1, data: { confirmed: true } }; };
  const selecting = f.handlers.get('contacts:confirm-manual')({ contactId, scopeRevision: 1 });
  f.reconnect(); gate.resolve();
  await assert.rejects(selecting);
  assert.deepEqual(f.confirmations, []);
  assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
});
