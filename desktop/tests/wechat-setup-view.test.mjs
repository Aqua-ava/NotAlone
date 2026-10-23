import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
async function pageFixture(t, phase='needs_detection') {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WechatSetupPanel} from './src/renderer/WechatSetupPanel';
 let state={phase:${JSON.stringify(phase)},accountId:null,failureCode:null,revision:1};const listeners=new Set();window.calls=[];
 window.update=value=>{state={...state,...value,revision:state.revision+1};for(const fn of listeners)fn(state);};
 const bridge={getState:async()=>state,refresh:async()=>window.calls.push('refresh'),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 detect:async()=>{window.calls.push('detect');window.update({phase:'ready',accountId:'synthetic-account'});},
 confirm:async value=>{window.calls.push(value);window.update({phase:'connected'});},retryRestart:async()=>window.calls.push('retry')};
 createRoot(document.getElementById('root')).render(<WechatSetupPanel bridge={bridge}><button>同步总开关</button></WechatSetupPanel>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});return page;
}
test('新用户主动检测并确认列表读取，默认仅所选且不读取历史',async t=>{
 const page=await pageFixture(t);
 await expect(page.getByRole('button',{name:'检测微信账号',exact:true})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh']);
 await expect(page.getByRole('button',{name:'同步总开关',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'确认连接并开启同步',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'检测微信账号',exact:true}).click();
 await expect(page.getByText('synthetic-account',{exact:true})).toBeVisible();
 await expect(page.getByText('读取工具配置的微信账号：synthetic-account',{exact:true})).toBeVisible();
 await expect(page.getByRole('radio',{name:'仅我选择的私聊',exact:true})).toBeChecked();
 await expect(page.getByRole('checkbox')).not.toBeChecked();
 await expect(page.getByText(/确认连接表示允许读取该账号的会话列表/)).toBeVisible();
 await page.getByRole('button',{name:'确认连接并开启同步',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{revision:2,confirmed:true,mode:'selected',historyAuthorized:false});
 await expect(page.getByText('微信账号已连接',{exact:true})).toBeVisible();
 await expect(page.getByText('已关联的微信账号：synthetic-account',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'同步总开关',exact:true})).toBeVisible();
});
test('未准备的工具不能伪装为连接成功，保存后只重试加载',async t=>{
 const page=await pageFixture(t,'tool_not_ready');
 await expect(page.getByText(/当前版本尚不能完成全新电脑的微信读取工具初始化/)).toBeVisible();
 await expect(page.getByRole('button',{name:'确认连接并开启同步',exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.update({phase:'restart-failed',accountId:'synthetic-account'}));
 await expect(page.getByText(/授权已保存/)).toBeVisible();
 await page.getByRole('button',{name:'重新加载连接',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh','retry']);
});

test('全部私聊及历史独立明确选择，扩大范围清除旧历史勾选',async t=>{
 const page=await pageFixture(t);await page.getByRole('button',{name:'检测微信账号',exact:true}).click();
 await expect(page.getByRole('checkbox')).toBeDisabled();
 await expect(page.getByText(/选择会话时再确认历史范围/)).toBeVisible();
 await page.getByRole('radio',{name:'当前账号的全部私聊',exact:true}).check();
 await page.getByRole('checkbox').check();
 await page.getByRole('radio',{name:'仅我选择的私聊',exact:true}).check();
 await page.getByRole('radio',{name:'当前账号的全部私聊',exact:true}).check();
 await expect(page.getByRole('checkbox')).not.toBeChecked();
 await expect(page.getByText(/现有及以后新增的微信私聊/)).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh','detect']);
 await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'确认连接并开启同步',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{revision:2,confirmed:true,mode:'all_private',historyAuthorized:true});
});

test('账号候选变化重置授权选择，未经确认离开不保存授权',async t=>{
 const page=await pageFixture(t);await page.getByRole('button',{name:'检测微信账号',exact:true}).click();
 await page.getByRole('radio',{name:'当前账号的全部私聊',exact:true}).check();await page.getByRole('checkbox').check();
 await page.evaluate(()=>window.update({accountId:'another-synthetic-account'}));
 await expect(page.getByRole('radio',{name:'仅我选择的私聊',exact:true})).toBeChecked();
 await expect(page.getByRole('checkbox')).not.toBeChecked();
 await page.evaluate(()=>window.update({phase:'needs_detection',accountId:null}));
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh','detect']);
 await expect(page.getByRole('button',{name:'确认连接并开启同步',exact:true})).toHaveCount(0);
});

test('进入添加联系人只展示同意说明，明确刷新才读取列表，返回不授权正文',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
 window.calls=[];
 const bindingState={revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:'not-requested',busy:null,errorCode:null,notice:null};
 const syncState={revision:1,scopeRevision:1,phase:'ready',busy:null,errorCode:null,report:{syncScope:'selected',enabled:false}};
 window.notalone={bindings:{getState:async()=>bindingState,onStateChanged:()=>()=>{},refreshSaved:async()=>window.calls.push('saved'),refresh:async()=>window.calls.push('list')},
 syncControl:{getState:async()=>syncState,onStateChanged:()=>()=>{},refresh:async()=>window.calls.push('sync')}};
 createRoot(document.getElementById('root')).render(<ContactsPage session={{state:{contacts:[],directoryPhase:'ready'}}} navigate={()=>{}}/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.getByRole('button',{name:'添加微信联系人',exact:true}).click();
 await expect(page.getByText(/表示同意读取当前微信账号的会话列表/)).toBeVisible();
 assert.ok(!(await page.evaluate(()=>window.calls)).includes('list'));
 await page.getByRole('button',{name:'返回联系人',exact:true}).click();
 assert.ok(!(await page.evaluate(()=>window.calls)).includes('list'));
 await page.getByRole('button',{name:'添加微信联系人',exact:true}).click();
 await page.getByRole('button',{name:'刷新微信会话',exact:true}).click();
 assert.equal((await page.evaluate(()=>window.calls)).filter(call=>call==='list').length,1);
 await expect(page.getByRole('button',{name:'确认并授权所选会话',exact:true})).toBeDisabled();
});

test('实际所选历史默认关闭，选择和刷新后重置，仅确认时传出本次选择',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
 window.calls=[];const listeners=new Set();
 let state={revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:'not-requested',busy:null,errorCode:null,notice:null};
 const syncState={revision:1,scopeRevision:1,phase:'ready',busy:null,errorCode:null,report:{syncScope:'selected',enabled:false}};
 window.notalone={bindings:{getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},refreshSaved:async()=>{},
 refresh:async()=>{state={...state,revision:state.revision+1,sessionIssue:null,sessions:['a','b'].map(locator=>({locator,displayName:'合成'+locator,boundContactId:null,lastTimestamp:null}))};for(const fn of listeners)fn(state);},
 confirmSelections:async request=>window.calls.push(request)},
 syncControl:{getState:async()=>syncState,onStateChanged:()=>()=>{},refresh:async()=>{}}};
 createRoot(document.getElementById('root')).render(<ContactsPage session={{state:{contacts:[],directoryPhase:'ready'}}} navigate={()=>{}}/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.getByRole('button',{name:'添加微信联系人',exact:true}).click();
 const history=page.getByRole('checkbox',{name:'同时读取本次所选会话在本机可用的历史消息',exact:true});
 await expect(history).not.toBeChecked();await expect(history).toBeDisabled();
 await page.getByRole('button',{name:'刷新微信会话',exact:true}).click();
 await page.getByRole('checkbox',{name:'选择会话 a',exact:true}).check();
 await page.getByRole('combobox',{name:'会话 a 对应联系人',exact:true}).selectOption('new');await history.check();
 await page.getByRole('checkbox',{name:'选择会话 b',exact:true}).check();await expect(history).not.toBeChecked();
 await page.getByRole('combobox',{name:'会话 b 对应联系人',exact:true}).selectOption('new');await history.check();
 await page.getByRole('button',{name:'刷新微信会话',exact:true}).click();await expect(history).not.toBeChecked();
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await history.check();await page.getByRole('button',{name:'确认并授权所选会话',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{scopeRevision:1,historyAuthorized:true,selections:[
  {locator:'a',displayName:'合成a',contactId:null},{locator:'b',displayName:'合成b',contactId:null}]}]);
});
