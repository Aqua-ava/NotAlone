import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t, use) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-focus-diagnostic-'));
  const timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    assert.equal(delay, 250);
    timers.set(++timerId, callback);
    return timerId;
  });
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  const window = id => Object.assign(new EventEmitter(), { id,
    isVisible: () => id === 2, isFocused: () => id === 2, isMinimized: () => false });
  const windows = [window(1), window(2)];
  const app = Object.assign(new EventEmitter(), { isHidden: () => false, isActive: () => true });
  const BrowserWindow = { getAllWindows: () => windows, getFocusedWindow: () => windows[1] };
  try {
    const modulePath = path.join(directory, 'diagnostic.mjs');
    await build({ entryPoints: ['tests/native-focus-diagnostic.ts'], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const diagnostic = await import(modulePath);
    await use({ install: diagnostic.installNativeFocusDiagnostic, release: diagnostic.releaseNativeFocusDiagnostic,
      app, BrowserWindow, windows, tick: () => [...timers.values()].forEach(callback => callback()), timers });
  } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
}

test('实际诊断采样只记录固定窗口状态，缺项保留unknown并清理自有计时和监听', async t => {
  await fixture(t, ({ install, app, BrowserWindow, windows, tick, timers }) => {
    const probe = install({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    probe.setStage('ordinary-hide-open');
    app.emit('did-resign-active');
    windows[1].emit('blur');
    windows[1].isFocused = () => undefined;
    tick();
    const result = probe.dispose();
    assert.equal(result.samples[0].appHidden, false);
    assert.equal(result.samples[0].appActive, true);
    assert.equal(result.samples.at(-1).windows[1].focused, null);
    assert.equal(result.unknown, true);
    assert.ok(result.events.some(event => event.event === 'did-resign-active'));
    assert.ok(result.events.some(event => event.event === 'blur' && event.role === 'helper' && event.id === 2));
    assert.equal(result.disposed, true);
    assert.equal(result.cleanupComplete, true);
    assert.equal(timers.size, 0);
    assert.equal(app.eventNames().length, 0);
    assert.equal(windows.every(window => window.eventNames().length === 0), true);
    assert.doesNotMatch(JSON.stringify(result), /title|url|body|input|screen/i);
  });
});

test('采样和事件分别在固定上限饱和停采，不把缺失后段当完整覆盖', async t => {
  await fixture(t, ({ install, app, BrowserWindow, windows, tick, timers }) => {
    let probe = install({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    for (let index = 0; index < 2050; index++) tick();
    let result = probe.dispose();
    assert.equal(result.samples.length, 2048);
    assert.equal(result.saturated.samples, true);
    assert.equal(result.unknown, true);
    assert.equal(timers.size, 0);
    assert.equal(app.eventNames().length, 0);
    probe = install({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    for (let index = 0; index < 514; index++) windows[1].emit('focus');
    result = probe.dispose();
    assert.equal(result.events.length, 512);
    assert.equal(result.saturated.events, true);
    assert.equal(result.unknown, true);
    assert.equal(result.cleanupComplete, true);
    assert.equal(windows.every(window => window.eventNames().length === 0), true);
    assert.equal(timers.size, 0);
  });
});

test('异常窗口数量受限，字节饱和后JSON不超过1MiB且未知原因保留', async t => {
  await fixture(t, ({ install, app, BrowserWindow, windows, tick, timers }) => {
    windows.push(...Array.from({ length: 50 }, (_, index) => ({ id: index + 3,
      isVisible: () => false, isFocused: () => false, isMinimized: () => false })));
    const probe = install({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    for (let index = 0; index < 2050; index++) tick();
    const result = probe.dispose();
    assert.equal(result.unknown, true);
    assert.equal(result.saturated.bytes, true);
    assert.ok(result.samples.every(sample => sample.complete === false && sample.windows.length === 32));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
    assert.equal(result.cleanupComplete, true);
    assert.equal(timers.size, 0);
  });
});

test('主进程序列化执行无外层闭包，监听不移除既有产品listener', async t => {
  await fixture(t, ({ install, app, BrowserWindow, windows, tick }) => {
    const serializedInstall = new Function(`return (${install.toString()})`)();
    let productEvents = 0;
    const productListener = () => productEvents++;
    windows[1].on('focus', productListener);
    const probe = serializedInstall({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    app.emit('browser-window-focus', {}, windows[1]);
    tick();
    let result = probe.dispose();
    assert.equal(result.unknown, false);
    assert.equal(result.samples.at(-1).focusedWindowId, 2);
    assert.ok(result.events.some(event => event.event === 'browser-window-focus' && event.id === 2 && event.role === 'helper'));
    windows[1].emit('focus');
    assert.equal(productEvents, 1);
    assert.deepEqual(windows[1].listeners('focus'), [productListener]);
    const count = result.samples.length;
    tick();
    result = probe.snapshot();
    assert.equal(result.samples.length, count);
  });
});

test('移除监听持续失败时重复dispose仍未清理，恢复后才实际重试成功', async t => {
  await fixture(t, ({ install, app, BrowserWindow, windows, timers }) => {
    const probe = install({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    const remove = windows[1].removeListener;
    let failRemoval = true;
    t.mock.method(windows[1], 'removeListener', function (...args) {
      if (failRemoval) throw new Error('synthetic_remove_failure');
      return remove.apply(this, args);
    });
    assert.equal(probe.dispose().cleanupComplete, false);
    assert.ok(windows[1].eventNames().length > 0);
    assert.equal(probe.dispose().cleanupComplete, false, '没有移除的监听不能因重复dispose变成成功');
    failRemoval = false;
    const result = probe.dispose();
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.unknown, true, '曾发生清理失败的未知历史仍须保留');
    assert.equal(windows[1].eventNames().length, 0);
    assert.equal(timers.size, 0);
    assert.equal(probe.dispose().cleanupComplete, true);
  });
});

test('实际共用清理路径在未确认时保留handle，finally重试成功才释放且不抹未知', async t => {
  await fixture(t, async ({ install, release, app, BrowserWindow, windows }) => {
    const probe = install({ app, BrowserWindow }, { managerId: 1, helperId: 2 });
    const remove = windows[1].removeListener;
    let failRemoval = true;
    let released = 0;
    let attempts = 0;
    t.mock.method(windows[1], 'removeListener', function (...args) {
      if (failRemoval) throw new Error('synthetic_remove_failure');
      return remove.apply(this, args);
    });
    const cleanup = async () => { attempts++; return probe.dispose(); };
    const until = Date.now() + 10_000;
    const first = await release(cleanup, async () => { released++; }, until, 2);
    assert.equal(first.released, false, '真实orchestration不得释放未清理的handle');
    assert.equal(released, 0);
    assert.equal(attempts, 2);
    failRemoval = false;
    const final = await release(cleanup, async () => { released++; }, until, 1);
    assert.equal(final.released, true);
    assert.equal(final.unknown, true);
    assert.equal(released, 1);
    assert.equal(attempts, 3);
  });
});
