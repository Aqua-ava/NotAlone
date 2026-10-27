import { build } from 'esbuild';
import { chromium } from '@playwright/test';

export async function withMemoryPage(f, signal, run) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  const cancel = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new Error('React 测试已取消。');
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.exposeFunction('memoryCommand', (method, ...args) => f.bridge[method](...args));
    await page.exposeFunction('backgroundCommand', (method, ...args) => f.backgroundBridge[method](...args));
    const compiled = await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { MemoryPage } from './src/renderer/MemoryPage';
      const listeners = new Set();
      const processingListeners = new Set();
      window.deliverProcessingInvalidation = event => { for (const listener of processingListeners) listener(event); };
      const ownerListeners = new Set();
      const backgroundListeners = new Set();
      window.deliverBackgroundTasks = state => { for (const listener of backgroundListeners) listener(state); };
      window.deliverMemory = (state) => { for (const listener of listeners) listener(state); };
      window.deliverOwnerMemory = (state) => { for (const listener of ownerListeners) listener(state); };
      window.notalone = { memory: new Proxy({}, { get: (_, method) => method === 'onStateChanged'
        ? (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
        : method === 'onProcessingInvalidated'
        ? (listener) => { processingListeners.add(listener); return () => processingListeners.delete(listener); }
        : method === 'onOwnerLayeredMemoryChanged'
        ? (listener) => { ownerListeners.add(listener); return () => ownerListeners.delete(listener); }
        : (...args) => window.memoryCommand(method, ...args) }),
        backgroundTasks: new Proxy({}, { get: (_, method) => method === 'onStateChanged'
          ? (listener) => { backgroundListeners.add(listener); return () => backgroundListeners.delete(listener); }
          : (...args) => window.backgroundCommand(method, ...args) }),
        traces: { onStateChanged: () => () => {}, getState: async () => ({ revision: 0, contactId: null, scopeRevision: 0 }) } };
      const root = createRoot(document.getElementById('root'));
      let sessionState = ${JSON.stringify(f.contacts.getState())}, visible = true;
      const render = () => root.render(visible ? <MemoryPage session={{ state: sessionState, error: '', selectContact: async () => {} }} navigate={() => {}} /> : null);
      window.deliverContactSession = next => { sessionState = next; render(); };
      window.showMemory = next => { visible = next; render(); };
      window.showMemory(true);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, write: false });
    // localhost 与实际开发页面同为可信来源，保留浏览器原生 UUID，不注入替代实现。
    await page.route('http://127.0.0.1/notalone-memory-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://127.0.0.1/notalone-memory-test');
    const unsubscribe = f.bridge.onStateChanged((state) => { void page.evaluate((next) => window.deliverMemory(next), state).catch(() => {}); });
    const unsubscribeContacts = f.contacts.onStateChanged(state => { void page.evaluate(next => window.deliverContactSession(next), state).catch(() => {}); });
    const unsubscribeProcessing = f.bridge.onProcessingInvalidated(event => { void page.evaluate(next => window.deliverProcessingInvalidation(next), event).catch(() => {}); });
    const unsubscribeBackground = f.backgroundBridge.onStateChanged(state => { void page.evaluate(next => window.deliverBackgroundTasks(next), state).catch(() => {}); });
    const unsubscribeOwner = f.bridge.onOwnerLayeredMemoryChanged((state) => {
      void page.evaluate((next) => window.deliverOwnerMemory(next), state).catch(() => {});
    });
    try {
      await page.addScriptTag({ content: compiled.outputFiles[0].text });
      await run(page);
    } finally { unsubscribe(); unsubscribeOwner(); unsubscribeBackground(); unsubscribeProcessing(); unsubscribeContacts(); }
  } finally { signal.removeEventListener('abort', cancel); f.disconnect(); await browser.close(); }
}
