import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { expect } from '@playwright/test';
import { launchChromium, mountBundle } from '../helpers/browser.mjs';

test('用量暂不可读时不推断本机连接阶段，仍可只读刷新恢复', { timeout: 15000 }, async t => {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const compiled = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {UsagePanel} from './src/renderer/UsagePanel';
    let state={revision:0,phase:'offline',summary:null,errorCode:null};const listeners=new Set();window.refreshes=0;
    const bridge={getState:async()=>state,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
      refresh:async()=>{window.refreshes++;if(window.recovered){state={...state,revision:state.revision+1,phase:'ready'};listeners.forEach(listener=>listener(state));}}};
    createRoot(document.getElementById('root')).render(<UsagePanel bridge={bridge}/>);
  ` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false });
  await mountBundle(page, compiled);
  await expect(page.getByRole('status')).toHaveText('当前暂时无法读取用量。');
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.refreshes), 1);
  await page.evaluate(() => { window.recovered = true; });
  await page.getByRole('button', { name: '刷新用量', exact: true }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.refreshes), 2);
});
