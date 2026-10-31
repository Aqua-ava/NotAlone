import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const ids={run:'11111111-1111-4111-8111-111111111111',task:'22222222-2222-4222-8222-222222222222',contact:'33333333-3333-4333-8333-333333333333'};
const run=()=>({runId:ids.run,state:'incomplete',total:1,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',status:'blocked',statusReason:'later_stages_pending',sharedFaultCode:null,actions:[],controlVersion:0,pending:0,revoked:0,calls:{prepared:0,sending:0,succeeded:4,failed:0,unknown:0},
 tasks:[{taskId:ids.task,scopeKind:'contact',contactId:ids.contact,state:'succeeded',total:1,succeeded:1,errorCode:null}],inputs:[],candidates:[]});
async function withPanel(t,command,testPage){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FixedMemoryProcessingPanel} from './src/renderer/FixedMemoryProcessingPanel';
 const listeners=new Set();window.invalidate=()=>{for(const listener of listeners)listener();};const bridge=new Proxy({},{get:(_,method)=>method==='onInvalidated'?(listener)=>{listeners.add(listener);return()=>listeners.delete(listener);}:(...args)=>window.command(method,...args)});const root=createRoot(document.getElementById('root'));window.show=visible=>root.render(visible?<FixedMemoryProcessingPanel bridge={bridge}/>:null);window.show(true);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);
 await page.exposeFunction('command',command);await page.route('http://127.0.0.1/fixed-memory-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/fixed-memory-test');await page.addScriptTag({content:compiled.outputFiles[0].text});await testPage(page);
}
// 回到可见页面走正式的自动状态读取，不通过已移除的刷新按钮。
const revisit=page=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));

test('无轮次显示等待，卡片只读状态与进度，不启动或控制任务', {timeout:20000},async t=>{
 let current=null;const methods=[];
 await withPanel(t,async method=>{methods.push(method);if(method==='readCurrent')return {connectionGeneration:1,run:current};},async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('status').filter({hasText:'等待处理'}).waitFor();
  await panel.getByText('暂无处理记录',{exact:true}).waitFor();
  const projections=[
   {status:'waiting',state:'pending',stage:'extraction_verification',text:'等待提取与核验'},
   {status:'processing',state:'running',stage:'extraction_verification',text:'正在提取与核验'},
   {status:'paused',state:'paused',stage:'document_profile',text:'已暂停'},
   {status:'blocked',state:'incomplete',stage:'document_scene',text:'处理受阻'},
   {status:'completed',state:'completed',stage:'completed',text:'本轮已完成'},
  ];
  for(const projection of projections){
   current={...run(),...projection,total:2,succeeded:1,actions:['pause','continue'],laterStages:projection.status==='completed'?'completed':'pending',candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'不在状态卡重复展示的合成候选',state:'verified_pending_decision',origin:'auto'}]};
   await revisit(page);await panel.getByRole('status').filter({hasText:projection.text}).waitFor();
   assert.equal(await panel.getByRole('button').count(),0);
   assert.equal(await panel.getByText('不在状态卡重复展示的合成候选',{exact:true}).count(),0);
   assert.equal(await panel.locator('pre, details').count(),0);
  }
  assert.equal(methods.every(method=>method==='readCurrent'),true,'查看进度不得启动、暂停、继续或读取过程正文');
 });
});

test('处理中自动更新真实计数，提取全部结束仍不冒充整轮完成', {timeout:20000},async t=>{
 let current={...run(),status:'processing',state:'running',total:3,succeeded:1,pending:2};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('提取与核验：已处理 1 / 3 条文字目标',{exact:true}).waitFor();
  const progress=panel.getByRole('progressbar',{name:'文字提取与核验进度'});
  assert.equal(await progress.getAttribute('value'),'1');assert.equal(await progress.getAttribute('max'),'3');
  current={...current,succeeded:3,pending:0};
  await panel.getByText('提取与核验：已处理 3 / 3 条文字目标',{exact:true}).waitFor();
  assert.equal(await progress.getAttribute('value'),'3');
  await panel.getByText('主题整理、长期概览尚未全部完成。',{exact:true}).waitFor();
  assert.equal(await panel.getByText('本轮已完成',{exact:true}).count(),0);
 });
});

test('无产出成功独立于后续阶段，来源失效不冒充无产出成功', {timeout:20000},async t=>{
 let current=run();
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('已处理，未产生新记忆',{exact:true}).waitFor();
  current={...run(),statusReason:'scope_revoked',revoked:1,tasks:run().tasks.map(task=>({...task,state:'revoked'}))};
  await revisit(page);await panel.getByText('范围已失效',{exact:true}).waitFor();
  assert.equal(await panel.getByText('已处理，未产生新记忆',{exact:true}).count(),0);
  assert.equal(await panel.getByText('本轮已完成',{exact:true}).count(),0);
 });
});

test('失效立即清除进度，旧读取迟到不能恢复快照，随后自动重新核验', {timeout:20000},async t=>{
 let mode='initial',release,started;
 const pending=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{started=resolve;});
 await withPanel(t,async method=>{
  if(method==='readCurrent'){
   if(mode==='late'){started();return pending;}
   if(mode==='denied')throw new Error('synthetic_deleted');
   return {connectionGeneration:1,run:run()};
  }
 },async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('progressbar').waitFor();mode='late';await revisit(page);await entered;
  mode='denied';await page.evaluate(()=>window.invalidate());
  await panel.getByRole('alert').filter({hasText:'资料资格或连接已变化'}).waitFor();
  release({connectionGeneration:1,run:{...run(),total:99,succeeded:99}});
  assert.equal(await panel.getByRole('progressbar').count(),0);
  assert.equal(await panel.getByRole('status').count(),0);
  await panel.getByRole('alert').filter({hasText:'处理状态暂不可用'}).waitFor();
  assert.equal(await panel.getByText('提取与核验：已处理 99 / 99 条文字目标',{exact:true}).count(),0);
  mode='initial';await revisit(page);await panel.getByRole('progressbar').waitFor();
  assert.equal(await panel.getByRole('alert').count(),0);
 });
});

test('状态读取失败撤下快照，回到页面可自动恢复且不改写任务', {timeout:20000},async t=>{
 let denied=false;
 await withPanel(t,async method=>{if(method==='readCurrent'){if(denied)throw new Error('synthetic_failure');return {connectionGeneration:1,run:run()};}},async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});await panel.getByRole('progressbar').waitFor();
  denied=true;await revisit(page);await panel.getByRole('alert').filter({hasText:'正在自动重试'}).waitFor();
  assert.equal(await panel.getByRole('status').count(),0);assert.equal(await panel.getByRole('progressbar').count(),0);
  denied=false;await revisit(page);await panel.getByRole('progressbar').waitFor();
  assert.equal(await panel.getByRole('button').count(),0);
 });
});

test('共用故障原因只显示一处，未知回执保留受阻状态', {timeout:20000},async t=>{
 let current={...run(),statusReason:'model_receipt_unknown',sharedFaultCode:'document_model_unconfigured',unknown:1,calls:{prepared:0,sending:0,succeeded:0,failed:0,unknown:1}};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:2,run:current}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('调用结果待核实',{exact:true}).waitFor();
  assert.equal((await panel.innerText()).match(/模型配置或服务不可用/g)?.length,1);
  current={...current,statusReason:'document_model_unconfigured',unknown:0};await revisit(page);
  await panel.getByText('模型配置或服务不可用：模型尚未配置。',{exact:true}).waitFor();
  assert.equal((await panel.innerText()).match(/模型配置或服务不可用/g)?.length,1);
  await panel.getByRole('status').filter({hasText:'处理受阻'}).waitFor();
  assert.equal(await panel.getByRole('button').count(),0);
 });
});

test('主题与概览阶段自动更新，全部阶段完成后才显示整轮完成', {timeout:20000},async t=>{
 let current={...run(),status:'processing',state:'running',stage:'document_scene'};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('status').filter({hasText:'正在整理主题资料'}).waitFor();
  current={...current,stage:'document_profile'};
  await panel.getByRole('status').filter({hasText:'正在整理长期概览'}).waitFor();
  current={...current,status:'completed',state:'completed',stage:'completed',laterStages:'completed'};
  await panel.getByRole('status').filter({hasText:'本轮已完成'}).waitFor();
  await panel.getByText('主题整理与长期概览已完成。',{exact:true}).waitFor();
 });
});
