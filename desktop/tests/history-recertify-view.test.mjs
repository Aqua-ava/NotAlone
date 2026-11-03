import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {ports,contact,other,recertifyFixture,recertifyStatus,completedStatus} from './fixtures/history-recertify.mjs';

async function panel(t,f,inspect,{repairNeeded=false}={}){
 const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ContactHistoryClear} from './src/renderer/HistoryClearPanel';const listeners=new Set();window.publishState=state=>listeners.forEach(fn=>fn(state));window.notalone={historyClear:{getState:()=>window.command('getState'),refresh:request=>window.command('refresh',request),clear:request=>window.command('clear',request),resync:request=>window.command('resync',request),recertify:request=>window.command('recertify',request),cancelRecertify:request=>window.command('cancelRecertify',request),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}};function App(){const [state,setState]=useState(${JSON.stringify(f.selection)});const [repairNeeded,setRepairNeeded]=useState(${repairNeeded});window.setRepairNeeded=setRepairNeeded;window.selectContact=(id,revision)=>setState(previous=>({...previous,selectedContactId:id,scopeRevision:revision}));return <ContactHistoryClear session={{state}} repairNeeded={repairNeeded}/>;}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(6000);
 await page.exposeFunction('command',(method,request)=>f.controller[method](request));await page.route('http://127.0.0.1/recertify-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/recertify-test');
 const deliveries=[],unsubscribe=f.controller.onStateChanged(state=>{deliveries.push(page.evaluate(value=>window.publishState(value),state));});
 try{await page.addScriptTag({content:bundle.outputFiles[0].text});await inspect(page);await Promise.all(deliveries);}finally{unsubscribe();}
}
const entry=page=>page.getByRole('button',{name:'修复同步',exact:true});
const confirm=page=>page.getByRole('button',{name:'确认修复同步',exact:true});
const retry=page=>page.getByRole('button',{name:'重试读取进度',exact:true});
const clearStatus=(phase='none',overrides={})=>({contact_id:contact,phase,completed:phase==='completed',boundary:null,boundary_pending:phase==='boundary_pending',failure_code:null,boundary_reason:null,stored_messages:7,stored_sources:7,open_goals:0,...overrides});

test('健康联系人只保留清空入口，没有手动刷新或未开放的历史重读',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);await panel(t,f,async page=>{
  await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).waitFor();
  assert.equal(await entry(page).count(),0);assert.equal(await page.getByRole('region',{name:'修复同步',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/刷新清空状态|查询本次认证状态|重新同步历史/}).count(),0);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 });
});

test('初始读到历史完成记录时不显示修复区',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.status=completedStatus('recertify-previous');await f.controller.refresh(f.scope);
 await panel(t,f,async page=>{
  await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).waitFor();
  assert.equal(await page.getByRole('region',{name:'修复同步',exact:true}).count(),0);assert.equal(await entry(page).count(),0);
 });
});

test('来源异常才显示修复，保留旧资料的独立确认后才发请求并显示本次成功',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);await panel(t,f,async page=>{
  await entry(page).click();const dialog=page.getByRole('dialog',{name:'确认修复同步'});
  await dialog.getByText(/旧聊天、来源记录、记忆和助手结果都会保留/).waitFor();await dialog.getByText(/全部检查通过后才恢复同步/).waitFor();
  await dialog.getByText(/不会自动整理关系资料或记忆/).waitFor();await dialog.getByText(/无法确认来源的记忆和助手结果不会自动恢复使用/).waitFor();
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  await entry(page).click();await confirm(page).click();await page.getByRole('status').filter({hasText:'同步修复完成'}).waitFor();
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/recertify'));assert.equal(f.controller.getState().clear.phase,'none');
  await page.evaluate(()=>window.setRepairNeeded(false));await entry(page).waitFor({state:'detached'});
  await page.getByRole('status').filter({hasText:'同步修复完成'}).waitFor();
 },{repairNeeded:true});
});

test('未知修复结果只重试查询原键，不会创建第二次修复',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('alert').filter({hasText:'还没确认本次修复的结果'}).waitFor();assert.equal(await entry(page).isDisabled(),true);
  const key=f.controller.getState().pendingRecertifyKey;await retry(page).click();await page.getByRole('alert').filter({hasText:'还没确认本次修复的结果'}).waitFor();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.controller.getState().pendingRecertifyKey,key);
  const lookups=f.calls.filter(call=>call.method==='GET'&&call.path.includes('/recertify?'));assert.ok(lookups.every(call=>new URL(call.path,'http://synthetic.local').searchParams.get('request_key')===key));
  f.controls.status=completedStatus(key);await retry(page).click();await page.getByRole('status').filter({hasText:'同步修复完成'}).waitFor();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.controller.getState().recertify.requestKey,key);
 },{repairNeeded:true});
});

test('修复运行进度自动查询，失败后只有再次确认才使用新键',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async request=>{f.controls.status=recertifyStatus({request_key:request.body.request_key,state:'running',stage:'history',message_count:2,page_count:1,preserved_message_count:7,started_at:100});return {generation:1,data:f.controls.status};};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('status').filter({hasText:'正在重新读取并检查电脑上的微信历史'}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'同步修复完成'}).count(),0);assert.equal(await entry(page).isDisabled(),true);
  const key=f.controller.getState().recertify.requestKey;f.controls.status=recertifyStatus({request_key:key,state:'failed',stage:'history',failure_code:'history_recertify_source_changed',started_at:100,finished_at:200});
  await page.getByRole('alert').filter({hasText:'现在的微信历史与旧资料对不上'}).waitFor();assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  f.controls.post=null;await entry(page).click();assert.equal(f.calls.filter(call=>call.method==='POST').length,1);await confirm(page).click();await page.getByRole('status').filter({hasText:'同步修复完成'}).waitFor();
  const keys=f.calls.filter(call=>call.method==='POST').map(call=>call.body.request_key);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
 },{repairNeeded:true});
});

test('确认页切换联系人立即关闭，不会对旧范围提交修复',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);await panel(t,f,async page=>{
  await entry(page).click();await page.getByRole('dialog',{name:'确认修复同步'}).waitFor();
  f.select(other);await page.evaluate(({id,revision})=>window.selectContact(id,revision),{id:other,revision:f.selection.scopeRevision});
  await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 },{repairNeeded:true});
});

test('已观察的运行修复可以停止，收尾期间自动查询且不冒报已停',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.status=recertifyStatus({request_key:'recertify-external-ui',state:'running',stage:'history',started_at:100});await f.controller.refresh(f.scope);
 f.controls.cancel=async()=>({generation:1,data:f.controls.status});
 await panel(t,f,async page=>{
  await page.getByRole('button',{name:'停止本次修复',exact:true}).click();await page.getByRole('status').filter({hasText:'正在停止本次修复'}).waitFor();
  assert.equal(await page.getByRole('alert').filter({hasText:'已停止本次修复'}).count(),0);
  f.controls.status=recertifyStatus({request_key:'recertify-external-ui',state:'interrupted',stage:'history',failure_code:'history_recertify_cancelled',started_at:100,finished_at:200});
  await page.getByRole('alert').filter({hasText:'已停止本次修复'}).waitFor();
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/recertify/cancel'));assert.deepEqual(posts[0].body,{request_key:'recertify-external-ui'});
 });
});

test('接纳结果未知时可停止原键，新一轮仍需再次明确确认',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('alert').filter({hasText:'还没确认本次修复的结果'}).waitFor();
  const original=f.controller.getState().pendingRecertifyKey;await page.getByRole('button',{name:'停止本次修复',exact:true}).click();await page.getByRole('alert').filter({hasText:'已停止本次修复'}).waitFor();
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify')).length,1);
  f.controls.post=null;await entry(page).click();assert.equal(f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify')).length,1);await confirm(page).click();await page.getByRole('status').filter({hasText:'同步修复完成'}).waitFor();
  const admissions=f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify'));assert.equal(admissions.length,2);assert.notEqual(admissions[1].body.request_key,original);
 },{repairNeeded:true});
});

test('读取修复进度失败后保留原键，明确重试只查询并恢复自动进度',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.status=recertifyStatus({request_key:'recertify-read-failure',state:'running',stage:'history',started_at:100});await f.controller.refresh(f.scope);
 const original=f.backend.requestJson;let failReads=true;
 f.backend.requestJson=request=>request.method==='GET'&&failReads?Promise.reject(new ports.BackendRequestFailure('connection')):original(request);
 await panel(t,f,async page=>{
  await page.getByRole('alert').filter({hasText:'暂时读不到操作进度'}).waitFor();assert.equal(f.controller.getState().pendingRecertifyKey,'recertify-read-failure');assert.equal(await entry(page).count(),0);
  failReads=false;await retry(page).click();await page.getByRole('status').filter({hasText:'正在重新读取并检查电脑上的微信历史'}).waitFor();
  f.controls.status=completedStatus('recertify-read-failure');await page.getByRole('status').filter({hasText:'同步修复完成'}).waitFor();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  assert.equal(f.controller.getState().recertify.requestKey,'recertify-read-failure');
 });
});

test('资料状态读取失败提供重试，不需要清空或修复才能恢复显示',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);const original=f.backend.requestJson;f.backend.requestJson=async()=>{throw new ports.BackendRequestFailure('connection');};await f.controller.refresh(f.scope);
 await panel(t,f,async page=>{
  await retry(page).waitFor();assert.equal(await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).isDisabled(),true);
  f.backend.requestJson=original;await retry(page).click();await retry(page).waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).isDisabled(),false);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 });
});

test('清空先确认影响范围，清理进度自动更新且不重复提交',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);const original=f.backend.requestJson;let status=clearStatus();
 f.backend.requestJson=async request=>{if(!request.path.endsWith('/clear'))return original(request);f.calls.push(request);if(request.method==='POST')status=clearStatus('cleaning');return {generation:1,data:status};};
 await panel(t,f,async page=>{
  await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).click();const dialog=page.getByRole('dialog',{name:'确认清空聊天'});
  await dialog.getByText(/NotAlone 中保存的聊天、来源记录/).waitFor();await dialog.getByText(/微信里的聊天和电脑上的原始文件不会删除/).waitFor();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  await dialog.getByRole('button',{name:'确认清空聊天',exact:true}).click();await page.getByRole('status').filter({hasText:'进度会自动更新'}).waitFor();
  status=clearStatus('completed');await page.getByRole('status').filter({hasText:'已清空这位联系人在 NotAlone'}).waitFor();
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/clear'));
 });
});

test('清空未完成显示继续清空，明确确认后才继续原操作',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);const original=f.backend.requestJson;
 f.backend.requestJson=async request=>{if(!request.path.endsWith('/clear'))return original(request);f.calls.push(request);return {generation:1,data:clearStatus('cleanup_blocked')};};await f.controller.refresh(f.scope);
 await panel(t,f,async page=>{
  await page.getByRole('button',{name:'继续清空',exact:true}).click();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  await page.getByRole('button',{name:'确认清空聊天',exact:true}).click();await page.getByRole('status').filter({hasText:'还有相关资料没有清理完'}).waitFor();assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 });
});


test('重启后留下的清理中状态可以明确继续，查询本身不重发清空',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);const original=f.backend.requestJson;let phase='cleaning';
 f.backend.requestJson=async request=>{if(!request.path.endsWith('/clear'))return original(request);f.calls.push(request);if(request.method==='POST')phase='completed';return {generation:1,data:clearStatus(phase)};};await f.controller.refresh(f.scope);
 await panel(t,f,async page=>{
  await page.getByRole('button',{name:'继续清空',exact:true}).click();assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  await page.getByRole('button',{name:'确认清空聊天',exact:true}).click();await page.getByRole('status').filter({hasText:'已清空这位联系人在 NotAlone'}).waitFor();assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 });
});


test('历史修复失败可以查看结果，但当前不允许修复时没有新修复入口',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.status=recertifyStatus({request_key:'recertify-old-failure',state:'failed',stage:'history',failure_code:'history_recertify_source_changed',started_at:100,finished_at:200});await f.controller.refresh(f.scope);
 await panel(t,f,async page=>{
  await page.getByRole('alert').filter({hasText:'现在的微信历史与旧资料对不上'}).waitFor();assert.equal(await entry(page).count(),0);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 });
});

test('确认中修复条件消失立即收起对话框，条件恢复也不会沿用旧确认',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);await panel(t,f,async page=>{
  await entry(page).click();await page.getByRole('dialog',{name:'确认修复同步'}).waitFor();
  await page.evaluate(()=>window.setRepairNeeded(false));await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await entry(page).count(),0);
  await page.evaluate(()=>window.setRepairNeeded(true));await entry(page).waitFor();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 },{repairNeeded:true});
});

test('修复条件消失后仍能停止未知原请求，不会因此开放新修复',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await panel(t,f,async page=>{
  await entry(page).click();await confirm(page).click();await page.getByRole('alert').filter({hasText:'还没确认本次修复的结果'}).waitFor();const key=f.controller.getState().pendingRecertifyKey;
  await page.evaluate(()=>window.setRepairNeeded(false));await entry(page).waitFor({state:'detached'});
  await page.getByRole('button',{name:'停止本次修复',exact:true}).click();await page.getByRole('alert').filter({hasText:'已停止本次修复'}).waitFor();
  assert.equal(await entry(page).count(),0);const cancelled=f.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/recertify/cancel'));assert.equal(cancelled.length,1);assert.equal(cancelled[0].body.request_key,key);
 },{repairNeeded:true});
});

test('普通重读入口隐藏后仍可查看已存在的重读结果',{timeout:20000},async t=>{
 const f=await recertifyFixture(t);const original=f.backend.requestJson;
 f.backend.requestJson=async request=>request.path.endsWith('/resync')?{generation:1,data:{contact_id:contact,request_key:'resync-previous',state:'completed',completed:true,goal:{phase:'complete',message_count:4,non_text_count:1,failure_code:null}}}:original(request);await f.controller.refresh(f.scope);
 await panel(t,f,async page=>{
  await page.getByRole('status').filter({hasText:'重新同步完成：已恢复 4 条文字记录'}).waitFor();assert.equal(await page.getByRole('button',{name:'重新同步历史',exact:true}).count(),0);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 });
});
