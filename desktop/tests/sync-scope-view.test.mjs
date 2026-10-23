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

test('消息历史覆盖按联系人显示四态、当前进度和汇总，关系资料独立说明', async t => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page = await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 const historyCoverages=['not_started','syncing','complete','incomplete'].map((phase,i)=>({bindingId:'binding-'+i,contactId:'contact-'+i,phase,
 failureCode:i===3?'cli_timeout':null,messageCount:i*100,pageCount:i,nonTextCount:0}));
 let state={revision:1,scopeRevision:4,phase:'ready',busy:null,errorCode:null,report:{enabled:true,backgroundPhase:'active',confirmedBindingCount:4,
 historyCoverages,backfill:{phase:'complete'}}};
 const listeners=new Set();const bridge={getState:async()=>state,refresh:async()=>{},onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
 const root=createRoot(document.getElementById('root'));
 const render=current=>root.render(<SyncControlPanel bridge={bridge} currentContactId={current}
 contacts={historyCoverages.map((c,i)=>({contactId:c.contactId,displayName:'合成联系人'+i}))}/>);
 window.update=()=>{state={...state,revision:2,report:{...state.report,historyCoverages:historyCoverages.map((c,i)=>i===1?{...c,phase:'complete',messageCount:250,pageCount:5}:c)}};
 for(const fn of listeners)fn(state);render('contact-2');};render('contact-1');
 `);
 const section=page.getByRole('region',{name:'消息历史覆盖',exact:true});
 await expect(section.getByText('尚未开始',{exact:true})).toBeVisible();
 await expect(section.getByText('同步中',{exact:true})).toBeVisible();
 await expect(section.getByText('完整',{exact:true})).toBeVisible();
 await expect(section.getByText('不完整',{exact:true})).toBeVisible();
 await expect(section.getByText('读取超时，正在自动重试。',{exact:true})).toBeVisible();
 await expect(section.getByText('当前联系人：合成联系人1',{exact:true})).toBeVisible();
 await expect(section.getByText('已保存 100 条文字，已读取 1 页。',{exact:true})).toBeVisible();
 await expect(section.getByText('共 4 个会话：完整 1，同步中 1，不完整 1，尚未开始 1。',{exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'关系资料处理',exact:true})).toContainText('消息历史完整不代表关系资料已处理完成');
 await page.evaluate(()=>window.update());
 await expect(section.getByText('当前联系人：合成联系人2',{exact:true})).toBeVisible();
 await expect(section.getByText('已保存 250 条文字，已读取 5 页。',{exact:true})).toBeVisible();
 await expect(section.getByText('共 4 个会话：完整 2，同步中 0，不完整 1，尚未开始 1。',{exact:true})).toBeVisible();
});

test('会话类型冲突与范围未核验明确显示已停读，不暗示仍在读取正文', async t => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page = await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';import {HistoryCoverageStatus} from './src/renderer/HistoryCoverageStatus';
 const coverages=['cli_chat_not_private','cli_scope_unverified'].map((failureCode,i)=>({bindingId:'binding-'+i,contactId:'contact-'+i,
 phase:'incomplete',failureCode,messageCount:0,pageCount:0,nonTextCount:0}));
 createRoot(document.getElementById('root')).render(<HistoryCoverageStatus coverages={coverages}
 contacts={coverages.map((row,i)=>({contactId:row.contactId,displayName:'合成联系人'+i}))}/>);
 `);
 const section=page.getByRole('region',{name:'消息历史覆盖',exact:true});
 await expect(section.getByRole('status').filter({hasText:'会话类型与私聊授权不一致，已停止读取；请在联系人中核对关联。'})).toBeVisible();
 await expect(section.getByRole('status').filter({hasText:'暂时无法确认会话属于已授权私聊，已停止读取；核验通过后再继续。'})).toBeVisible();
 await expect(section).not.toContainText('正在自动重试');
});

test('旧增量授权没有历史行时，后台及当前联系人仍明确显示范围停读原因', async t => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page = await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 import {PrioritySyncStatus} from './src/renderer/PrioritySyncStatus';
 const state={revision:1,scopeRevision:1,phase:'ready',busy:null,errorCode:null,report:{enabled:true,
 backgroundPhase:'degraded',backgroundFailureCode:'cli_scope_unverified',confirmedBindingCount:1,backfill:{phase:'complete'},
 priority:{contactId:'legacy-contact',lastSuccessAt:null,lastFailureCode:'cli_chat_not_private',localHistoryState:null}}};
 const bridge={getState:async()=>state,refresh:async()=>{},onStateChanged:()=>()=>{}};
 createRoot(document.getElementById('root')).render(<><SyncControlPanel bridge={bridge}/><PrioritySyncStatus contactId="legacy-contact" bridge={bridge}/></>);
 `);
 await expect(page.getByRole('alert')).toContainText('暂时无法确认会话属于已授权私聊，已停止读取');
 await expect(page.getByLabel('当前联系人同步状态')).toContainText('会话类型与私聊授权不一致，已停止读取；请在联系人中核对关联。');
});

test('联系人详情只显示当前联系人的覆盖进度，切换时不沿用其他人的完整状态', async t => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page = await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
 const contacts=[{contactId:'a',displayName:'合成甲',messageCount:200},{contactId:'b',displayName:'合成乙',messageCount:10}];
 const bindings={revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],busy:null};
 const sync={revision:1,scopeRevision:1,phase:'ready',busy:null,report:{enabled:true,historyCoverages:[
 {bindingId:'a1',contactId:'a',phase:'complete',messageCount:200,pageCount:2,nonTextCount:0,failureCode:null},
 {bindingId:'b1',contactId:'b',phase:'incomplete',messageCount:10,pageCount:1,nonTextCount:0,failureCode:'cli_timeout'}]}};
 window.notalone={bindings:{getState:async()=>bindings,onStateChanged:()=>()=>{},refreshSaved:async()=>{}},
 syncControl:{getState:async()=>sync,onStateChanged:()=>()=>{},refresh:async()=>{}}};
 const root=createRoot(document.getElementById('root'));
 const render=id=>root.render(<ContactsPage session={{state:{contacts,selectedContactId:id,directoryPhase:'ready'},refreshContacts:async()=>{}}} navigate={()=>{}}/>);
 window.select=render;render('a');
 `);
 const summary=page.getByRole('complementary',{name:'本次联系人资料摘要'});
 await expect(summary.getByText('完整',{exact:true})).toBeVisible();
 await expect(summary.getByText('已保存 200 条文字，已读取 2 页。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.select('b'));
 await expect(summary.getByText('不完整',{exact:true})).toBeVisible();
 await expect(summary.getByText('已保存 10 条文字，已读取 1 页。',{exact:true})).toBeVisible();
 await expect(summary.getByText('完整',{exact:true})).toHaveCount(0);
});
