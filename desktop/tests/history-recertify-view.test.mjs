import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {ports,contact,other,recertifyFixture,recertifyStatus,completedStatus} from './fixtures/history-recertify.mjs';

async function panel(t,f,inspect){
 const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ContactHistoryClear} from './src/renderer/HistoryClearPanel';const listeners=new Set();window.publishState=state=>listeners.forEach(fn=>fn(state));window.notalone={historyClear:{getState:()=>window.command('getState'),refresh:request=>window.command('refresh',request),clear:request=>window.command('clear',request),resync:request=>window.command('resync',request),recertify:request=>window.command('recertify',request),cancelRecertify:request=>window.command('cancelRecertify',request),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}};function App(){const [state,setState]=useState(${JSON.stringify(f.selection)});window.selectContact=(id,revision)=>setState(previous=>({...previous,selectedContactId:id,scopeRevision:revision}));return <ContactHistoryClear session={{state}}/>;}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);
 await page.exposeFunction('command',(method,request)=>f.controller[method](request));await page.route('http://127.0.0.1/recertify-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/recertify-test');
 const deliveries=[],unsubscribe=f.controller.onStateChanged(state=>{deliveries.push(page.evaluate(value=>window.publishState(value),state));});
 try{await page.addScriptTag({content:bundle.outputFiles[0].text});await inspect(page);await Promise.all(deliveries);}finally{unsubscribe();}
}
const entry=page=>page.getByRole('button',{name:'保留旧资料并重新认证来源',exact:true});
const confirm=page=>page.getByRole('button',{name:'确认保留旧资料并重新认证来源',exact:true});
test('保留旧资料认证有独立确认，无需先清空，完成只取全量启用回执',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);await panel(t,f,async page=>{
  await entry(page).click();const dialog=page.getByRole('dialog',{name:'确认保留旧资料并重新认证来源'});
  await dialog.getByText(/旧消息、来源、记忆和助手结果会保留/).waitFor();await dialog.getByText(/全部核验通过后才启用/).waitFor();
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  await entry(page).click();await confirm(page).click();await page.getByRole('status').filter({hasText:'来源重新认证完成'}).waitFor();
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/recertify'));assert.equal(f.controller.getState().clear.phase,'none');
 });
});
test('未知认证结果只查询原键，页面不会自动或再次确认创建新认证',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('alert').filter({hasText:'结果尚未确认'}).waitFor();assert.equal(await entry(page).isDisabled(),true);
  const key=f.controller.getState().pendingRecertifyKey;await page.getByRole('button',{name:'查询本次认证状态',exact:true}).click();assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  f.controls.status=completedStatus(key);await page.getByRole('button',{name:'查询本次认证状态',exact:true}).click();await page.getByRole('status').filter({hasText:'来源重新认证完成'}).waitFor();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.controller.getState().recertify.requestKey,key);
 });
});
test('认证运行阶段不冒报完成；失败中文提示后只有新确认才使用新键',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async request=>{f.controls.status=recertifyStatus({request_key:request.body.request_key,state:'running',stage:'history',message_count:2,page_count:1,preserved_message_count:7,started_at:100});return {generation:1,data:f.controls.status};};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('status').filter({hasText:'正在全量读取并核验本机历史'}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'来源重新认证完成'}).count(),0);assert.equal(await entry(page).isDisabled(),true);
  const key=f.controller.getState().recertify.requestKey;f.controls.status=recertifyStatus({request_key:key,state:'failed',stage:'history',failure_code:'history_recertify_source_changed',started_at:100,finished_at:200});
  await page.getByRole('button',{name:'查询本次认证状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'当前来源与旧资料无法可靠对应'}).waitFor();
  f.controls.post=null;await entry(page).click();await confirm(page).click();await page.getByRole('status').filter({hasText:'来源重新认证完成'}).waitFor();
  const keys=f.calls.filter(call=>call.method==='POST').map(call=>call.body.request_key);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
 });
});
test('确认页切换联系人立即关闭，不会对旧范围提交认证',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);await panel(t,f,async page=>{
  await entry(page).click();await page.getByRole('dialog',{name:'确认保留旧资料并重新认证来源'}).waitFor();
  f.select(other);await page.evaluate(({id,revision})=>window.selectContact(id,revision),{id:other,revision:f.selection.scopeRevision});
  await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 });
});

test('已观察的运行认证可明确停止，draining期间仍查询进度且不冒报已停',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.status=recertifyStatus({request_key:'recertify-external-ui',state:'running',stage:'history',started_at:100});await f.controller.refresh(f.scope);
 f.controls.cancel=async()=>({generation:1,data:f.controls.status});
 await panel(t,f,async page=>{
  await page.getByRole('button',{name:'停止本次认证',exact:true}).click();await page.getByRole('status').filter({hasText:'正在停止本次来源认证'}).waitFor();
  assert.equal(await page.getByRole('alert').filter({hasText:'本次认证已停止'}).count(),0);
  f.controls.status=recertifyStatus({request_key:'recertify-external-ui',state:'interrupted',stage:'history',failure_code:'history_recertify_cancelled',started_at:100,finished_at:200});
  await page.getByRole('button',{name:'查询本次认证状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'本次认证已停止'}).waitFor();
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/recertify/cancel'));assert.deepEqual(posts[0].body,{request_key:'recertify-external-ui'});
 });
});

test('接纳结果未知可停止原键并确认终态，新一轮仍需再次明确确认',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('alert').filter({hasText:'结果尚未确认'}).waitFor();
  const original=f.controller.getState().pendingRecertifyKey;await page.getByRole('button',{name:'停止本次认证',exact:true}).click();await page.getByRole('alert').filter({hasText:'本次认证已停止'}).waitFor();
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify')).length,1);
  f.controls.post=null;await entry(page).click();assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify')).length,1);await confirm(page).click();await page.getByRole('status').filter({hasText:'来源重新认证完成'}).waitFor();
  const admissions=f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify'));assert.equal(admissions.length,2);assert.notEqual(admissions[1].body.request_key,original);
 });
});
