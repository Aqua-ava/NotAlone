import { build } from 'esbuild';
import { chromium } from '@playwright/test';

export async function withMemoryPage(f, run) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.exposeFunction('memoryCommand', (method, ...args) => f.bridge[method](...args));
    const compiled = await build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { MemoryPage } from './src/renderer/MemoryPage';
      const listeners = new Set();
      window.deliverMemory = (state) => { for (const listener of listeners) listener(state); };
      window.notalone = { memory: new Proxy({}, { get: (_, method) => method === 'onStateChanged'
        ? (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
        : (...args) => window.memoryCommand(method, ...args) }),
        traces: { onStateChanged: () => () => {}, getState: async () => ({ revision: 0, contactId: null, scopeRevision: 0 }) } };
      createRoot(document.getElementById('root')).render(<MemoryPage session={{ state: ${JSON.stringify(f.contacts.getState())}, error: '', selectContact: async () => {} }} navigate={() => {}} />);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, write: false });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: compiled.outputFiles[0].text });
    const unsubscribe = f.bridge.onStateChanged((state) => { void page.evaluate((next) => window.deliverMemory(next), state).catch(() => {}); });
    try { await run(page); } finally { unsubscribe(); }
  } finally { await browser.close(); }
}
