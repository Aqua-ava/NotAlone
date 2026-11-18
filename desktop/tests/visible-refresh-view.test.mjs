import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium, mountBundle } from './helpers/browser.mjs';

test('只读自动更新在可见时串行执行，隐藏、停用与卸载后不再请求', { timeout: 20000 }, async t => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useVisibleRefresh} from './src/renderer/use-visible-refresh';
    window.calls = 0; window.hidden = false; window.callbacks = new Map();
    Object.defineProperty(document, 'hidden', {get: () => window.hidden});
    let timer = 0;
    window.setInterval = callback => {window.callbacks.set(++timer, callback); return timer;};
    window.clearInterval = id => window.callbacks.delete(id);
    window.tick = () => {for (const callback of [...window.callbacks.values()]) callback();};
    window.visible = value => {window.hidden = !value; document.dispatchEvent(new Event('visibilitychange'));};
    function App() {
      const [enabled, setEnabled] = useState(true); window.enable = setEnabled;
      useVisibleRefresh(async () => {window.calls++; await new Promise(resolve => window.finish = resolve);}, enabled);
      return <p>{enabled ? '自动更新开启' : '自动更新暂停'}</p>;
    }
    const root = createRoot(document.getElementById('root')); window.unmount = () => root.unmount(); root.render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await mountBundle(page, bundle);
  await page.waitForFunction(() => window.callbacks.size === 1);
  assert.equal(await page.evaluate(() => window.calls), 0);
  await page.evaluate(() => {window.tick(); window.tick();});
  assert.equal(await page.evaluate(() => window.calls), 1);
  await page.evaluate(() => {window.finish();});
  await page.evaluate(() => {window.visible(false); window.tick();});
  assert.equal(await page.evaluate(() => window.calls), 1);
  await page.evaluate(() => {window.visible(true);});
  assert.equal(await page.evaluate(() => window.calls), 2);
  await page.evaluate(() => {window.finish(); window.enable(false);});
  await page.waitForFunction(() => window.callbacks.size === 0);
  await page.evaluate(() => {window.tick(); window.visible(true);});
  assert.equal(await page.evaluate(() => window.calls), 2);
  await page.evaluate(() => window.enable(true));
  await page.waitForFunction(() => window.callbacks.size === 1);
  await page.evaluate(() => {window.tick(); window.unmount(); window.finish();});
  await page.waitForFunction(() => window.callbacks.size === 0);
  await page.evaluate(() => {window.tick(); window.visible(true);});
  assert.equal(await page.evaluate(() => window.calls), 3);
});
