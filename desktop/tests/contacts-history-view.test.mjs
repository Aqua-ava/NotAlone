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
    const originalFile='00000000-0000-4000-8000-000000000011';
    const image=(id,state,fileId=null)=>({...message(id,null,'user'),messageType:'image',mediaPlaceholder:'[图片]',
      imageMedia:{state,fileId:state==='original'?fileId:null,mimeType:state==='original'?'image/gif':null}});
    const page = [message('one','合成聊天正文\\n第二行'),image('00000000-0000-4000-8000-000000000012','original',originalFile),
      image('00000000-0000-4000-8000-000000000013','thumbnail_only')];
    const noop = async () => {};
    const subscription = state => ({getState:async()=>state,onStateChanged:()=>()=>{},refresh:noop,refreshSaved:noop});
    const mediaListeners = new Set(); window.mediaCalls=[]; window.mediaReleases=[]; window.previewSequence=0;
    const media = { openHistoryImagePreview:async request=>{window.mediaCalls.push(request);return {sessionId:'00000000-0000-4000-8000-'+String(++window.previewSequence).padStart(12,'0'),
        mimeType:'image/gif',dataBase64:'R0lGODlhAQABAIAAAP8AAP///yH5BAEAAAEALAAAAAABAAEAAAICTAEAOw=='};},
      releasePreview:async sessionId=>{window.mediaReleases.push({sessionId,src:document.querySelector('.contact-chat-image')?.getAttribute('src')??null});},
      onPreviewRevoking:listener=>{mediaListeners.add(listener);return()=>mediaListeners.delete(listener);} };
    window.revokeImagePreview = id=>mediaListeners.forEach(listener=>listener(id));
    window.updateImage = (id,state)=>{const items=history.messages.items.map(item=>item.messageId===id?{...item,imageMedia:{state,
        fileId:state==='original'?originalFile:null,mimeType:state==='original'?'image/gif':null}}:item);window.publishHistory({messages:{...history.messages,items}});};
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
    window.notalone.media=media;
    const root = createRoot(document.getElementById('root'));
    function render() { root.render(<ContactsPage session={{state:selection,refreshContacts:noop}} navigate={()=>{}}/>); }
    window.selectContact = () => { selection={...selection,selectedContactId:'b',scopeRevision:2,revision:2};render(); };
    render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', outfile: 'contacts-test.js', write: false, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><style>
    * { box-sizing:border-box; } body { margin:0;padding:24px;font-family:sans-serif; }
    :root { --panel-border:#c4d3d6;--panel-radius:12px;--panel-background:#fffdf5;--panel-heading:#354d59; }
  </style><div id="root"></div>`);
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  const chat = page.getByRole('region', { name: '联系人聊天记录' });
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toBeVisible();
  const image = chat.getByRole('img', { name: '聊天图片' });
  await expect(image).toBeVisible();
  await expect(chat.getByText('仅有缩略图，原图未取得', { exact: true })).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(1);
  assert.match(await image.getAttribute('src'), /^blob:/);
  assert.equal((await page.evaluate(() => window.mediaCalls)).length, 1);
  await page.evaluate(() => window.revokeImagePreview('00000000-0000-4000-8000-000000000001'));
  await expect(image).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.mediaReleases.length)).toBe(1);
  assert.equal((await page.evaluate(() => window.mediaReleases[0])).src, null);
  await page.evaluate(() => window.updateImage('00000000-0000-4000-8000-000000000012','thumbnail_only'));
  await expect(image).toHaveCount(0);
  await expect(chat.getByText('仅有缩略图，原图未取得', { exact: true })).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.mediaReleases.length)).toBe(1);
  assert.equal((await page.evaluate(() => window.mediaReleases[0])).src, null);
  assert.equal((await page.evaluate(() => window.mediaCalls)).length, 1);
  await page.evaluate(() => window.updateImage('00000000-0000-4000-8000-000000000012','unavailable'));
  await expect(chat.getByText('图片资源不可用', { exact: true })).toBeVisible();
  await page.evaluate(() => window.updateImage('00000000-0000-4000-8000-000000000012','failed'));
  await expect(chat.getByText('图片暂不可用', { exact: true })).toBeVisible();
  await page.evaluate(() => window.updateImage('00000000-0000-4000-8000-000000000012','cleared'));
  await expect(chat.getByText('[图片已清除]', { exact: true })).toBeVisible();
  await page.evaluate(() => window.updateImage('00000000-0000-4000-8000-000000000012','pending'));
  await expect(chat.getByText('图片加载中', { exact: true })).toBeVisible();
  await page.evaluate(() => window.updateImage('00000000-0000-4000-8000-000000000012','original'));
  await expect(image).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.mediaCalls.length)).toBe(2);
  await chat.locator('.contact-chat-order > summary').click();
  await expect(chat.getByText('按消息时间展示；同一时间或时间未知的消息先后未核验。')).toBeVisible();
  await expect(page.locator('.contact-history-status')).toHaveCount(0);
  const options = chat.getByLabel('聊天选项', { exact: true });
  await options.click();
  const settingsButton = chat.getByRole('button', { name: '资料管理', exact: true });
  const settings = chat.getByRole('region', { name: '当前联系人设置', includeHidden: true });
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(settings).toBeHidden();
  await expect(page.getByRole('list', { name: '联系人列表' }).getByText('资料管理')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: '刷新记录' })).toBeVisible();
  await settingsButton.click();
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', { name: '清空聊天', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '重新同步历史', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: '查看关系资料', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '清空聊天', exact: true }).click();
  await expect(settings.getByRole('dialog', { name: '确认清空聊天' })).toBeVisible();
  await settings.getByRole('button', { name: '取消', exact: true }).click();
  await settings.getByRole('button', { name: '为这位联系人打开助手', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(settingsButton).toBeFocused();
  await settingsButton.click();
  await settingsButton.click();
  await expect(settings).toBeHidden();
  const columns = await page.locator('.contacts-columns').boundingBox();
  const sidebar = await page.getByRole('list', { name: '联系人列表' }).boundingBox();
  const right = await chat.boundingBox();
  assert.ok(sidebar.width / columns.width >= 0.22 && sidebar.width / columns.width <= 0.26);
  assert.ok(right.x >= sidebar.x + sidebar.width);
  assert.ok(right.width > sidebar.width * 1.8);
  await chat.getByRole('button', { name: '加载更早记录' }).click();
  await expect(chat.getByText('更早的合成记录', { exact: true })).toBeVisible();
  assert.equal((await page.evaluate(() => window.calls)).at(-1).older, true);
  await options.click();
  await chat.getByRole('button', { name: '刷新记录' }).click();
  await expect(chat.getByText('更早的合成记录', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.failLoad = true; });
  await chat.getByRole('button', { name: '刷新记录' }).click();
  await expect(chat.getByRole('alert')).toContainText('合成读取失败');
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.failLoad = false; });
  await chat.getByRole('button', { name: '刷新记录' }).click();
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toBeVisible();
  await expect(image).toBeVisible();
  await settingsButton.click();
  await page.evaluate(() => window.selectContact());
  await options.click();
  await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(settings).toBeHidden();
  await expect(chat.getByText('合成聊天正文\n第二行', { exact: true })).toHaveCount(0);
  await expect(image).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.mediaReleases.length)).toBe(3);
  assert.equal((await page.evaluate(() => window.mediaReleases[2])).src, null);
  await expect(chat.getByRole('button', { name: '刷新记录' })).toBeDisabled();
  await page.evaluate(() => window.publishHistory({contactId:'b',scopeRevision:2,messages:{phase:'idle',items:[],nextCursor:null},error:null}));
  await expect(chat.getByText('还没有已保存的聊天记录', { exact: true })).toBeVisible();
  assert.deepEqual((await page.evaluate(() => window.calls)).at(-1), {contactId:'b',scopeRevision:2,older:false});
  await page.setViewportSize({ width: 600, height: 900 });
  await settingsButton.click();
  await expect(settings).toBeVisible();
  const narrowLeft = await page.getByRole('list', { name: '联系人列表' }).boundingBox();
  const narrowChat = await chat.boundingBox();
  assert.ok(narrowChat.y > narrowLeft.y + narrowLeft.height);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('unknown质量的可查看聊天图片打开受管预览而不显示不可用占位', async t => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { HistoryImageBubble } from './src/renderer/HistoryImageBubble';
    const selection={contactId:'00000000-0000-4000-8000-000000000021',messageId:'00000000-0000-4000-8000-000000000022',scopeRevision:4};
    const fileId='00000000-0000-4000-8000-000000000023';
    const listeners=new Set();window.mediaCalls=[];
    const media={openHistoryImagePreview:async request=>{window.mediaCalls.push(request);return {sessionId:'00000000-0000-4000-8000-000000000024',mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='};},
      releasePreview:async()=>{},onPreviewRevoking:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
    const root=createRoot(document.getElementById('root'));
    window.renderImageRole=(imageVariant='unknown',imageQuality='unknown')=>root.render(<HistoryImageBubble media={media}
      imageMedia={{state:imageQuality==='original'?'original':'available',fileId,mimeType:'image/png',imageVariant,imageQuality}} selection={selection}/>);
    window.renderImageRole();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; script-src 'unsafe-inline';"><div id="root"></div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const image = page.getByRole('img', { name: '聊天图片', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.mediaCalls.length)).toBe(1);
  assert.deepEqual(await page.evaluate(() => window.mediaCalls[0]), {
    contactId: '00000000-0000-4000-8000-000000000021', messageId: '00000000-0000-4000-8000-000000000022', scopeRevision: 4,
    fileId: '00000000-0000-4000-8000-000000000023', mimeType: 'image/png',
  });
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth)).toBe(1);
  await expect(page.getByText('图片版本未确认',{exact:true})).toBeVisible();
  await page.evaluate(()=>window.renderImageRole('main'));
  await expect(page.getByText('主图',{exact:true})).toBeVisible();
  await expect(page.getByText('图片版本未确认',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>window.renderImageRole('thumbnail','thumbnail'));
  await expect(page.getByText('缩略图',{exact:true})).toBeVisible();
  await page.evaluate(()=>window.renderImageRole('main','original'));
  await expect(page.getByText('原图',{exact:true})).toBeVisible();
});
