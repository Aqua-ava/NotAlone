import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('可见联系人使用头像，离屏不读取；范围变化、图片失败和卸载清理内存', async t => {
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ContactAvatar} from './src/renderer/ContactAvatar';import './src/renderer/contacts.css';
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    window.calls=[];window.revoked=[];window.pending=[];window.hold=false;window.bad=false;
    const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url)};
    const bridge={readAvatar:async selection=>{window.calls.push(selection);if(window.hold)await new Promise(resolve=>window.pending.push(resolve));return {mimeType:'image/png',dataBase64:window.bad?'AQID':btoa(String.fromCharCode(...bytes))}}};
    const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();
    function App(){const [scope,setScope]=useState(1),[refresh,setRefresh]=useState(0);window.nextScope=()=>setScope(s=>s+1);window.refreshAvatars=()=>setRefresh(r=>r+1);return <>
      <ContactAvatar contactId="contact-a" displayName="合成甲" scopeRevision={scope} bridge={bridge} refreshKey={refresh}/>
      <div style={{height:1600}}/>
      <ContactAvatar contactId="contact-b" displayName="合成乙" scopeRevision={scope} bridge={bridge}/>
    </>};root.render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, outdir: 'avatar-view' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 500 } });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  const first = page.locator('.contact-avatar').first();
  await expect(first.locator('img')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ contactId: 'contact-a', scopeRevision: 1 }]);
  assert.equal(await first.evaluate(element => element.getBoundingClientRect().width), 28);
  assert.equal(await first.locator('img').evaluate(element => element.naturalWidth), 1);
  const oldUrl = await first.locator('img').getAttribute('src');
  await page.evaluate(() => { window.hold = true; window.nextScope(); });
  await expect(first).toHaveText('合');
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(2);
  assert.ok((await page.evaluate(() => window.revoked)).includes(oldUrl));
  await page.evaluate(() => { window.nextScope(); });
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(3);
  await page.evaluate(() => window.pending.shift()());
  await expect(first.locator('img')).toHaveCount(0);
  await page.evaluate(() => window.pending.shift()());
  await expect(first.locator('img')).toBeVisible();
  await page.evaluate(() => { window.hold = false; window.bad = true; window.nextScope(); });
  await expect(first).toHaveText('合');
  await expect.poll(() => page.evaluate(() => window.revoked.length)).toBeGreaterThanOrEqual(3);
  const beforeRefresh = await page.evaluate(() => window.calls.length);
  await page.evaluate(() => { window.bad = false; window.refreshAvatars(); });
  await expect(first.locator('img')).toBeVisible();
  assert.equal(await page.evaluate(() => window.calls.length), beforeRefresh + 1);
  const finalUrl = await first.locator('img').getAttribute('src');
  await page.evaluate(() => window.unmount());
  assert.ok((await page.evaluate(() => window.revoked)).includes(finalUrl));
});
