import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('联系人聊天把引用作者与回复正文分开显示，并在切换联系人时清除旧内容', async t => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ContactChatHistory } from './src/renderer/ContactChatHistory';
    import { readContactHistoryMessages } from './src/main/contact-history/messages';
    import './src/renderer/contacts.css';
    const contacts = [
      {contactId:'a',displayName:'合成联系人甲'},
      {contactId:'b',displayName:'合成联系人乙'}
    ];
    const id='00000000-0000-4000-8000-000000000011';
    const target='00000000-0000-4000-8000-000000000012';
    const message=(messageId,speaker,text,quoted=null)=>({messageId,speaker,text,messageType:'text',
      mediaPlaceholder:null,occurredAt:'2026-11-01T01:02:03.000Z',quoted});
    const wire=(messageId,speaker,text,messageType,quoted,media_placeholder=null)=>({message_id:messageId,speaker,text,
      message_type:messageType,media_placeholder,occurred_at:'2026-11-01T01:02:03.000Z',quoted});
    const historyRows=[
      wire(id,'user','回复甲正文','text',{text:'找不到原消息但保留的引用快照',target_message_id:target,
        sender_role:'unknown',message_type:'3',state:'unresolved'}),
      wire('00000000-0000-4000-8000-000000000013','contact','回复甲的第二条正文','text',
        {text:'[引用内容不可用]',target_message_id:null,sender_role:'unknown',message_type:'34',state:'unavailable'}),
      wire('00000000-0000-4000-8000-000000000015','contact','无可用引用时仍保留的回复正文','quote',null,'引用内容解析失败'),
      wire('00000000-0000-4000-8000-000000000019','contact',null,'quote',null,'引用回复状态尚未核验'),
      wire('00000000-0000-4000-8000-000000000016','contact','未知类型下仍显示正文','text',
        {text:'未知类型对应的引用快照',target_message_id:null,sender_role:'unknown',message_type:'999999',state:'resolved'}),
      wire('00000000-0000-4000-8000-000000000017','contact','视频引用正文','text',
        {text:'视频引用快照',target_message_id:null,sender_role:'unknown',message_type:'43',state:'resolved'}),
      wire('00000000-0000-4000-8000-000000000018','contact','未细分应用引用正文','text',
        {text:'未细分应用引用快照',target_message_id:null,sender_role:'unknown',message_type:'49',state:'resolved'})
    ];
    let selection={selectedContactId:'a',scopeRevision:1,contacts};
    let history={revision:1,contactId:'a',scopeRevision:1,messages:{phase:'ready',items:[],nextCursor:null},error:null};
    const listeners=new Set();
    window.notalone={contactHistory:{getState:async()=>history,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},load:async()=>{}},
      media:{}};
    const root=createRoot(document.getElementById('root'));
    function render(){root.render(<ContactChatHistory session={{state:selection}}/>);}
    window.publishHistory=patch=>{history={...history,...patch,revision:history.revision+1};listeners.forEach(listener=>listener(history));};
    window.updateQuote=quoted=>window.publishHistory({messages:{...history.messages,items:history.messages.items.map(item=>
      item.messageId===id?{...item,quoted}:item)}});
    window.selectOtherContact=()=>{selection={selectedContactId:'b',scopeRevision:2,contacts};render();};
    window.publishOtherContact=()=>window.publishHistory({contactId:'b',scopeRevision:2,messages:{phase:'ready',items:[
      message('00000000-0000-4000-8000-000000000014','contact','回复乙正文',
        {text:'乙联系人的引用内容',targetMessageId:target,senderRole:'contact',state:'resolved'})
    ],nextCursor:null},error:null});
    async function initialize(){
      const page=await readContactHistoryMessages({requestJson:async()=>({generation:1,data:{messages:historyRows,next_cursor:null}})},
        '00000000-0000-4000-8000-000000000099',null,new AbortController().signal);
      history={...history,messages:{phase:'ready',items:page.messages,nextCursor:null}};
      render();
    }
    initialize();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: 'contact-history-quote-view-test.js', jsx: 'automatic', write: false, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<style>:root{--panel-border:#c4d3d6;--panel-radius:12px;--panel-background:#fffdf5;--panel-heading:#354d59}</style><div id="root"></div>');
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js'));
  const stylesheet = bundle.outputFiles.find(file => file.path.endsWith('.css'));
  if (stylesheet) await page.addStyleTag({ content: stylesheet.text });
  await page.addScriptTag({ content: script.text });
  const chat = page.getByRole('region', { name: '联系人聊天记录' });
  const reply = chat.locator('.contact-chat-message').filter({ has: page.getByText('回复甲正文', { exact: true }) });
  const quote = reply.getByLabel('引用内容');
  await expect(reply.locator('.contact-chat-meta')).toContainText('我');
  await expect(quote).toContainText('找不到原消息但保留的引用快照');
  await expect(quote).toContainText('引用类型：图片');
  await expect(quote).toContainText('原消息未关联');
  await expect(quote).toContainText('引用作者未知');
  assert.equal(await quote.evaluate(element => getComputedStyle(element).display), 'grid');
  assert.doesNotMatch(await quote.innerText(), /合成联系人甲/);
  await expect(reply.locator('.contact-chat-bubble > p')).toHaveText('回复甲正文');
  await expect(chat.getByText('引用回复状态尚未核验', { exact: true })).toHaveCount(1);
  assert.doesNotMatch(await reply.innerText(), /引用回复/);

  const unavailable = chat.locator('.contact-chat-message').filter({ has: page.getByText('回复甲的第二条正文', { exact: true }) }).getByLabel('引用内容');
  await expect(unavailable).toContainText('[引用内容不可用]');
  await expect(unavailable).toContainText('引用来源不可用');
  await expect(unavailable).toContainText('引用类型：语音');

  const missingQuote = chat.locator('.contact-chat-message').filter({ has: page.getByText('无可用引用时仍保留的回复正文', { exact: true }) });
  await expect(missingQuote.getByLabel('引用内容')).toContainText('[引用内容不可用]');
  await expect(missingQuote.getByLabel('引用内容')).toContainText('引用内容解析失败');
  await expect(missingQuote.locator('.contact-chat-bubble > p')).toHaveText('无可用引用时仍保留的回复正文');

  const unknownQuote = chat.locator('.contact-chat-message').filter({ has: page.getByText('未知类型下仍显示正文', { exact: true }) }).getByLabel('引用内容');
  await expect(unknownQuote).toContainText('引用类型：未知类型（999999）');
  await expect(unknownQuote).toContainText('未知类型对应的引用快照');
  const videoQuote = chat.locator('.contact-chat-message').filter({ has: page.getByText('视频引用正文', { exact: true }) }).getByLabel('引用内容');
  await expect(videoQuote).toContainText('引用类型：视频');
  const appQuote = chat.locator('.contact-chat-message').filter({ has: page.getByText('未细分应用引用正文', { exact: true }) }).getByLabel('引用内容');
  await expect(appQuote).toContainText('引用类型：其他消息（未识别，原码：49）');

  await page.evaluate(() => window.updateQuote({ text:'补齐后的本人原话', targetMessageId:'00000000-0000-4000-8000-000000000012',
    senderRole:'owner', messageType:'image', state:'resolved' }));
  await expect(quote).toContainText('补齐后的本人原话');
  await expect(quote).toContainText('引用类型：图片');
  await expect(quote).toContainText('引用·我');
  await expect(quote).not.toContainText('原消息未关联');
  await expect(reply.locator('.contact-chat-bubble > p')).toHaveText('回复甲正文');

  await page.evaluate(() => window.selectOtherContact());
  await expect(chat.getByText('补齐后的本人原话', { exact: true })).toHaveCount(0);
  await expect(chat.getByText('回复甲正文', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.publishOtherContact());
  const otherReply = chat.locator('.contact-chat-message').filter({ has: page.getByText('回复乙正文', { exact: true }) });
  await expect(otherReply).toBeVisible();
  await expect(otherReply.getByLabel('引用内容')).toContainText('乙联系人的引用内容');
  await expect(otherReply.locator('.contact-chat-quote-author')).toHaveText('引用·合成联系人乙');
  await expect(chat.getByText('补齐后的本人原话', { exact: true })).toHaveCount(0);
});
