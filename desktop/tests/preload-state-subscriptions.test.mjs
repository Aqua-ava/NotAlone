import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';

const cases = [
  ['backend', 'createBackendBridge', 'backend:state-changed', '后端操作不可用'],
  ['binding-consent', 'createBindingConsentBridge', 'bindings:state-changed', '授权操作不可用。'],
  ['contact-deletion', 'createContactDeletionBridge', 'contact-deletion:state-changed', '联系人删除操作不可用。'],
  ['contact-history', 'createContactHistoryBridge', 'contact-history:state-changed', '聊天记录暂不可用。'],
  ['contact-session', 'createContactSessionBridge', 'contacts:state-changed', '联系人操作不可用。'],
  ['foreground', 'createForegroundBridge', 'foreground:state-changed', '前台状态操作不可用。'],
  ['history-clear', 'createHistoryClearBridge', 'history-clear:state-changed', '清空操作不可用。'],
  ['media', 'createMessageMediaBridge', 'media:state-changed', '媒体操作不可用。'],
  ['screen-permission', 'createScreenPermissionBridge', 'screen-permission:state-changed', '屏幕录制授权操作不可用。'],
  ['setup', 'createSetupBridge', 'setup:state-changed', '首次配置操作不可用'],
  ['source-deletion', 'createSourceDeletionBridge', 'sources:state-changed', '来源操作不可用。'],
  ['startup', 'createStartupBridge', 'startup:state-changed', '启动诊断不可用'],
  ['sync-control', 'createSyncControlBridge', 'sync-control:state-changed', '同步操作不可用。'],
  ['usage', 'createUsageBridge', 'usage:state-changed', '用量读取不可用。'],
  ['wechat-setup', 'createWechatSetupBridge', 'wechat-setup:state-changed', '微信连接操作不可用'],
];
let currentTransport;
globalThis.__preloadStateTransport = Object.fromEntries(['invoke', 'on', 'removeListener']
  .map(name => [name, (...args) => currentTransport[name](...args)]));
const built = await build({
  stdin: { contents: cases.map(([file, name]) => `export { ${name} } from './src/preload/${file}';`).join('\n'), resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{ name: 'synthetic-preload-ipc', setup(plugin) {
    plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic' }));
    plugin.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: 'export const ipcRenderer = globalThis.__preloadStateTransport;' }));
  } }],
});
const factories = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
delete globalThis.__preloadStateTransport;

for (const [file, name, channel, message] of cases) {
  test(`${file} 具名状态订阅隐藏 IPC 事件并独立解除`, () => {
    const events = new EventEmitter(), registered = [], removed = [], received = [];
    const transport = {
      invoke: () => { throw new Error('订阅不得调用业务命令'); },
      on: (channel, listener) => { registered.push([channel, listener]); return events.on(channel, listener); },
      removeListener: (channel, listener) => { removed.push([channel, listener]); return events.removeListener(channel, listener); },
    };
    currentTransport = transport;
    const bridge = factories[name](transport);
    for (const listener of [undefined, null, 1, {}, 'listener']) {
      assert.throws(() => bridge.onStateChanged(listener), { message });
    }
    assert.equal(registered.length, 0);
    const listener = (...args) => received.push(args);
    const first = bridge.onStateChanged(listener), second = bridge.onStateChanged(listener);
    assert.deepEqual(registered.map(([channel]) => channel), [channel, channel]);
    assert.notEqual(registered[0][1], registered[1][1]);
    const snapshot = { revision: 3, synthetic: true };
    events.emit(channel, { sender: '仅主进程可见的合成事件' }, snapshot, '额外参数');
    assert.deepEqual(received, [[snapshot], [snapshot]]);
    first(); first();
    assert.deepEqual(removed, [registered[0], registered[0]]);
    assert.equal(events.listenerCount(channel), 1);
    events.emit(channel, { sender: '合成事件' }, snapshot);
    assert.deepEqual(received, [[snapshot], [snapshot], [snapshot]]);
    second();
    assert.deepEqual(removed.at(-1), registered[1]);
    assert.equal(events.listenerCount(channel), 0);
    assert.equal(Object.isFrozen(bridge), true);
    for (const key of ['subscribePageState', 'invoke', 'on', 'channel']) assert.equal(Object.hasOwn(bridge, key), false);
  });
}
