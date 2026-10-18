import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { build } from 'esbuild';

// 运行生产注册、窗口和复制桥，仅替换 Electron 原生窗口与事件。
const production = await build({ stdin: { contents: `
  export { AppWindows } from './src/main/windows';
  export * from './src/main/desktop-controls';
  export { installElectronCandidateCopy } from './src/main/candidate-copy/electron';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'synthetic-window-boundary', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'synthetic' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents:
      'export const { app, BrowserWindow, globalShortcut, dialog, ipcMain, clipboard } = globalThis.__notaloneWindowBoundary;' }));
  } }] });

async function fixture(use) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-shortcut-window-'));
  const nativeWindows = [], registered = new Map(), handlers = new Map(), events = [], errors = [], copied = [];
  const app = Object.assign(new EventEmitter(), { hidden: false, active: true, showCalls: 0,
    isActive() { return this.active; },
    isHidden() { return this.hidden; }, show() { this.showCalls += 1; this.hidden = false; },
    getPath: () => directory, getAppPath: () => directory });
  class NativeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.focused = false; this.visible = false; this.minimized = false; this.destroyed = false;
      this.pinned = options.type === 'panel' || options.alwaysOnTop; this.calls = { show: 0, inactive: 0, focus: 0, hide: 0 };
      this.webContents = { mainFrame: { url: '' }, on() {}, setWindowOpenHandler() {}, send() {},
        getURL: () => this.webContents.mainFrame.url };
      nativeWindows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    show() { this.calls.show += 1; this.visible = true; }
    showInactive() { this.calls.inactive += 1; this.visible = true; }
    focus() { this.calls.focus += 1; this.focused = true; this.emit('focus'); }
    hide() { this.calls.hide += 1; this.visible = false; this.emit('hide'); }
    setAlwaysOnTop(value) { this.pinned = value; }
    isAlwaysOnTop() { return this.pinned; }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
    static getAllWindows() { return nativeWindows.filter(window => !window.destroyed); }
  }
  globalThis.__notaloneWindowBoundary = { app, BrowserWindow: NativeWindow,
    globalShortcut: { register(key, callback) { registered.set(key, callback); return true; },
      unregister(key) { registered.delete(key); }, isRegistered: key => registered.has(key) },
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    dialog: { showErrorBox: (...args) => errors.push(args) }, clipboard: { writeText: text => copied.push(text) } };
  let shortcut;
  try {
    const bundle = path.join(directory, 'production.cjs');
    await writeFile(bundle, production.outputFiles[0].text);
    const ports = (await import(bundle)).default, controller = new ports.AppWindows({});
    let observations = 0;
    controller.setHelperObservation({ beforeShow: () => { observations += 1; return new Promise(() => {}); },
      onLifecycle: event => events.push(event) });
    shortcut = ports.installDesktopControls(controller);
    const press = async () => { registered.get(shortcut.getSettings().helperShortcut)(); await nextTurn(); };
    await use({ ports, controller, press, app, events, errors, handlers, copied, nativeWindows,
      helper: () => nativeWindows.find(window => !window.options.frame),
      manager: () => nativeWindows.find(window => window.options.frame), observations: () => observations });
  } finally {
    shortcut?.dispose(); delete globalThis.__notaloneWindowBoundary;
    await rm(directory, { recursive: true, force: true });
  }
}

test('注册快捷键只显隐同一小窗，观察不返回也不阻塞或聚焦', async () => {
  await fixture(async f => {
    await f.controller.open('manager');
    const managerCalls = { ...f.manager().calls };
    await f.press();
    assert.equal(f.observations(), 0);
    assert.equal(f.helper().isVisible(), true);
    assert.deepEqual(f.helper().calls, { show: 0, inactive: 1, focus: 0, hide: 0 });
    const helper = f.helper();
    await f.press(); await f.press();
    assert.equal(f.helper(), helper);
    assert.equal(helper.isVisible(), true);
    assert.deepEqual(f.manager().calls, managerCalls);
    assert.deepEqual(f.events, ['hidden'], '保留实际隐藏事件，不伪造获得焦点');
    assert.deepEqual(f.errors, []);
  });
});

test('macOS应用失活即使面板未发blur也解除助手暂停', { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async f => {
    await f.press();
    f.helper().focus();
    assert.deepEqual(f.events, ['focused']);
    // 系统切到其他App时面板仍可能保有key-window状态；应用失活独立于窗口blur。
    f.app.active = false; f.app.emit('did-resign-active');
    assert.deepEqual(f.events, ['focused', 'blurred']);
    f.helper().emit('blur'); f.app.emit('did-resign-active');
    assert.deepEqual(f.events, ['focused', 'blurred'], '重复失焦不得取消新观察');
    f.app.active = true; f.app.emit('did-become-active');
    assert.deepEqual(f.events, ['focused', 'blurred', 'focused']);
    f.helper().hide(); f.app.emit('did-become-active');
    assert.equal(f.events.at(-1), 'hidden');
    f.helper().destroy();
    assert.equal(f.app.listenerCount('did-resign-active'), 0);
  });
});

test('开发服务的 HTTP 页面及子 frame 不能继承本地窗口 IPC 权限', async () => {
  await fixture(async f => {
    await f.controller.open('manager');
    const sender = f.manager().webContents;
    assert.equal(f.controller.validateCaller({ sender, senderFrame: sender.mainFrame }, []), f.manager());
    sender.mainFrame.url = 'http://127.0.0.1:43123/index.html#manager';
    assert.throws(() => f.controller.validateCaller({ sender, senderFrame: sender.mainFrame }, []));
    sender.mainFrame.url = 'notalone://app/index.html#manager';
    assert.throws(() => f.controller.validateCaller({ sender, senderFrame: { url: sender.mainFrame.url } }, []));
  });
});

test('macOS整体隐藏和最小化只恢复小窗，置顶关闭且第二次快捷键可隐藏', { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async f => {
    await f.controller.open('manager'); await f.press();
    const helper = f.helper(), managerCalls = { ...f.manager().calls };
    assert.equal(helper.isAlwaysOnTop(), false);
    f.controller.setHelperPinned(true); helper.minimized = true;
    await f.press();
    assert.equal(helper.isMinimized(), false);
    assert.equal(helper.isAlwaysOnTop(), true);
    f.app.hidden = true;
    for (const window of f.nativeWindows) window.visible = false;
    await f.press();
    assert.equal(helper.isVisible(), true);
    assert.equal(f.manager().isVisible(), false);
    assert.equal(f.app.showCalls, 0);
    await f.press();
    assert.equal(helper.isVisible(), false);
    assert.equal(f.observations(), 0);
    assert.deepEqual(f.manager().calls, managerCalls);
  });
});

test('应用激活核对实际可见窗口，仅全部隐藏时恢复管理入口', async () => {
  await fixture(async f => {
    await f.controller.open('manager');
    f.ports.installWindowActivation(() => { void f.controller.open('manager'); });
    const original = { ...f.manager().calls };
    f.app.emit('activate', {}, true); f.app.emit('activate', {}, false);
    await nextTurn();
    assert.deepEqual(f.manager().calls, original);
    f.manager().hide(); await f.press();
    const hidden = { ...f.manager().calls };
    f.app.emit('activate', {}, false); await nextTurn();
    assert.deepEqual(f.manager().calls, hidden, '面板未计入事件参数时仍核对实际小窗');
    await f.press();
    f.app.emit('activate', {}, false); await nextTurn();
    assert.equal(f.manager().isVisible(), true);
    assert.equal(f.manager().calls.focus, original.focus + 1);
  });
});

test('显式打开仍观察并聚焦，复制隐藏保留当前窗口生命周期', async () => {
  await fixture(async f => {
    let observations = 0;
    f.controller.setHelperObservation({ beforeShow: async () => { observations += 1; }, onLifecycle: event => f.events.push(event) });
    await f.controller.open('helper');
    assert.equal(observations, 1);
    assert.equal(f.helper().calls.focus, 1);
    assert.deepEqual(f.events, ['focused']);
    f.ports.installElectronCandidateCopy(f.controller, { copy: async (_request, surface) => {
      await surface.writeText('合成候选。'); surface.hideWindow();
    } });
    const sender = f.helper().webContents;
    await f.handlers.get('candidate-copy:copy')({ sender, senderFrame: sender.mainFrame }, {
      contactId: '11111111-1111-4111-8111-111111111111', scopeRevision: 1,
      replyRequestId: '22222222-2222-4222-8222-222222222222',
      candidateId: '33333333-3333-4333-8333-333333333333', hideAfterCopy: true,
    });
    assert.equal(f.helper().isVisible(), false);
    assert.deepEqual(f.copied, ['合成候选。']);
    assert.deepEqual(f.events, ['focused', 'hidden']);
  });
});

test('连续快捷键不重复建窗，退出后不再显示或创建', async () => {
  await fixture(async f => {
    await Promise.all(Array.from({ length: 6 }, () => f.controller.toggleHelper()));
    assert.equal(f.nativeWindows.length, 1);
    assert.equal(f.helper().isVisible(), false);
    f.controller.prepareToQuit();
    await f.press();
    assert.equal(f.nativeWindows.length, 1);
    assert.equal(f.helper().isVisible(), false);
    assert.equal(f.events.at(-1), 'closed');
  });
});


test('开发监督器重启真实窗口入口时只预加载，主动打开才前置', async () => {
  const { superviseDevelopmentApp } = await import('../scripts/development-app.mjs');
  await fixture(async f => {
    const launches = [], children = [];
    const running = superviseDevelopmentApp(options => {
      const child = Object.assign(new EventEmitter(), { connected: true, send(_message, done) { done(); } });
      const windows = new f.ports.AppWindows({});
      launches.push({ windows, loaded: windows.open('manager', options) });
      children.push(child);
      return child;
    }, () => {});
    try {
      await launches[0].loaded;
      children[0].emit('message', { type: 'notalone-dev-ready' });
      assert.equal(f.nativeWindows[0].calls.focus, 1, '首次显式启动正常显示');
      for (let index = 0; index < 2; index++) {
        running.restart();
        children[index].emit('close', 0, null);
        await launches[index + 1].loaded;
        children[index + 1].emit('message', { type: 'notalone-dev-ready' });
        const window = f.nativeWindows[index + 1];
        assert.equal(window.webContents.getURL(), 'notalone://app/index.html#manager');
        assert.deepEqual(window.calls, { show: 0, inactive: 0, focus: 0, hide: 0 }, '源码重启不能显示、前置或抢焦点');
        assert.equal(window.isVisible(), false);
      }
      await launches.at(-1).windows.open('manager');
      assert.equal(f.nativeWindows.at(-1).calls.focus, 1, '用户主动打开仍可恢复');
    } finally {
      const stopped = running.stop();
      children.at(-1).emit('close', 0, null);
      await stopped;
    }
  });
});

test('输入小窗支持原生缩放并保留最小可用尺寸', async () => {
  await fixture(async f => {
    await f.press();
    assert.equal(f.helper().options.resizable, true);
    assert.equal(f.helper().options.minWidth, 680);
    assert.equal(f.helper().options.minHeight, 520);
  });
});
