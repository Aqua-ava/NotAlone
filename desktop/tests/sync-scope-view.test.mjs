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

for (const selectionOnly of [undefined, true]) test(selectionOnly ? '联系人页面坚持逐人授权，旧全部范围提示不扩大当前选择' : '全部私聊联系人页面说明自动纳入，仍提供单个会话排除后的恢复入口',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {BindingConsentPage,ContactSyncDetails} from './src/renderer/BindingConsentPage';
 const selectionOnly=${JSON.stringify(selectionOnly)};
 const consent={state:{selectionOnly,phase:'ready',busy:null,syncEnabled:true,sessions:[],bindings:[],knownBindings:[{bindingId:'synthetic-id',contactId:'synthetic-contact',displayName:'合成联系人'}]},selection:{},setSelection(){}};
 createRoot(document.getElementById('root')).render(<>
  <BindingConsentPage contacts={{state:{contacts:[]}}} consent={consent} navigate={()=>{}} onClose={()=>{}} allPrivate/>
  <ContactSyncDetails contactId="synthetic-contact" consent={consent} onConnect={()=>{}} allPrivate/>
 </>);
 `);
 await expect(page.getByRole('heading',{name:selectionOnly ? '添加微信联系人' : '管理单个微信会话',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:selectionOnly ? '可添加的微信会话' : '待处理或已停止同步的会话',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'开启自动同步',exact:true})).toBeVisible();
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
 await expect(page.getByText('已允许读取授权会话在这台电脑上的历史文字消息，并持续同步新消息。',{exact:true})).toBeVisible();
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
 await expect(page.getByText('已允许读取授权会话在这台电脑上的历史文字消息，并持续同步新消息。',{exact:true})).toBeVisible();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{scopeRevision:4,decision:'accepted',confirmed:true});
});

test('同步总览保留进度和异常入口，默认不展开联系人或技术统计', async t => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page = await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 const historyCoverages=['not_started','syncing','complete','incomplete'].map((phase,i)=>({bindingId:'binding-'+i,contactId:'contact-'+i,phase,
 failureCode:i===3?'cli_timeout':null,messageCount:i*100,pageCount:i,nonTextCount:0}));
 let state={revision:1,scopeRevision:4,phase:'ready',busy:null,errorCode:null,report:{enabled:true,bodyAvailable:true,backgroundPhase:'active',confirmedBindingCount:4,
 historyCoverages,backfill:{phase:'complete'}}};
 const listeners=new Set();const bridge={getState:async()=>state,refresh:async()=>{},onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
 const root=createRoot(document.getElementById('root'));
 root.render(<SyncControlPanel bridge={bridge} currentContactId="contact-1"
 contacts={historyCoverages.map((c,i)=>({contactId:c.contactId,displayName:'合成联系人'+i}))}/>);
 window.update=()=>{state={...state,revision:2,report:{...state.report,historyCoverages:historyCoverages.map((c,i)=>i===1?{...c,phase:'complete',messageCount:250,pageCount:5}:c)}};
 for(const fn of listeners)fn(state);};
 `);
 const section=page.getByRole('region',{name:'聊天同步进度',exact:true});
 await expect(section.getByRole('progressbar')).toHaveAttribute('value','1');
 await expect(section.getByRole('progressbar')).toHaveAttribute('max','4');
 await expect(section.getByRole('button',{name:'查看并处理',exact:true})).toBeVisible();
 await expect(section).not.toContainText('合成联系人');
 await expect(section).not.toContainText('非文字占位');
 await expect(section).not.toContainText('读取暂时超时');
 await page.evaluate(()=>window.update());
 await expect(section.getByRole('progressbar')).toHaveAttribute('value','2');
 await expect(section).not.toContainText('已保存 250');
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
 const section=page.getByRole('region',{name:'聊天同步进度',exact:true});
 await section.getByRole('button',{name:'查看并处理',exact:true}).click();
 const issues=page.getByRole('region',{name:'同步问题',exact:true});
 await issues.getByRole('button',{name:/聊天来源需要核验.*2/}).click();
 await expect(issues).toContainText('相关读取已暂停');
 await expect(issues).toContainText('联系人的同步设置');
 await expect(page.locator('body')).not.toContainText('正在自动重试');
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

test('联系人列表不展开诊断，详情可显示短状态且启停仍需原授权流程', async t => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page = await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
 import {ContactSyncSettings} from './src/renderer/ContactSyncSettings';
 const contacts=[{contactId:'a',displayName:'合成甲',messageCount:200},{contactId:'b',displayName:'合成乙',messageCount:10}];
 const active=contacts.map(contact=>({bindingId:contact.contactId+'1',contactId:contact.contactId,locator:'synthetic-'+contact.contactId,displayName:contact.displayName,status:'active'}));
 let bindings={revision:1,scopeRevision:1,phase:'ready',selectionOnly:true,sessions:[],bindings:active,knownBindings:active,sessionIssue:'not-requested',busy:null};
 const listeners=new Set();window.writes=[];window.listReads=0;
 const sync={revision:1,scopeRevision:1,phase:'ready',busy:null,report:{enabled:true,selectionOnly:true,backfill:{phase:'complete'},historyCoverages:[
 {bindingId:'a1',contactId:'a',phase:'complete',messageCount:200,pageCount:2,nonTextCount:0,failureCode:null},
 {bindingId:'b1',contactId:'b',phase:'incomplete',messageCount:10,pageCount:1,nonTextCount:2,metadataOnlyCount:3,
 nonTextTypes:[{messageType:'image',label:'图片',count:2}],failureCode:'cli_timeout',incrementalPhase:'syncing',incrementalPages:200,incrementalFailureCode:'unknown'}]}};
 window.notalone={bindings:{getState:async()=>bindings,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},refreshSaved:async()=>{},
 refresh:async()=>{window.listReads++;},revokeBinding:async request=>{window.writes.push(request);
 bindings={...bindings,revision:2,scopeRevision:2,bindings:active.filter(binding=>binding.bindingId!==request.bindingId),
 knownBindings:active.map(binding=>binding.bindingId===request.bindingId?{...binding,status:'revoked'}:binding),notice:'revoked'};
 for(const listener of listeners)listener(bindings);}},
 historyClear:{getState:async()=>({revision:1,contactId:null,scopeRevision:1,phase:'idle',clear:null,resync:null,busy:null,error:null}),onStateChanged:()=>()=>{},refresh:async()=>{}},
 syncControl:{getState:async()=>sync,onStateChanged:()=>()=>{},refresh:async()=>{}}};
 const root=createRoot(document.getElementById('root'));
 window.notalone.contactHistory={getState:async()=>({revision:1,contactId:null,scopeRevision:1,messages:{phase:'idle',items:[],nextCursor:null},error:null}),onStateChanged:()=>()=>{}};
 const render=(id,view='contacts')=>{const session={state:{contacts,selectedContactId:id,scopeRevision:1,directoryPhase:'ready'},refreshContacts:async()=>{}};
 root.render(view==='contacts'?<ContactsPage session={session} navigate={()=>{}}/>:
 <ContactSyncSettings key={id??''} session={session} navigate={()=>{}}/>);};
 window.select=render;render('a');
 `);
 const directory=page.getByRole('region',{name:'联系人目录'});
 const list=directory.getByRole('list',{name:'联系人列表'});
 await expect(list).toContainText('200 条消息');
 await expect(list).toContainText('10 条消息');
 await expect(list).not.toContainText('同步');
 const options=directory.getByLabel('聊天选项',{exact:true});
 const settingsButton=directory.getByRole('button',{name:'同步与资料',exact:true});
 await expect(directory.getByRole('button',{name:'处理同步问题',exact:true})).toHaveCount(0);
 await options.click();
 await settingsButton.click();
 await expect(directory.getByRole('button',{name:/停止.*的自动同步/})).toBeVisible();
 await expect(directory.getByRole('button',{name:'查看关系资料',exact:true})).toBeVisible();
 await page.evaluate(()=>window.select('b'));
 await expect(directory.getByRole('region',{name:'当前联系人设置',exact:true})).toHaveCount(0);
 await options.click();
 await settingsButton.click();
 await expect(directory.getByRole('button',{name:/停止.*的自动同步/})).toBeVisible();
 for(const text of ['非文字占位','系统等元数据','已跟进','新消息同步暂未继续','图片：']) {
  await expect(directory).not.toContainText(text);
 }
 await page.evaluate(()=>window.select('a','sync'));
 const settings=page.getByRole('region',{name:'单个联系人同步'});
 await settings.getByRole('button',{name:'停止合成甲的自动同步',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'撤销后台读取授权确认'});
 await expect(dialog).toContainText('合成甲');
 assert.deepEqual(await page.evaluate(()=>window.writes),[]);
 await page.evaluate(()=>window.select('b','sync'));
 await expect(dialog).toHaveCount(0);
 await expect(settings.getByRole('button',{name:'停止合成甲的自动同步',exact:true})).toHaveCount(0);
 await settings.getByRole('button',{name:'停止合成乙的自动同步',exact:true}).click();
 await dialog.getByRole('button',{name:'确认撤销此会话授权',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.writes),[{scopeRevision:1,contactId:'b',bindingId:'b1'}]);
 await expect(settings.getByRole('button',{name:'开启自动同步',exact:true})).toBeVisible();
 await settings.getByRole('button',{name:'开启自动同步',exact:true}).click();
 await expect(settings.getByRole('region',{name:'添加微信联系人'})).toBeVisible();
 assert.equal(await page.evaluate(()=>window.listReads),0);
 assert.equal((await page.evaluate(()=>window.writes)).length,1);
 await settings.getByRole('button',{name:'返回同步设置',exact:true}).click();
 await expect(settings.getByRole('button',{name:'开启自动同步',exact:true})).toBeVisible();
 await page.evaluate(()=>window.select(null,'sync'));
 await expect(settings).toContainText('在顶部选择联系人后');
 await expect(settings.getByRole('button',{name:/停止.*的自动同步/})).toHaveCount(0);
});


test('SQLite总开关先核验读取能力，关闭或未就绪时不误报功能尚未开放',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';import {SyncControlPanel} from './src/renderer/SyncControlPanel';
 const listeners=new Set();window.calls=[];
 let state={revision:1,scopeRevision:4,phase:'ready',busy:null,errorCode:null,report:{selectionOnly:true,bodyAvailable:false,enabled:false,syncScope:'selected',
 historyAuthorizationState:'required',backgroundPhase:'disabled',confirmedBindingCount:2,backfill:{phase:'not_required'}}};
 const bridge={getState:async()=>state,refresh:async()=>{},onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 enable:async request=>{window.calls.push(request);state={...state,revision:state.revision+1,report:{...state.report,enabled:true}};for(const fn of listeners)fn(state);}};
 createRoot(document.getElementById('root')).render(<SyncControlPanel bridge={bridge}/>);
 `);
 await expect(page.getByText('后台正文同步已关闭',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:/确认同步全部微信私聊|重试自动关联|允许读取历史|暂不读取/})).toHaveCount(0);
 await expect(page.getByText('请到「联系人」逐人确认私聊；每次确认包含该会话本机可读的历史文字和后续新消息，新私聊不会自动纳入。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'开启后台同步',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{scopeRevision:4}]);
 await expect(page.getByText('已开启同步，等待读取能力核验',{exact:true})).toBeVisible();
 await expect(page.getByText('后台正文同步已开启',{exact:true})).toHaveCount(0);
});

test('大量同步异常按原因去重，搜索分页有界且查看联系人不重放授权', async t => {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {HistoryCoverageStatus} from './src/renderer/HistoryCoverageStatus';
 const contacts=Array.from({length:200},(_,i)=>({contactId:'contact-'+i,displayName:'合成联系人'+String(i).padStart(3,'0')}));
 const coverages=contacts.map((contact,i)=>({bindingId:'binding-'+i,contactId:contact.contactId,
 phase:i<189?'incomplete':'complete',failureCode:i<189?'history_source_continuity_unverified':null,
 messageCount:2000,nonTextCount:70,pageCount:200,metadataOnlyCount:30,
 incrementalPhase:i<192?'blocked':'ready',incrementalFailureCode:i<189?'history_incomplete':i<192?'history_tail_unsupported':null}));
 coverages.push({...coverages[0],bindingId:'duplicate-binding',failureCode:'cli_timeout'});
 window.calls=[];
 const root=createRoot(document.getElementById('root'));
 const render=(rows=coverages,names=contacts)=>root.render(<HistoryCoverageStatus coverages={rows} contacts={names} bodyAvailable enabled
 onOpenContact={id=>window.calls.push({contactId:id})} onOpenDiagnostics={()=>window.calls.push({diagnostics:true})}/>);
 window.replace=()=>render([{...coverages[0],contactId:'replacement',bindingId:'replacement'}],[{contactId:'replacement',displayName:'新范围联系人'}]);
 render();
 `);
 const overview=page.getByRole('region',{name:'聊天同步进度',exact:true});
 await expect(overview).toContainText('192 位联系人同步需要关注');
 await expect(overview).not.toContainText('合成联系人');
 await expect(page.getByRole('list',{name:'需关注的联系人'})).toHaveCount(0);
 await expect(overview).not.toContainText('非文字占位');
 await overview.getByRole('button',{name:'查看并处理',exact:true}).click();
 const issues=page.getByRole('region',{name:'同步问题',exact:true});
 await expect(issues).toContainText('192 位联系人需要关注');
 await expect(issues).not.toContainText('合成联系人');
 await issues.getByRole('button',{name:/聊天来源需要核验.*189/}).click();
 const list=issues.getByRole('list',{name:'需关注的联系人'});
 await expect(list.getByRole('listitem')).toHaveCount(10);
 await expect(list).toContainText('合成联系人000');
 await expect(list).not.toContainText('非文字占位');
 await issues.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(list.getByRole('listitem')).toHaveCount(10);
 await expect(list).toContainText('合成联系人010');
 await expect(list).not.toContainText('合成联系人000');
 await issues.getByRole('searchbox',{name:'搜索联系人'}).fill('188');
 await expect(list.getByRole('listitem')).toHaveCount(1);
 await expect(list).toContainText('合成联系人188');
 await expect(issues.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
 await list.getByRole('button',{name:'查看联系人',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{contactId:'contact-188'}]);
 await issues.getByRole('searchbox',{name:'搜索联系人'}).fill('');
 await page.evaluate(()=>window.replace());
 await expect(list.getByRole('listitem')).toHaveCount(1);
 await expect(list).toContainText('新范围联系人');
 await expect(issues).not.toContainText('合成联系人');
 await issues.getByRole('button',{name:'打开同步诊断',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{contactId:'contact-188'},{diagnostics:true}]);
});

test('同步诊断分页按需挂载单人统计，删除或换范围后撤下旧详情', async t => {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {HistoryCoverageDiagnostics} from './src/renderer/HistoryCoverageStatus';
 const contacts=Array.from({length:23},(_,i)=>({contactId:'contact-'+i,displayName:'诊断合成联系人'+String(i).padStart(2,'0')}));
 const coverages=contacts.map((contact,i)=>({bindingId:'binding-'+i,contactId:contact.contactId,
 phase:'incomplete',failureCode:'history_source_continuity_unverified',messageCount:100+i,nonTextCount:70,pageCount:200,
 nonTextTypes:[{messageType:'image',label:'图片',count:70}],metadataOnlyCount:30,incrementalPhase:'blocked',incrementalPages:12}));
 const root=createRoot(document.getElementById('root'));
 const render=(rows=coverages,names=contacts)=>root.render(<HistoryCoverageDiagnostics coverages={rows} contacts={names} bodyAvailable enabled incrementalIdentityLimit={100000}/>);
 window.removeSelected=()=>render(coverages.filter(row=>row.contactId!=='contact-22'),contacts.filter(contact=>contact.contactId!=='contact-22'));
 window.replace=()=>render([{...coverages[0],contactId:'new',bindingId:'new'}],[{contactId:'new',displayName:'新范围诊断联系人'}]);
 render();
 `);
 const diagnostics=page.getByRole('region',{name:'同步诊断',exact:true});
 const list=diagnostics.getByRole('list',{name:'同步诊断联系人'});
 const detail=diagnostics.getByLabel('当前联系人消息历史覆盖');
 await expect(diagnostics).toContainText('增量同步的消息身份基线上限为 100,000 条');
 await expect(list.getByRole('listitem')).toHaveCount(10);
 await expect(detail).toHaveCount(0);
 await expect(diagnostics).not.toContainText('70 条非文字占位');
 await diagnostics.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(list).toContainText('诊断合成联系人10');
 await diagnostics.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(list.getByRole('listitem')).toHaveCount(3);
 await list.getByRole('listitem').filter({hasText:'诊断合成联系人22'}).getByRole('button',{name:'查看明细'}).click();
 await expect(list).toHaveCount(0);
 await expect(detail).toContainText('已保存 122 条文字消息');
 await expect(detail).toContainText('图片：70 条');
 await expect(detail).toContainText('系统等元数据');
 await expect(detail).toContainText('非文字占位只表示消息存在，不包含语音、视频、文件或表情正文');
 await expect(detail).toContainText('图片即使已保存，也可能因本机文件缺失、缺密钥或来源未核验而无法查看');
 await page.evaluate(()=>window.removeSelected());
 await expect(detail).toHaveCount(0);
 await expect(diagnostics).not.toContainText('诊断合成联系人22');
 await expect(list.getByRole('listitem')).toHaveCount(10);
 await diagnostics.getByRole('searchbox',{name:'搜索联系人'}).fill('21');
 await expect(list.getByRole('listitem')).toHaveCount(1);
 await list.getByRole('button',{name:'查看明细'}).click();
 await expect(detail).toContainText('已保存 121 条文字消息');
 await page.evaluate(()=>window.replace());
 await expect(detail).toHaveCount(0);
 await expect(diagnostics).not.toContainText('诊断合成联系人');
 await expect(list).toContainText('新范围诊断联系人');
});

test('已关闭同步的临时失败仅展示保存状态，不承诺正在自动重试', async t => {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page, `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {HistoryCoverageStatus} from './src/renderer/HistoryCoverageStatus';
 createRoot(document.getElementById('root')).render(<HistoryCoverageStatus enabled={false} bodyAvailable
 coverages={[{bindingId:'b',contactId:'c',phase:'incomplete',failureCode:'cli_timeout',messageCount:1,nonTextCount:0,pageCount:1}]}/>);
 `);
 await page.getByRole('button',{name:'查看并处理',exact:true}).click();
 const issues=page.getByRole('region',{name:'同步问题',exact:true});
 await issues.getByRole('button',{name:/暂时读取失败/}).click();
 await expect(issues).toContainText('当前不会读取或自动重试');
 await expect(issues).not.toContainText('同步开启期间会自动重试');
 await expect(issues).not.toContainText('正在读取');
});

test('来源无法确认时才显示修复入口，健康、临时失败及暂停不提示修复', async t => {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 await mount(page,`
 import React from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
 const noop=async()=>{};const listeners=new Set();const bindingListeners=new Set();
 const binding={bindingId:'a1',contactId:'a',locator:'synthetic-a',displayName:'合成甲',status:'active'};
 let bindings={revision:1,scopeRevision:1,phase:'ready',selectionOnly:true,knownBindings:[binding],bindings:[binding],sessions:[],sessionIssue:'not-requested',busy:null};
 const contacts=[{contactId:'a',displayName:'合成甲',messageCount:1}];
 let sync={revision:1,scopeRevision:1,phase:'ready',errorCode:null,busy:null,report:{enabled:true,bodyAvailable:true,
  historyCoverages:[{bindingId:'a1',contactId:'a',phase:'complete',messageCount:1,pageCount:1,nonTextCount:0,failureCode:null}]}};
 window.updateSync=(failureCode,enabled=true,contactId='a',phase='ready',incremental=false)=>{
  sync={...sync,revision:sync.revision+1,phase,report:{...sync.report,enabled,historyCoverages:[{
   ...sync.report.historyCoverages[0],contactId,failureCode:incremental?null:failureCode,incrementalFailureCode:incremental?failureCode:null,phase:failureCode&&!incremental?'incomplete':'complete'}]}};
  listeners.forEach(listener=>listener(sync));
 };
 window.stopContact=()=>{
  bindings={...bindings,revision:bindings.revision+1,bindings:[],knownBindings:[{...binding,status:'revoked'}]};
  bindingListeners.forEach(listener=>listener(bindings));
  return sync.report.enabled;
 };
 const subscription=state=>({getState:async()=>state,onStateChanged:()=>()=>{},refresh:noop,refreshSaved:noop});
 window.notalone={
  bindings:{getState:async()=>bindings,onStateChanged:listener=>{bindingListeners.add(listener);return()=>bindingListeners.delete(listener);},refresh:noop,refreshSaved:noop},
  contactHistory:{...subscription({revision:1,contactId:'a',scopeRevision:1,messages:{phase:'ready',items:[],nextCursor:null},error:null}),load:noop},
  historyClear:subscription({revision:1,contactId:'a',scopeRevision:1,phase:'ready',clear:null,resync:null,busy:null,error:null,
   recertify:{contactId:'a',state:'none',stage:'none',completed:false,requestKey:null,failureCode:null}}),
  syncControl:{getState:async()=>sync,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},refresh:noop}
 };
 createRoot(document.getElementById('root')).render(<ContactsPage session={{state:{contacts,selectedContactId:'a',scopeRevision:1,directoryPhase:'ready'},refreshContacts:noop}} navigate={()=>{}}/>);
 `);
 const entry=page.getByRole('button',{name:'处理同步问题',exact:true});
 const repair=page.getByRole('button',{name:'修复同步',exact:true,includeHidden:true});
 const status=page.locator('.contact-history-status');
 await expect(page.getByRole('button',{name:'打开助手',exact:true})).toBeVisible();
 await expect(status).toHaveText('本机历史已读完');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await page.evaluate(()=>window.updateSync('cli_timeout'));
 await expect(status).toHaveText('暂时读取失败');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await page.evaluate(()=>window.updateSync('history_source_continuity_unverified',false));
 await expect(status).toHaveText('自动同步已关闭');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await page.evaluate(()=>window.updateSync('history_source_continuity_unverified',true,'b'));
 await expect(status).toHaveText('历史覆盖待确认');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await page.evaluate(()=>window.updateSync('history_source_continuity_unverified',true,'a','failed'));
 await expect(status).toHaveText('历史覆盖待确认');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await page.evaluate(()=>window.updateSync('history_source_continuity_unverified'));
 await expect(entry).toBeVisible();await entry.click();await expect(repair).toBeVisible();
 await repair.click();await expect(page.getByRole('dialog',{name:'确认修复同步',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.evaluate(()=>window.updateSync(null));
 await expect(status).toHaveText('本机历史已读完');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await page.evaluate(()=>window.updateSync('history_source_continuity_unverified',true,'a','ready',true));
 await expect(entry).toBeVisible();await expect(repair).toBeVisible();
 await repair.click();await expect(page.getByRole('dialog',{name:'确认修复同步',exact:true})).toBeVisible();
 assert.equal(await page.evaluate(()=>window.stopContact()),true);
 await expect(page.getByRole('button',{name:'开启自动同步',exact:true})).toBeVisible();
 await expect(status).toHaveText('聊天来源需要核验');
 await expect(entry).toHaveCount(0);await expect(repair).toHaveCount(0);
 await expect(page.getByRole('dialog',{name:'确认修复同步',exact:true})).toHaveCount(0);
});
