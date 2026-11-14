import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function mount(t, { count = 1, offscreen = false, hold = false, outcome = 'image', controlledVisibility = false } = {}) {
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ContactAvatar} from './src/renderer/ContactAvatar';import './src/renderer/contacts.css';
    const dataBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    window.calls=[];window.revoked=[];window.pending=[];window.hold=${hold};window.outcome=${JSON.stringify(outcome)};
    window.inFlight=0;window.maxInFlight=0;
    // 队列用例按已知顺序通知可见，避免原生 observer 的跨实例回调顺序影响 FIFO 断言。
    ${controlledVisibility ? `
      window.observers=new Map();
      window.IntersectionObserver=class {
        constructor(callback){this.callback=callback}
        observe(element){this.element=element;window.observers.set(element,this)}
        disconnect(){window.observers.delete(this.element)}
      };
      window.reveal=()=>{for(const observer of [...window.observers.values()])observer.callback([{isIntersecting:true}])};
    ` : ''}
    const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url)};
    const bridge={readAvatar:async selection=>{
      window.calls.push(selection);window.maxInFlight=Math.max(window.maxInFlight,++window.inFlight);
      try {
        if(window.hold)await new Promise(resolve=>window.pending.push(resolve));
        if(window.outcome==='error')throw new Error('合成读取失败');
        return window.outcome==='null'?null:{mimeType:'image/png',dataBase64:window.outcome==='bad'?'AQID':dataBase64};
      } finally {window.inFlight--}
    }};
    const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();
    function App(){
      const [scope,setScope]=useState(1),[refresh,setRefresh]=useState(0),[avatarRevision,setAvatarRevision]=useState('saved-1');
      const [contacts,setContacts]=useState(Array.from({length:${count}},(_,i)=>'contact-'+i));
      window.nextScope=()=>setScope(s=>s+1);window.refreshAvatars=()=>setRefresh(r=>r+1);window.setContacts=setContacts;window.updateAvatarRevision=setAvatarRevision;
      return <>{contacts.map(contactId=><ContactAvatar key={contactId} contactId={contactId} displayName="合成联系人" scopeRevision={scope} bridge={bridge} refreshKey={refresh} avatarRevision={avatarRevision}/>)}
        ${offscreen ? '<div style={{height:1600}}/><ContactAvatar contactId="offscreen" displayName="离屏合成联系人" scopeRevision={scope} bridge={bridge}/>' : ''}
      </>;
    };root.render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, outdir: 'avatar-view' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 500 } });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await expect(page.locator('.contact-avatar')).toHaveCount(count + Number(offscreen));
  if (controlledVisibility) {
    await expect.poll(() => page.evaluate(() => window.observers.size)).toBe(count);
    await page.evaluate(() => window.reveal());
  }
  return page;
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('同步补齐头像后按内容版本刷新，无需切换联系人或手动刷新', async t => {
  const page = await mount(t, { outcome: 'null' });
  const avatar = page.locator('.contact-avatar');
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
  await expect(avatar).toHaveText('合');
  await page.evaluate(() => { window.outcome = 'image'; window.updateAvatarRevision('saved-2'); });
  await expect(avatar.locator('img')).toBeVisible();
  assert.equal(await page.evaluate(() => window.calls.length), 2);
  const oldUrl = await avatar.locator('img').getAttribute('src');
  await page.evaluate(() => window.nextScope());
  await settle(page);
  assert.equal(await page.evaluate(() => window.calls.length), 2);
  await page.evaluate(() => window.updateAvatarRevision('saved-3'));
  await expect(avatar.locator('img')).not.toHaveAttribute('src', oldUrl);
  assert.deepEqual(await page.evaluate(() => window.revoked), [oldUrl]);
});

test('已加载头像跨选择范围保持显示，离屏不读取，显式刷新与卸载释放图片', async t => {
  const page = await mount(t, { offscreen: true });
  const first = page.locator('.contact-avatar').first();
  await expect(first.locator('img')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ contactId: 'contact-0', scopeRevision: 1 }]);
  assert.equal(await first.evaluate(element => element.getBoundingClientRect().width), 28);
  assert.equal(await first.locator('img').evaluate(element => element.naturalWidth), 1);
  const oldUrl = await first.locator('img').getAttribute('src');
  await page.evaluate(() => { window.hold = true; window.nextScope(); });
  await settle(page);
  await expect(first.locator('img')).toHaveAttribute('src', oldUrl);
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  assert.deepEqual(await page.evaluate(() => window.revoked), []);
  await page.evaluate(() => window.refreshAvatars());
  await expect(first).toHaveText('合');
  await expect.poll(() => page.evaluate(() => window.calls)).toEqual([
    { contactId: 'contact-0', scopeRevision: 1 }, { contactId: 'contact-0', scopeRevision: 2 },
  ]);
  assert.deepEqual(await page.evaluate(() => window.revoked), [oldUrl]);
  await page.evaluate(() => window.pending.shift()());
  await expect(first.locator('img')).toBeVisible();
  const finalUrl = await first.locator('img').getAttribute('src');
  assert.notEqual(finalUrl, oldUrl);
  await page.evaluate(() => window.unmount());
  assert.deepEqual(await page.evaluate(() => window.revoked), [oldUrl, finalUrl]);
});

for (const outcome of ['null', 'error', 'bad']) {
  test(`头像${outcome}后保留首字，范围变化使用最新令牌重试，图片错误与卸载不重复释放`, async t => {
    const page = await mount(t, { outcome });
    const avatar = page.locator('.contact-avatar');
    await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
    await expect(avatar).toHaveText('合');
    if (outcome === 'bad') await expect.poll(() => page.evaluate(() => window.revoked.length)).toBe(1);
    await page.evaluate(() => { window.outcome = 'image'; window.nextScope(); });
    await expect(avatar.locator('img')).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.calls), [
      { contactId: 'contact-0', scopeRevision: 1 }, { contactId: 'contact-0', scopeRevision: 2 },
    ]);
    const url = await avatar.locator('img').getAttribute('src');
    await page.evaluate(() => window.unmount());
    const revoked = await page.evaluate(() => window.revoked);
    assert.equal(revoked.at(-1), url);
    assert.equal(new Set(revoked).size, revoked.length);
  });
}

test('请求中范围变化丢弃迟到图片，并用最新范围重新读取', async t => {
  const page = await mount(t, { hold: true });
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
  await page.evaluate(() => window.nextScope());
  await settle(page);
  await page.evaluate(() => window.pending.shift()());
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(2);
  await expect(page.locator('.contact-avatar')).toHaveText('合');
  assert.equal(await page.evaluate(() => window.calls[1].scopeRevision), 2);
  await page.evaluate(() => window.pending.shift()());
  await expect(page.locator('.contact-avatar img')).toBeVisible();
});

test('六个可见本地头像有界并发读取，慢头像不会阻塞其余头像', async t => {
  const page = await mount(t, { count: 6, hold: true, controlledVisibility: true });
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(4);
  await settle(page);
  assert.equal(await page.evaluate(() => window.maxInFlight), 4);
  await page.evaluate(() => window.pending.splice(1,1)[0]());
  await expect(page.locator('.contact-avatar').nth(1).locator('img')).toBeVisible();
  await expect(page.locator('.contact-avatar').first()).toHaveText('合');
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(5);
  for (let index = 0; index < 6; index++) {
    if (index === 1) continue;
    await page.evaluate(() => window.pending.shift()());
    await expect(page.locator('.contact-avatar').nth(index).locator('img')).toBeVisible();
  }
  assert.deepEqual(await page.evaluate(() => window.calls.map(call => call.contactId)),
    Array.from({ length: 6 }, (_, index) => `contact-${index}`));
  assert.equal(await page.evaluate(() => window.maxInFlight), 4);
  const urls = await page.locator('.contact-avatar img').evaluateAll(images => images.map(image => image.src));
  await page.evaluate(() => window.unmount());
  assert.deepEqual(await page.evaluate(() => window.revoked), urls);
});

test('移除排队联系人和卸载不发出未开始的请求，迟到结果不生成图片', async t => {
  const page = await mount(t, { count: 6, hold: true, controlledVisibility: true });
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(4);
  await page.evaluate(() => window.setContacts(['contact-0', 'contact-1', 'contact-2', 'contact-3', 'contact-5']));
  await expect(page.locator('.contact-avatar')).toHaveCount(5);
  await page.evaluate(() => window.pending.shift()());
  await expect(page.locator('.contact-avatar img')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.calls.map(call => call.contactId))).toEqual(['contact-0', 'contact-1', 'contact-2', 'contact-3', 'contact-5']);
  const url = await page.locator('.contact-avatar img').getAttribute('src');
  await page.evaluate(() => window.unmount());
  assert.deepEqual(await page.evaluate(() => window.revoked), [url]);
  await page.evaluate(() => window.pending.splice(0).forEach(resolve=>resolve()));
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.revoked), [url]);
  assert.equal(await page.evaluate(() => window.calls.length), 5);
});

test('刷新取消旧排队项，新请求在轮到时使用最新范围，整体卸载清空队列', async t => {
  const page = await mount(t, { count: 6, hold: true, controlledVisibility: true });
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(4);
  await page.evaluate(() => { window.refreshAvatars(); window.nextScope(); });
  await expect.poll(() => page.evaluate(() => window.observers.size)).toBe(6);
  await page.evaluate(() => window.reveal());
  assert.equal(await page.evaluate(() => window.calls.length), 4);
  await page.evaluate(() => window.pending.shift()());
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(5);
  assert.deepEqual(await page.evaluate(() => window.calls[4]), { contactId: 'contact-0', scopeRevision: 2 });
  await expect(page.locator('.contact-avatar img')).toHaveCount(0);
  await page.evaluate(() => window.unmount());
  await page.evaluate(() => window.pending.splice(0).forEach(resolve=>resolve()));
  await settle(page);
  assert.equal(await page.evaluate(() => window.calls.length), 5);
  assert.deepEqual(await page.evaluate(() => window.revoked), []);
});
