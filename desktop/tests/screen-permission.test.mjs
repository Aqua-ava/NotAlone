import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(), 'notalone-screen-permission-'));
const bundle = await build({ stdin: { contents: [
  "export { ForegroundPanel } from './src/renderer/ForegroundPanel';",
  "export { initialForegroundState } from './src/shared/foreground-bridge';",
  "export { createElement } from 'react';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { ScreenPermissionController } from './src/main/screen-permission/controller';",
  "export { inspectScreenPermission } from './src/main/screen-permission/native';",
  "export { installScreenPermissionBridge } from './src/main/screen-permission/bridge';",
  "export { createScreenPermissionBridge } from './src/preload/screen-permission';",
].join('\n'), resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
await writeFile(path.join(directory, 'production.mjs'), bundle.outputFiles[0].text);
const ports = await import(path.join(directory, 'production.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

test('缺少录屏权限的小窗提供授权及重新检测入口', () => {
  const state = { ...ports.initialForegroundState, phase: 'unavailable', reason: 'screen_capture_permission_missing' };
  const permission = { state: { phase: 'missing', busy: false, revision: 1 }, request() {}, recheck() {} };
  const html = ports.renderToStaticMarkup(ports.createElement(ports.ForegroundPanel, { state, permission }));
  assert.match(html, /<button[^>]*>开启屏幕录制授权<\/button>/);
  assert.match(html, /已授权，重新检测/);
  assert.match(html, /不保存或上传/);
});

test('启动缺权限先显示用途提示，稍后不会申请；再次检查不重复提示', async () => {
  const effects = [];
  const controller = new ports.ScreenPermissionController({
    inspect: async (request) => { effects.push(request ? 'request' : 'check'); return false; },
    prompt: async () => { effects.push('prompt'); return false; },
    openSettings: async () => effects.push('settings'),
    onGranted: async () => effects.push('granted'),
  });
  await controller.startup();
  assert.deepEqual(effects, ['check', 'prompt']);
  assert.equal(controller.getState().phase, 'missing');
  await controller.startup();
  await controller.recheck();
  assert.deepEqual(effects, ['check', 'prompt', 'check']);
  controller.dispose();
});

test('用户选择授权才请求系统，未生效打开设置，重新检测成功不伪造联系人资格', async () => {
  const effects = []; let granted = false;
  const controller = new ports.ScreenPermissionController({
    inspect: async (request) => { effects.push(request ? 'request' : 'check'); return granted; },
    prompt: async () => { effects.push('prompt'); return true; },
    openSettings: async () => { effects.push('settings'); },
    onGranted: async () => { effects.push('new-observation'); },
  });
  await controller.startup();
  assert.deepEqual(effects, ['check', 'prompt', 'request', 'settings']);
  granted = true;
  await controller.recheck();
  assert.equal(controller.getState().phase, 'granted');
  assert.deepEqual(effects, ['check', 'prompt', 'request', 'settings', 'check', 'new-observation']);
  assert.equal('contactId' in controller.getState(), false);
  controller.dispose();
});

test('并发授权只运行一轮，退出拒绝晚结果和打开系统设置', async () => {
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const effects = [];
  const controller = new ports.ScreenPermissionController({
    inspect: async () => { effects.push('request'); await wait; return false; },
    prompt: async () => { effects.push('prompt'); return true; },
    openSettings: async () => { effects.push('settings'); },
    onGranted: async () => { effects.push('granted'); },
  });
  const first = controller.request();
  const second = controller.request();
  await Promise.resolve();
  assert.equal(controller.getState().busy, true);
  controller.dispose(); release();
  await Promise.all([first, second]);
  assert.deepEqual(effects, ['request']);
  await controller.request();
  assert.deepEqual(effects, ['request']);
});

test('原生权限适配只传固定参数和最小环境，严格拒绝未知信封', async () => {
  const executable = path.join(directory, 'synthetic-permission');
  const trace = path.join(directory, 'arguments.json');
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({argv:process.argv.slice(2),secret:!!process.env.NOTALONE_PERMISSION_SYNTHETIC_SECRET}));process.stdout.write('{"ok":true,"granted":false}');`, { mode: 0o700 });
  process.env.NOTALONE_PERMISSION_SYNTHETIC_SECRET = 'synthetic-only';
  const signal = new AbortController().signal;
  try {
    assert.equal(await ports.inspectScreenPermission(executable, false, signal), false);
    assert.deepEqual(JSON.parse(await readFile(trace, 'utf8')), { argv: ['--screen-capture-permission', '--json'], secret: false });
    assert.equal(await ports.inspectScreenPermission(executable, true, signal), false);
    assert.deepEqual(JSON.parse(await readFile(trace, 'utf8')).argv, ['--screen-capture-permission', '--json', '--request']);
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('{"ok":true,"granted":true,"unexpected":"rejected"}');`, { mode: 0o700 });
    assert.equal(await ports.inspectScreenPermission(executable, false, signal), undefined);
  } finally { delete process.env.NOTALONE_PERMISSION_SYNTHETIC_SECRET; }
});

test('页面具名权限桥拒绝额外参数，不接收URL、路径或授权结果声明', async () => {
  const handlers = new Map(); const listeners = new Map(); let requests = 0;
  const controller = new ports.ScreenPermissionController({ inspect: async () => { requests++; return true; },
    prompt: async () => false, openSettings: async () => {}, onGranted: async () => {} });
  ports.installScreenPermissionBridge({ handle: (name, handler) => handlers.set(name, handler),
    publish: (name, value) => listeners.get(name)?.(undefined, value) }, controller);
  const bridge = ports.createScreenPermissionBridge({ invoke: async (name, ...args) => handlers.get(name)(...args),
    on: (name, listener) => listeners.set(name, listener), removeListener: (name) => listeners.delete(name) });
  await assert.rejects(bridge.request({ granted: true }));
  await assert.rejects(async () => handlers.get('screen-permission:request')('file:///rejected'));
  assert.equal(requests, 0);
  const states = []; const unsubscribe = bridge.onStateChanged((state) => states.push(state.phase));
  await bridge.recheck(); unsubscribe();
  assert.equal(requests, 1);
  assert.equal((await bridge.getState()).phase, 'granted');
  assert.deepEqual(states, ['checking', 'granted', 'granted']);
  controller.dispose();
});
