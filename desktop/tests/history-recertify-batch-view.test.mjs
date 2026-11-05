import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const contact='11111111-1111-4111-8111-111111111111';
const overviewState={revision:1,phase:'idle',batchId:null,
 overview:{phase:'ready',total:3,withUnsavedImages:2,messageTotal:30,imageUnsavedTotal:5,fencedTotal:3,readEnabled:true,error:null},
 total:0,completed:0,failedByCode:{},skippedByCode:{},alreadyFixed:0,current:null,startedAt:null,finishedAt:null,stopRequested:false,
 limit:null,interruptedReason:null,aggregateComplete:null,error:null};
const clearInitial={revision:1,contactId:contact,scopeRevision:7,phase:'ready',
 clear:{contact_id:contact,phase:'none',completed:false,boundary:null,boundary_pending:false,failure_code:null,boundary_reason:null,stored_messages:3,stored_sources:1,open_goals:0},
 resync:{contact_id:contact,request_key:null,state:'none',completed:false,goal:null},
 recertify:{contact_id:contact,request_key:'recertify-previous',state:'failed',stage:'history',completed:false,failure_code:'history_recertify_source_changed',
  message_count:0,non_text_count:0,page_count:0,preserved_message_count:0,started_at:100,finished_at:200},
 pendingRecertifyKey:null,recertifyStoppingKey:null,recertifyCancelBusy:false,busy:null,error:null};

async function openPage(t,contents,{define}={}){
 const outdir=await mkdtemp(join(tmpdir(),'notalone-batch-view-'));
 const bundle=await build({stdin:{contents,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent',outdir,...(define?{define}:{})});
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<div id="root"></div>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(6000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const style=bundle.outputFiles.find(file=>file.path.endsWith('.css'));
 if(style)await page.addStyleTag({content:style.text});
 await page.addScriptTag({content:bundle.outputFiles.find(file=>file.path.endsWith('.js'))?.text??bundle.outputFiles[0].text});
 return page;
}
function panelBundle(initial,{batchMissing=false}={}){
 return `import React from 'react';
import {createRoot} from 'react-dom/client';
import {FencedRepairBatchPanel} from './src/renderer/FencedRepairBatchPanel';
const batchListeners=new Set(),clearListeners=new Set();
let batchState=${JSON.stringify(initial.batch)};
let clearState=${JSON.stringify(initial.clear)};
window.setBatchState=state=>{batchState=state;batchListeners.forEach(fn=>fn(state));};
window.setClearState=state=>{clearState=state;clearListeners.forEach(fn=>fn(state));};
window.calls=[];
window.notalone={
 historyRecertifyBatch:${batchMissing?'undefined':`{
  getState:async()=>batchState,
  refreshOverview:async()=>{window.calls.push(['refreshOverview']);},
  start:async request=>{window.calls.push(['start',request]);},
  stop:async()=>{window.calls.push(['stop']);},
  onStateChanged:fn=>{batchListeners.add(fn);return()=>batchListeners.delete(fn);}}`},
 historyClear:{getState:async()=>clearState,onStateChanged:fn=>{clearListeners.add(fn);return()=>clearListeners.delete(fn);}}};
createRoot(document.getElementById('root')).render(<FencedRepairBatchPanel/>);`;
}
const startButton=page=>page.getByRole('button',{name:'开始批量修复',exact:true});
const dialog=page=>page.getByRole('dialog',{name:'确认批量修复'});

test('概览显示候选数量与读取量；确认弹窗写明范围、顺序、读取、撤下旧资料、不调用模型、不提取媒体、可停止与失败原因码', {timeout:30000}, async t=>{
 const page=await openPage(t,panelBundle({batch:overviewState,clear:clearInitial}));
 await page.getByText(/当前被围栏且有有效读取授权的联系人/).waitFor();
 assert.match(await page.getByRole('status').first().innerText(),/3 位（其中有未保存图片 2 位）/);
 assert.match(await page.getByRole('status').first().innerText(),/预计需重新读取消息 30 条/);
 assert.match(await page.getByRole('status').first().innerText(),/补查未保存图片 5 张/);
 assert.equal(await startButton(page).isEnabled(),true);
 await startButton(page).click();
 const confirm=dialog(page);
 await confirm.getByText(/未保存图片多的先修、图片数相同时消息少的先修/).waitFor();
 await confirm.getByText(/依次修复这次快照中的 3 位/).waitFor();
 await confirm.getByText(/重新读取电脑上当前可读的全部历史/).waitFor();
 await confirm.getByText(/旧资料会暂时撤下/).waitFor();
 await confirm.getByText(/不会调用模型，也不会提取图片等媒体内容/).waitFor();
 await confirm.getByText(/可以随时停止/).waitFor();
 await confirm.getByText(/整体停下并显示原因码/).waitFor();
 await confirm.getByText(/开发模式下改动源码会触发重启并中断修复/).waitFor();
 await confirm.getByRole('button',{name:'取消',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).filter(([kind])=>kind!=='refreshOverview'),[]);
 await startButton(page).click();
 await confirm.getByRole('button',{name:'确认修复 3 位',exact:true}).click();
 const calls=(await page.evaluate(()=>window.calls)).filter(([kind])=>kind!=='refreshOverview');
 assert.deepEqual(calls,[['start',{limit:5,confirmed:true}]]);
});

test('本次最多修复输入与“全部”影响确认范围', {timeout:30000}, async t=>{
 const page=await openPage(t,panelBundle({batch:overviewState,clear:clearInitial}));
 await page.getByLabel('本次最多修复数量').waitFor();
 await page.getByLabel('本次最多修复数量').fill('2');
 await startButton(page).click();
 await dialog(page).getByRole('button',{name:'确认修复 2 位',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).filter(([kind])=>kind!=='refreshOverview'),[['start',{limit:2,confirmed:true}]]);
});

test('运行中显示进度、阶段、失败码分布与停止；停止期间不谎报已停', {timeout:30000}, async t=>{
 const page=await openPage(t,panelBundle({batch:overviewState,clear:clearInitial}));
 await page.getByLabel('本次最多修复数量').waitFor();
 const running={...overviewState,revision:2,phase:'running',total:3,completed:1,current:{index:2,stage:'history',messageCount:12,pageCount:3,startedAt:1000},
  failedByCode:{history_recertify_source_changed:1},skippedByCode:{history_recertify_page_limit:1},startedAt:900};
 await page.evaluate(state=>window.setBatchState(state),running);
 await page.getByText(/批量修复进行中：已完成 1 \/ 3 位/).waitFor();
 await page.getByText(/正在处理第 2 位（正在重新读取并检查电脑上的微信历史）/).waitFor();
 await page.getByText(/来源与旧资料无法可靠对应，需人工处理/).waitFor();
 await page.getByText(/未能在页数上限内完成全部历史核验/).waitFor();
 await page.getByRole('button',{name:'停止批量修复',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).filter(([kind])=>kind!=='refreshOverview'),[['stop']]);
 await page.evaluate(state=>window.setBatchState(state),{...running,revision:3,phase:'stopping',stopRequested:true});
 await page.getByText(/正在停止批量修复…/).waitFor();
 await page.getByText(/正在取消当前联系人并等待确认终态/).waitFor();
 assert.equal(await page.getByRole('button',{name:'正在停止批量修复…',exact:true}).isDisabled(),true);
});

test('结束时显示汇总与再次修复剩余；中断时显示原因码且不自动恢复', {timeout:30000}, async t=>{
 const page=await openPage(t,panelBundle({batch:overviewState,clear:clearInitial}));
 await page.getByLabel('本次最多修复数量').waitFor();
 const finished={...overviewState,revision:4,phase:'finished',total:3,completed:2,alreadyFixed:1,
  failedByCode:{history_recertify_stalled:1},skippedByCode:{history_recertify_deletion_pending:1},startedAt:1000,finishedAt:3500,limit:5,aggregateComplete:7};
 await page.evaluate(state=>window.setBatchState(state),finished);
 await page.getByText(/批量修复结束。/).waitFor();
 assert.match(await page.getByRole('status').last().innerText(),/完成 2 位，失败 1 位，跳过 1 位，启动时已不再围栏 1 位，用时 2.5 秒/);
 await page.getByText(/进度长时间无变化，已取消并确认终态/).waitFor();
 assert.equal(await page.getByRole('button',{name:'再次修复剩余',exact:true}).isEnabled(),true);
 const interrupted={...finished,revision:5,phase:'interrupted',interruptedReason:'read_not_authorized'};
 await page.evaluate(state=>window.setBatchState(state),interrupted);
 await page.getByRole('alert').filter({hasText:'同步已关闭或授权已撤销'}).waitFor();
 await page.getByText(/重跑只会处理仍被围栏的联系人/).waitFor();
});

test('单操作进行中禁用开始并说明原因；打包态没有批量桥时只显示不可用说明', {timeout:30000}, async t=>{
 const page=await openPage(t,panelBundle({batch:overviewState,clear:clearInitial}));
 await page.getByLabel('本次最多修复数量').waitFor();
 await page.evaluate(state=>window.setClearState({...state,recertify:{...state.recertify,state:'running',request_key:'recertify-running',completed:false,failure_code:null,finished_at:null}}),clearInitial);
 await page.getByText(/联系人页有单个修复或清空操作正在进行/).waitFor();
 assert.equal(await startButton(page).isDisabled(),true);

 const packaged=await openPage(t,panelBundle({batch:overviewState,clear:clearInitial},{batchMissing:true}));
 await packaged.getByText('批量修复入口仅在开发模式可用。').waitFor();
 assert.equal(await startButton(packaged).count(),0);
});

test('批量运行期间单个联系人修复与清空入口禁用并说明原因', {timeout:30000}, async t=>{
 const running={...overviewState,revision:2,phase:'running',total:1,startedAt:1000,current:{index:1,stage:'history',messageCount:1,pageCount:1,startedAt:1000}};
 const contents=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {ContactHistoryClear} from './src/renderer/HistoryClearPanel';
const batchListeners=new Set(),clearListeners=new Set();
let batchState=${JSON.stringify(running)};
let clearState=${JSON.stringify(clearInitial)};
window.setBatchState=state=>{batchState=state;batchListeners.forEach(fn=>fn(state));};
window.notalone={
 historyRecertifyBatch:{getState:async()=>batchState,refreshOverview:async()=>{},start:async()=>{},stop:async()=>{},
  onStateChanged:fn=>{batchListeners.add(fn);return()=>batchListeners.delete(fn);}},
 historyClear:{getState:async()=>clearState,refresh:async()=>{},clear:async()=>{},resync:async()=>{},recertify:async()=>{},cancelRecertify:async()=>{},
  onStateChanged:fn=>{clearListeners.add(fn);return()=>clearListeners.delete(fn);}}};
const session={state:{selectedContactId:${JSON.stringify(contact)},scopeRevision:7,directoryPhase:'ready',contacts:[{contactId:${JSON.stringify(contact)},displayName:'合成联系人'}]}};
createRoot(document.getElementById('root')).render(<ContactHistoryClear session={session} repairNeeded/>);`;
 const page=await openPage(t,contents);
 await page.getByText(/开发者批量修复正在进行/).waitFor();
 assert.equal(await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'修复同步',exact:true}).isDisabled(),true);
 await page.evaluate(()=>window.setBatchState({revision:3,phase:'idle',batchId:null,
  overview:{phase:'ready',total:0,withUnsavedImages:0,messageTotal:0,imageUnsavedTotal:0,fencedTotal:0,readEnabled:true,error:null},
  total:0,completed:0,failedByCode:{},skippedByCode:{},alreadyFixed:0,current:null,startedAt:null,finishedAt:null,stopRequested:false,limit:null,interruptedReason:null,aggregateComplete:null,error:null}));
 await page.getByText(/开发者批量修复正在进行/).waitFor({state:'detached'});
 assert.equal(await page.getByRole('button',{name:'清空已保存的聊天',exact:true}).isEnabled(),true);
});

test('开发者调试区只在 import.meta.env.DEV 时渲染批量修复面板', {timeout:30000}, async t=>{
 const contents=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {DeveloperTraces} from './src/renderer/DeveloperTraces';
const listeners=new Set();
window.notalone={quarantine:{list:async()=>[]},
 historyRecertifyBatch:{getState:async()=>({revision:0,phase:'idle',batchId:null,
  overview:{phase:'idle',total:0,withUnsavedImages:0,messageTotal:0,imageUnsavedTotal:0,fencedTotal:0,readEnabled:false,error:null},
  total:0,completed:0,failedByCode:{},skippedByCode:{},alreadyFixed:0,current:null,startedAt:null,finishedAt:null,stopRequested:false,limit:null,interruptedReason:null,aggregateComplete:null,error:null}),
  refreshOverview:async()=>{},start:async()=>{},stop:async()=>{},onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},
 historyClear:{getState:async()=>({revision:0,contactId:null,scopeRevision:0,phase:'idle',clear:null,resync:null,recertify:null,pendingRecertifyKey:null,recertifyStoppingKey:null,recertifyCancelBusy:false,busy:null,error:null}),onStateChanged:()=>()=>{}}};
const session={state:{selectedContactId:null,scopeRevision:0,directoryPhase:'ready',contacts:[]},error:null};
createRoot(document.getElementById('root')).render(<DeveloperTraces session={session}/>);`;
 const dev=await openPage(t,contents,{define:{'import.meta.env.DEV':'true'}});
 await dev.getByText('开发者调试',{exact:true}).click();
 await dev.getByRole('heading',{name:'批量修复同步（开发模式）'}).waitFor();
 const packaged=await openPage(t,contents,{define:{'import.meta.env.DEV':'false'}});
 await packaged.getByText('开发者调试',{exact:true}).click();
 await packaged.getByText('排查记忆提取与资料处理问题。').waitFor();
 assert.equal(await packaged.getByRole('heading',{name:'批量修复同步（开发模式）'}).count(),0);
});
