import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const built = await build({ stdin: { contents: `export { installUsageBridge } from './src/main/usage/bridge'; export { createUsageBridge } from './src/preload/usage';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'synthetic-ipc', setup(plugin) {
    plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic' }));
    plugin.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: 'export const ipcMain = globalThis.__usageIpc;' }));
  } }] });
const handlers = new Map();
globalThis.__usageIpc = { handle: (channel, handler) => handlers.set(channel, handler) };
const { installUsageBridge, createUsageBridge } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
delete globalThis.__usageIpc;
test('固定管理页IPC拒绝helper、子框架和多余参数，只暴露具名读取操作', async () => {
  let reads = 0, refreshes = 0, listener;
  const published = [], manager = { role: 'manager', trusted: true }, helper = { role: 'helper', trusted: true };
  installUsageBridge({ validateCaller(event, args) {
    if (!event.trusted || args.length) throw Error('untrusted');
    return { webContents: { getURL: () => `notalone://app/index.html#${event.role}` } };
  }, publish: (...args) => published.push(args) }, { getState: () => { ++reads; return { phase: 'idle' }; },
    refresh: async () => { ++refreshes; }, onStateChanged: fn => { listener = fn; } });
  assert.deepEqual([...handlers.keys()], ['usage:get-state', 'usage:refresh']);
  for (const handler of handlers.values()) {
    assert.throws(() => handler(helper)); assert.throws(() => handler({ ...manager, trusted: false }));
    assert.throws(() => handler(manager, 'arbitrary-url'));
  }
  assert.equal(reads, 0); assert.equal(refreshes, 0);
  const channels = [], subscriptions = [];
  const preload = createUsageBridge({ invoke: async (channel, ...args) => { channels.push([channel, ...args]); return handlers.get(channel)(manager, ...args); },
    on: (...args) => subscriptions.push(args), removeListener: (...args) => subscriptions.splice(subscriptions.findIndex(row => row[1] === args[1]), 1) });
  await preload.getState(); await preload.refresh();
  assert.equal(reads, 1); assert.equal(refreshes, 1);
  await assert.rejects(preload.refresh('/other')); assert.equal(channels.length, 2);
  let changed; const unsubscribe = preload.onStateChanged(value => { changed = value; });
  subscriptions[0][1]({}, { revision: 2 }); assert.equal(changed.revision, 2); unsubscribe(); assert.equal(subscriptions.length, 0);
  listener({ revision: 3 }); assert.equal(published[0][2], 'manager');
});
