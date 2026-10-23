import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function mount(page, contents) {
 const bundle=await build({stdin:{contents,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
}

test('范围授权文案覆盖现有及新增私聊，只在点击后授权并允许退回已关联范围',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 const listeners=new Set();window.calls=[];
 let state={revision:1,scopeRevision:4,phase:'ready',busy:null,errorCode:null,report:{enabled:false,syncScope:'selected',
  backgroundPhase:'disabled',confirmedBindingCount:2,backfill:{phase:'not_required'}}};
 const bridge={getState:async()=>state,refresh:async()=>window.calls.push('refresh'),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  setScope:async request=>{window.calls.push(request);state={...state,revision:state.revision+1,report:{...state.report,syncScope:request.mode}};for(const listener of listeners)listener(state);}};
 createRoot(document.getElementById('root')).render(<SyncControlPanel bridge={bridge}/>);
 `);
 await expect(page.getByText('同步全部微信私聊，包括以后新增的会话',{exact:true})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh']);
 await page.getByRole('button',{name:'确认同步全部微信私聊',exact:true}).click();
 await expect(page.getByText('当前范围：全部微信私聊（包括以后新增的会话）',{exact:true})).toBeVisible();
 await expect(page.getByText('总开关已关闭；范围已保存，开启后台同步后开始自动关联并读取。',{exact:true})).toBeVisible();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{scopeRevision:4,mode:'all_private',confirmed:true});
 await page.getByRole('button',{name:'改为仅同步已关联会话',exact:true}).click();
 await expect(page.getByRole('button',{name:'确认同步全部微信私聊',exact:true})).toBeVisible();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{scopeRevision:4,mode:'selected',confirmed:true});
});

test('全部私聊联系人页面说明自动纳入，仍提供单个会话排除后的恢复入口',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {BindingConsentPage,BindingPrivacyNotice,ContactSyncDetails} from './src/renderer/BindingConsentPage';
 const consent={state:{phase:'ready',busy:null,syncEnabled:true,sessions:[],bindings:[],knownBindings:[{bindingId:'synthetic-id',contactId:'synthetic-contact',displayName:'合成联系人'}]},selection:{},setSelection(){}};
 createRoot(document.getElementById('root')).render(<>
  <BindingConsentPage contacts={{state:{contacts:[]}}} consent={consent} navigate={()=>{}} onClose={()=>{}} allPrivate/>
  <ContactSyncDetails contactId="synthetic-contact" consent={consent} onConnect={()=>{}} allPrivate/>
  <BindingPrivacyNotice allPrivate/>
 </>);
 `);
 await expect(page.getByRole('heading',{name:'管理单个微信会话',exact:true})).toBeVisible();
 await expect(page.getByText('全部私聊已纳入自动同步范围，无需逐个添加。这里用于处理身份冲突，或重新开启你曾单独停止的会话。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'开启自动同步',exact:true})).toBeVisible();
 await page.getByText('读取范围与隐私说明',{exact:true}).click();
 await expect(page.getByText('你已确认同步全部微信私聊。应用会自动发现并关联现有及新增会话；已单独停止的会话不会自动重新加入。',{exact:true})).toBeVisible();
});

test('老授权在设置页明确说明历史读取范围扩大，接受后才切换状态',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 const listeners=new Set();window.calls=[];
 let state={revision:1,scopeRevision:4,phase:'ready',busy:null,errorCode:null,report:{enabled:false,syncScope:'selected',
  historyAuthorizationState:'required',historyAuthorizationVersion:null,historyAuthorizationCurrentVersion:1,
  backgroundPhase:'disabled',confirmedBindingCount:2,backfill:{phase:'not_required'}}};
 const bridge={getState:async()=>state,refresh:async()=>window.calls.push('refresh'),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  setScope:async()=>{},setHistoryAuthorization:async request=>{window.calls.push(request);state={...state,revision:state.revision+1,
   report:{...state.report,historyAuthorizationState:request.decision,historyAuthorizationVersion:1}};for(const listener of listeners)listener(state);}};
 createRoot(document.getElementById('root')).render(<SyncControlPanel bridge={bridge}/>);
 `);
 await expect(page.getByText('读取范围将扩大：此前的同步授权只读取新消息。允许后，NotAlone 会读取当前已授权微信私聊在本机现有的全部文字历史，再继续同步新消息。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'允许读取历史',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'暂不读取',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'允许读取历史',exact:true}).click();
 await expect(page.getByText('已允许读取已授权微信私聊在本机现有的全部文字历史，并继续同步新消息。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'允许读取历史',exact:true})).toHaveCount(0);
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{scopeRevision:4,decision:'accepted',confirmed:true});
});

test('拒绝历史读取保留增量说明，之后仍可明确允许',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 const listeners=new Set();window.calls=[];
 let state={revision:1,scopeRevision:4,phase:'ready',busy:null,errorCode:null,report:{enabled:true,syncScope:'all_private',
  historyAuthorizationState:'required',historyAuthorizationVersion:null,historyAuthorizationCurrentVersion:1,
  backgroundPhase:'active',confirmedBindingCount:2,backfill:{phase:'not_required'}}};
 const bridge={getState:async()=>state,refresh:async()=>window.calls.push('refresh'),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  setScope:async()=>{},setHistoryAuthorization:async request=>{window.calls.push(request);state={...state,revision:state.revision+1,
   report:{...state.report,historyAuthorizationState:request.decision,historyAuthorizationVersion:1}};for(const listener of listeners)listener(state);}};
 createRoot(document.getElementById('root')).render(<SyncControlPanel bridge={bridge}/>);
 `);
 await page.getByRole('button',{name:'暂不读取',exact:true}).click();
 await expect(page.getByText('历史读取未开启：已有授权会话继续只同步新消息。允许后，会读取它们在本机现有的全部文字历史，再继续同步新消息。',{exact:true})).toBeVisible();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{scopeRevision:4,decision:'declined',confirmed:true});
 await page.getByRole('button',{name:'允许读取历史',exact:true}).click();
 await expect(page.getByText('已允许读取已授权微信私聊在本机现有的全部文字历史，并继续同步新消息。',{exact:true})).toBeVisible();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{scopeRevision:4,decision:'accepted',confirmed:true});
});
