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
    const compiled = await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { MemoryPage } from './src/renderer/MemoryPage';
      const listeners = new Set(), ownerListeners = new Set();
      window.deliverOwnerMemory = state => { for (const listener of ownerListeners) listener(state); };
      window.deliverMemory = (state) => { for (const listener of listeners) listener(state); };
      window.notalone = { memory: new Proxy({}, { get: (_, method) => method === 'onStateChanged'
        ? (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
        : method === 'onOwnerLayeredMemoryChanged' ? (listener) => { ownerListeners.add(listener); return () => ownerListeners.delete(listener); }
        : (...args) => window.memoryCommand(method, ...args) }),
        traces: { onStateChanged: () => () => {}, getState: async () => ({ revision: 0, contactId: null, scopeRevision: 0 }) } };
      createRoot(document.getElementById('root')).render(<MemoryPage session={{ state: ${JSON.stringify(f.contacts.getState())}, error: '', selectContact: async () => {} }} navigate={() => {}} />);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, write: false });
    // localhost 与实际开发页面同为可信来源，保留浏览器原生 UUID，不注入替代实现。
    await page.route('http://127.0.0.1/notalone-memory-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://127.0.0.1/notalone-memory-test');
    const unsubscribe = f.bridge.onStateChanged((state) => { void page.evaluate((next) => window.deliverMemory(next), state).catch(() => {}); });
    const unsubscribeOwner = f.bridge.onOwnerLayeredMemoryChanged(state => { void page.evaluate(next => window.deliverOwnerMemory(next), state).catch(() => {}); });
    try {
      await page.addScriptTag({ content: compiled.outputFiles[0].text });
      await run(page);
    } finally { unsubscribe(); unsubscribeOwner(); }
  } finally { signal.removeEventListener('abort', cancel); f.disconnect(); await browser.close(); }
}

// 通过精简后的公开导航进入整理资料，管理操作需要主动展开详情。
export async function selectLayeredMemory(page, owner = false) {
  await page.getByRole('navigation', { name: '记忆分类', exact: true })
    .getByRole('button', { name: owner ? '我' : '对方', exact: true }).click();
  const summary = page.locator('summary').filter({ hasText: /^整理设置与状态$/ });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}
