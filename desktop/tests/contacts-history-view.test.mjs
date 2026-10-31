import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('联系人页窄栏与聊天浏览：分页、失败、切换隔离和窄屏', async t => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ContactsPage } from './src/renderer/ContactsPage';
    const contacts = [
      {contactId:'a',displayName:'合成联系人甲',messageCount:23,sourceCount:1},
      {contactId:'b',displayName:'合成的超长联系人名称用于检查窄栏换行与聊天区域隔离',messageCount:0,sourceCount:0}
    ];
    let selection = {selectedContactId:'a',scopeRevision:1,directoryPhase:'ready',contacts,draft:'',revision:1};
    let history = {revision:0,contactId:'a',scopeRevision:1,messages:{phase:'idle',items:[],nextCursor:null},error:null};
    const listeners = new Set(); window.calls = [];
    window.publishHistory = patch => {
      history = {...history,...patch,revision:history.revision+1};
      listeners.forEach(listener => listener(history));
    };
    const message = (id,text,speaker='contact') => ({messageId:id,text,speaker,messageType:'text',
      mediaPlaceholder:null,occurredAt:'2026-01-01T12:00:00Z',quoted:null,ordering:'unknown',displayPosition:'1'});
    const page = [message('one','合成聊天正文\\n第二行'),{...message('two',null,'user'),messageType:'image',mediaPlaceholder:'[图片]'}];
    const noop = async () => {};
    const subscription = state => ({getState:async()=>state,onStateChanged:()=>()=>{},refresh:noop,refreshSaved:noop});
    window.notalone = {
      contactHistory: {getState:async()=>history,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
        load:async request=>{
          window.calls.push(request);
          window.publishHistory({messages:{...history.messages,phase:'loading'},error:null});
          await Promise.resolve();
          if(window.failLoad) {window.publishHistory({messages:{phase:'failed',items:[],nextCursor:null},error:'合成读取失败，请重试。'});return;}
          const items = request.contactId === 'b' ? [] : request.older ? [...page,message('older','更早的合成记录')] : page;
          window.publishHistory({messages:{phase:'ready',items,nextCursor:request.older || request.contactId==='b' ? null : 'cursor'},error:null});
        }},
      bindings:subscription({revision:0,scopeRevision:1,phase:'ready',selectionOnly:true,knownBindings:[],bindings:[],sessions:[],busy:null}),
      syncControl:subscription({revision:0,scopeRevision:1,phase:'ready',errorCode:null,report:{enabled:true,bodyAvailable:true,
        historyCoverages:[{bindingId:'binding-a',contactId:'a',phase:'complete',messageCount:22,nonTextCount:1,pageCount:2}]}}),
      historyClear:subscription({revision:0,scopeRevision:1,contactId:'a',phase:'ready',clear:null,resync:null,busy:null,error:null})
    };
    const root = createRoot(document.getElementById('root'));
    function render() { root.render(<ContactsPage session={{state:selection,refreshContacts:noop}} navigate={()=>{}}/>); }
    window.selectContact = () => { selection={...selection,selectedContactId:'b',scopeRevision:2,revision:2};render(); };
    render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', outfile: 'contacts-test.js', write: false, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.setContent(`<style>
    * { box-sizing:border-box; } body { margin:0;padding:24px;font-family:sans-serif; }
    :root { --panel-border:#c4d3d6;--panel-radius:12px;--panel-background:#fffdf5;--panel-heading:#354d59; }
  </style><div id="root"></div>`);
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  const chat = page.getByRole('region', { name: '联系人聊天记录' });
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toBeVisible();
  await expect(chat.getByText('[图片]', { exact: true })).toBeVisible();
  await expect(chat.getByText('按保存位置展示，消息先后尚未核验。')).toBeVisible();
  await expect(page.locator('.contact-history-status')).toHaveCount(0);
  assert.equal(await page.getByText('同步与资料管理', { exact: true }).evaluate(el => el.parentElement.open), false);
  const columns = await page.locator('.contacts-columns').boundingBox();
  const sidebar = await page.getByRole('list', { name: '联系人同步状态' }).boundingBox();
  const right = await chat.boundingBox();
  assert.ok(sidebar.width / columns.width >= 0.29 && sidebar.width / columns.width <= 0.33);
  assert.ok(right.x >= sidebar.x + sidebar.width);
  assert.ok(right.width > sidebar.width * 1.8);
  await chat.getByRole('button', { name: '加载更早记录' }).click();
  await expect(chat.getByText('更早的合成记录', { exact: true })).toBeVisible();
  assert.equal((await page.evaluate(() => window.calls)).at(-1).older, true);
  await chat.getByRole('button', { name: '刷新记录' }).click();
  await expect(chat.getByText('更早的合成记录', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.failLoad = true; });
  await chat.getByRole('button', { name: '刷新记录' }).click();
  await expect(chat.getByRole('alert')).toContainText('合成读取失败');
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.failLoad = false; });
  await chat.getByRole('button', { name: '刷新记录' }).click();
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toBeVisible();
  await page.evaluate(() => window.selectContact());
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toHaveCount(0);
  await expect(chat.getByRole('button', { name: '刷新记录' })).toBeDisabled();
  await page.evaluate(() => window.publishHistory({contactId:'b',scopeRevision:2,messages:{phase:'idle',items:[],nextCursor:null},error:null}));
  await expect(chat.getByText('还没有已保存的聊天记录', { exact: true })).toBeVisible();
  assert.deepEqual((await page.evaluate(() => window.calls)).at(-1), {contactId:'b',scopeRevision:2,older:false});
  await page.setViewportSize({ width: 600, height: 900 });
  const narrowLeft = await page.getByRole('list', { name: '联系人同步状态' }).boundingBox();
  const narrowChat = await chat.boundingBox();
  assert.ok(narrowChat.y > narrowLeft.y + narrowLeft.height);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
