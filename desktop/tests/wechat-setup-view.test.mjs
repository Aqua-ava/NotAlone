import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
async function pageFixture(t, phase='needs_detection', selectionOnly=false, failureCode=null) {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WechatSetupPanel} from './src/renderer/WechatSetupPanel';
 let state={phase:${JSON.stringify(phase)},accountId:null,failureCode:${JSON.stringify(failureCode)},revision:1};const listeners=new Set();window.calls=[];
 window.update=value=>{state={...state,...value,revision:state.revision+1};for(const fn of listeners)fn(state);};
 const bridge={getState:async()=>state,refresh:async()=>window.calls.push('refresh'),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 detect:async()=>{window.calls.push('detect');window.update({phase:'ready',accountId:'synthetic-account'});},
 confirm:async value=>{window.calls.push(value);window.update({phase:'connected'});},retryRestart:async()=>window.calls.push('retry')};
 createRoot(document.getElementById('root')).render(<WechatSetupPanel bridge={bridge} selectionOnly={${selectionOnly}}><button>同步总开关</button></WechatSetupPanel>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});return page;
}

test('同账号来源连续性失效明确说明来源变化，不误报为微信账号不一致',async t=>{
 const page=await pageFixture(t,'conflict',true,'identity_continuity_unverified');
 await expect(page.getByRole('alert')).toContainText('本机微信数据来源已变化');
 await expect(page.getByRole('alert')).toContainText('旧读取授权尚未恢复');
 await expect(page.getByRole('alert')).not.toContainText('微信账号与当前配置不一致');
});

test('名单失败不显示空列表，明确全选只覆盖当前未添加私聊', async t => {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {BindingConsentPage} from './src/renderer/BindingConsentPage';
 window.calls=[];function App(){const [selection,setSelection]=useState({});const [state,setState]=useState({selectionOnly:true,revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:'failed',busy:null,errorCode:null,notice:null});
 window.publish=values=>setState(previous=>({...previous,...values}));
 return <BindingConsentPage contacts={{state:{contacts:[]}}} consent={{state,selection,setSelection,refresh:async()=>{},confirm:async()=>window.calls.push(selection)}} navigate={()=>{}} onClose={()=>{}}/>;}
 createRoot(document.getElementById('root')).render(<App/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await expect(page.getByText('当前没有可添加的微信会话。',{exact:true})).toHaveCount(0);
 await expect(page.getByText(/会话名单读取失败/)).toBeVisible();
 await page.evaluate(()=>window.publish({sessionIssue:null,sessions:['a','b'].map(locator=>({locator,displayName:'合成'+locator,boundContactId:null}))}));
 await expect(page.getByRole('checkbox',{name:'选择会话 a',exact:true})).not.toBeChecked();
 await page.getByRole('button',{name:'全选当前列表',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'选择会话 b',exact:true})).toBeChecked();
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await page.getByRole('button',{name:'确认并授权所选会话',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{a:{displayName:'合成a',target:'new'},b:{displayName:'合成b',target:'new'}}]);
 await page.evaluate(()=>window.publish({sessions:['a','b','c'].map(locator=>({locator,displayName:'合成'+locator,boundContactId:null}))}));
 await expect(page.getByRole('checkbox',{name:'选择会话 c',exact:true})).not.toBeChecked();
 await page.getByRole('button',{name:'清空选择',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'选择会话 a',exact:true})).not.toBeChecked();
});
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
 await expect(page.getByText(/暂时无法完成微信账号核验/)).toBeVisible();
 await expect(page.getByRole('button',{name:'确认连接并开启同步',exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.update({phase:'restart-failed',accountId:'synthetic-account'}));
 await expect(page.getByText(/授权已保存/)).toBeVisible();
 await page.getByRole('button',{name:'重新加载连接',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh','retry']);
});

test('工具清单缺失准确提示制品不完整，不误报全新电脑初始化', async t => {
 const page = await pageFixture(t, 'tool_not_ready', false, 'history_artifact_manifest_missing');
 await expect(page.getByRole('alert')).toContainText('微信读取工具不完整，缺少校验清单');
 await expect(page.getByText(/全新电脑/)).toHaveCount(0);
 await expect(page.getByRole('button', {name: '确认连接并开启同步', exact: true})).toHaveCount(0);
 assert.deepEqual(await page.evaluate(() => window.calls), ['refresh']);
 await page.evaluate(() => window.update({failureCode: 'history_account_unavailable'}));
 await expect(page.getByRole('alert')).toContainText('尚未配置可用的微信账号');
 await page.evaluate(() => window.update({failureCode: 'history_program_version_uncertified'}));
 await expect(page.getByRole('alert')).toContainText('当前微信版本尚未通过支持核验');
 await page.evaluate(() => window.update({failureCode: 'history_source_unverified'}));
 await expect(page.getByRole('alert')).toContainText('当前微信数据来源未通过核验');
 await page.evaluate(() => window.update({failureCode: 'unknown_internal_detail'}));
 await expect(page.getByRole('alert')).toContainText('暂时无法完成微信账号核验');
 await expect(page.getByText(/unknown_internal_detail|全新电脑/)).toHaveCount(0);
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
 const bindingState={selectionOnly:true,revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:'not-requested',busy:null,errorCode:null,notice:null};
 const syncState={revision:1,scopeRevision:1,phase:'ready',busy:null,errorCode:null,report:{syncScope:'selected',enabled:false}};
 window.notalone={bindings:{getState:async()=>bindingState,onStateChanged:()=>()=>{},refreshSaved:async()=>window.calls.push('saved'),refresh:async()=>window.calls.push('list')},
 syncControl:{getState:async()=>syncState,onStateChanged:()=>()=>{},refresh:async()=>window.calls.push('sync')}};
 createRoot(document.getElementById('root')).render(<ContactsPage session={{state:{contacts:[],directoryPhase:'ready'}}} navigate={()=>{}}/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await expect(page.getByText('逐人确认微信私聊后加入联系人；未选中的会话和以后新增的私聊不会获得读取授权。',{exact:true})).toBeVisible();
 await expect(page.getByText(/从文件导入|全部私聊/)).toHaveCount(0);
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

for (const selectionOnly of [undefined, true]) test(selectionOnly
 ? '逐人选择包含本机历史，列表不预选且新会话不自动授权'
 : '实际所选历史默认关闭，选择和刷新后重置，仅确认时传出本次选择',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
 window.calls=[];const listeners=new Set();
 let state={selectionOnly:${JSON.stringify(selectionOnly)},revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:'not-requested',busy:null,errorCode:null,notice:null};
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
 if(selectionOnly) {
  await expect(history).toHaveCount(0);
  await expect(page.getByText('确认后允许读取本次所选会话在本机可读的历史文字和后续新消息；非文字消息只保留占位，不自动下载媒体。',{exact:true})).toBeVisible();
 } else { await expect(history).not.toBeChecked();await expect(history).toBeDisabled(); }
 await page.getByRole('button',{name:'刷新微信会话',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'选择会话 a',exact:true})).not.toBeChecked();
 await expect(page.getByRole('checkbox',{name:'选择会话 b',exact:true})).not.toBeChecked();
 await page.getByRole('checkbox',{name:'选择会话 a',exact:true}).check();
 await page.getByRole('combobox',{name:'会话 a 对应联系人',exact:true}).selectOption('new');
 if(selectionOnly) {
  await page.getByRole('button',{name:'刷新微信会话',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'选择会话 b',exact:true})).not.toBeChecked();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await page.getByRole('button',{name:'确认并授权所选会话',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{scopeRevision:1,historyAuthorized:true,selections:[{locator:'a',displayName:'合成a',contactId:null}]}]);
 } else {
  await page.getByRole('button',{name:'确认并授权所选会话',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{scopeRevision:1,historyAuthorized:false,selections:[{locator:'a',displayName:'合成a',contactId:null}]}]);
  await page.evaluate(()=>{window.calls=[];});await history.check();
  await page.getByRole('checkbox',{name:'选择会话 b',exact:true}).check();await expect(history).not.toBeChecked();
  await page.getByRole('combobox',{name:'会话 b 对应联系人',exact:true}).selectOption('new');await history.check();
  await page.getByRole('button',{name:'刷新微信会话',exact:true}).click();await expect(history).not.toBeChecked();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  await history.check();await page.getByRole('button',{name:'确认并授权所选会话',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls),[{scopeRevision:1,historyAuthorized:true,selections:[
   {locator:'a',displayName:'合成a',contactId:null},{locator:'b',displayName:'合成b',contactId:null}]}]);
 }
});

for (const selectionOnly of [undefined, true]) test(selectionOnly ? '停止同步明确撤销即时资格，确认前不请求并保留既有联系人' : 'PG停止同步保留等待收尾语义，确认前不请求',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ContactSyncDetails,BindingFeedback} from './src/renderer/BindingConsentPage';
 import {useBindingConsent} from './src/renderer/use-binding-consent';
 window.calls=[];const listeners=new Set();
 const binding={bindingId:'synthetic-binding',contactId:'synthetic-contact',locator:'synthetic-private',displayName:'合成联系人',status:'active'};
 let state={selectionOnly:${JSON.stringify(selectionOnly)},revision:1,scopeRevision:7,phase:'ready',sessions:[],bindings:[binding],knownBindings:[binding],syncEnabled:true,sessionIssue:'not-requested',busy:null,errorCode:null,notice:null};
 window.notalone={bindings:{getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 revokeBinding:async request=>{window.calls.push(request);state={...state,revision:2,scopeRevision:8,bindings:[],knownBindings:[{...binding,status:'revoked'}],notice:'revoked'};for(const fn of listeners)fn(state);}}};
 function View(){const consent=useBindingConsent({state:{contacts:[{contactId:'synthetic-contact',displayName:'合成联系人',messageCount:12,sourceCount:1}]}});
 return <><ContactSyncDetails contactId="synthetic-contact" consent={consent} onConnect={()=>{}}/><BindingFeedback consent={consent}/></>;}
 createRoot(document.getElementById('root')).render(<View/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.getByRole('button',{name:'停止会话 synthetic-private 的自动同步',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'撤销后台读取授权确认',exact:true});
 if(selectionOnly) {
  await expect(dialog).toContainText('立即撤销此联系人的新读取、记忆处理和本地媒体转换资格');
  await expect(dialog).toContainText('旧请求即使迟到也不能提交');
 } else {
  await expect(dialog).toContainText('等待本轮读取收尾后生效');
  await expect(dialog).not.toContainText('立即撤销');
 }
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await dialog.getByRole('button',{name:'确认撤销此会话授权',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{scopeRevision:7,contactId:'synthetic-contact',bindingId:'synthetic-binding'}]);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByText('曾关联：合成联系人',{exact:true})).toBeVisible();
 await expect(page.getByText(selectionOnly ? '已撤销此联系人的读取与处理资格，已有资料仍保留。' : '已撤销此会话的后台读取授权，历史资料仍保留。',{exact:true})).toBeVisible();
});


test('SQLite账号确认只提供逐人范围，连接账号不授权历史或全部私聊',async t=>{
 const page=await pageFixture(t,'needs_detection',true);
 await page.getByRole('button',{name:'检测微信账号',exact:true}).click();
 await expect(page.getByRole('radio',{name:'仅我选择的私聊',exact:true})).toBeChecked();
 await expect(page.getByRole('radio',{name:'当前账号的全部私聊',exact:true})).toHaveCount(0);
 await expect(page.getByRole('checkbox')).toHaveCount(0);
 await expect(page.getByText('连接账号本身不授权聊天读取。请到「联系人」逐人确认私聊；每次确认包含该会话本机可读的历史文字和后续新消息。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'确认微信账号',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{revision:2,confirmed:true,mode:'selected',historyAuthorized:false});
 await expect(page.getByText(/账号关联已保存。请到「联系人」逐人核验/)).toBeVisible();
});
