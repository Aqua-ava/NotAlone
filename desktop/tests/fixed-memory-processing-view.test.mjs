import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const ids={run:'11111111-1111-4111-8111-111111111111',task:'22222222-2222-4222-8222-222222222222',contact:'33333333-3333-4333-8333-333333333333'};
const run=()=>({runId:ids.run,state:'incomplete',total:1,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',status:'blocked',statusReason:'later_stages_pending',actions:[],controlVersion:0,pending:0,revoked:0,calls:{prepared:0,sending:0,succeeded:4,failed:0,unknown:0},
 tasks:[{taskId:ids.task,scopeKind:'contact',contactId:ids.contact,state:'succeeded',total:1,succeeded:1,errorCode:null}],inputs:[],candidates:[]});
async function withPanel(t,command,testPage){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FixedMemoryProcessingPanel} from './src/renderer/FixedMemoryProcessingPanel';
 const listeners=new Set();window.invalidate=()=>{for(const listener of listeners)listener();};const bridge=new Proxy({},{get:(_,method)=>method==='onInvalidated'?(listener)=>{listeners.add(listener);return()=>listeners.delete(listener);}:(...args)=>window.command(method,...args)});const root=createRoot(document.getElementById('root'));window.show=visible=>root.render(visible?<FixedMemoryProcessingPanel bridge={bridge}/>:null);window.show(true);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);
 await page.exposeFunction('command',command);await page.route('http://127.0.0.1/fixed-memory-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/fixed-memory-test');await page.addScriptTag({content:compiled.outputFiles[0].text});await testPage(page);
}
test('无产出成功独立于后续阶段，失效通知立即撤下候选及过程正文', {timeout:20000},async t=>{
 let current=run();
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:method==='trace'?{events:[{eventId:ids.task,attemptId:ids.task,kind:'request',payload:{input:'合成过程输入',output:'合成过程返回'},callId:null,inputNos:[1],sources:[{contactId:ids.contact,recordId:ids.task}]}],calls:[]}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('已处理，未产生新记忆',{exact:true}).waitFor();await panel.getByText('主题整理、长期概览尚未全部完成。',{exact:true}).waitFor();assert.equal(await panel.getByText('本轮已完成',{exact:true}).count(),0);
  current={...run(),candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'合成候选正文',state:'verified_pending_decision',origin:'auto'}]};
  await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await panel.getByText('合成候选正文',{exact:true}).waitFor();await panel.getByText('以下候选来自自动提取，正式记忆与决定请查看下方。',{exact:true}).waitFor();assert.equal(await panel.getByText('以下候选来自自动提取，等待正式记忆裁决。',{exact:true}).count(),0);
  await panel.locator('summary').filter({hasText:'查看本轮任务'}).click();await panel.getByRole('button',{name:'查看联系人 1过程',exact:true}).click();
  await panel.locator('summary').filter({hasText:'request'}).click();await panel.locator('pre').filter({hasText:'合成过程输入'}).waitFor();
  await page.evaluate(()=>window.invalidate());await panel.getByRole('alert').waitFor();assert.equal(await panel.getByText('合成候选正文',{exact:true}).count(),0);assert.equal(await panel.locator('pre').filter({hasText:'合成过程输入'}).count(),0);
 });
});
test('旧页迟到正文不能填回，新读取失败撤下快照，unknown不展示继续', {timeout:20000},async t=>{
 let mode='initial',release,started;
 const pending=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{started=resolve;});
 await withPanel(t,async method=>{
  if(method==='readCurrent'){
   if(mode==='late'){started();return pending;}
   if(mode==='denied')throw new Error('synthetic_deleted');
   return {connectionGeneration:1,run:{...run(),state:'failed',succeeded:0,unknown:1,status:'blocked',statusReason:'model_receipt_unknown',actions:[],pending:0,calls:{prepared:0,sending:0,succeeded:1,failed:0,unknown:1},candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'合法候选快照',state:'verified_pending_decision',origin:'auto'}]}};
  }
 },async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('合法候选快照',{exact:true}).waitFor();await panel.getByText('调用结果待核实',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'继续原任务',exact:true}).count(),0);
  mode='denied';await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await panel.getByRole('alert').waitFor();assert.equal(await panel.getByText('合法候选快照',{exact:true}).count(),0);
  mode='late';await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await entered;await page.evaluate(()=>window.invalidate());release({connectionGeneration:1,run:{...run(),status:'blocked',statusReason:'model_receipt_unknown',actions:[],pending:0,calls:{prepared:0,sending:0,succeeded:1,failed:0,unknown:1},candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'不得恢复旧正文',state:'verified_pending_decision',origin:'auto'}]}});
  await panel.getByRole('alert').waitFor();assert.equal(await panel.getByText('不得恢复旧正文',{exact:true}).count(),0);
 });
});
test('同轮unknown只封对应任务，其他failed或paused目标可沿原run继续，已无目标不展示继续', {timeout:20000},async t=>{
 const otherTask='55555555-5555-4555-8555-555555555555',otherContact='66666666-6666-4666-8666-666666666666';
 const blocked={taskId:ids.task,scopeKind:'contact',contactId:ids.contact,state:'unknown',total:1,succeeded:0,errorCode:'memory_extraction_receipt_unknown'};
 const retryable={taskId:otherTask,scopeKind:'contact',contactId:otherContact,state:'failed',total:1,succeeded:0,errorCode:'memory_extraction_source_insufficient'};
 let current={...run(),state:'incomplete',total:2,succeeded:0,failed:1,unknown:1,status:'blocked',statusReason:'model_receipt_unknown',actions:['continue'],pending:0,revoked:0,calls:{prepared:0,sending:0,succeeded:2,failed:0,unknown:1},tasks:[blocked,retryable]};const actions=[];
 await withPanel(t,async(method,...args)=>{
  if(method==='readCurrent')return {connectionGeneration:7,run:current};
  if(method==='continue'){
   actions.push({method,args});current={...current,succeeded:1,failed:0,status:'blocked',statusReason:'model_receipt_unknown',actions:[],pending:0,tasks:[blocked,{...retryable,state:'succeeded',succeeded:1,errorCode:null}]};return {connectionGeneration:7,run:current};
  }
 },async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('status').filter({hasText:'调用结果待核实'}).waitFor();
  await panel.getByRole('button',{name:'继续原任务',exact:true}).click();
  assert.equal(actions.length,1);assert.equal(actions[0].method,'continue');
  assert.equal(actions[0].args[0].runId,ids.run);assert.equal(actions[0].args[0].controlVersion,0);
  assert.equal(actions[0].args[0].connectionGeneration,7);assert.match(actions[0].args[0].operationId,/^[a-f0-9-]{36}$/);
  await panel.getByText('已处理 1 / 2 条文字目标',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'继续原任务',exact:true}).count(),0,'unknown-only没有可继续任务');
  const retryProjection={failed:{status:'blocked',statusReason:'contact_failed'},paused:{status:'paused',statusReason:null},pending:{status:'blocked',statusReason:'round_incomplete'}};
  for(const state of ['failed','paused','pending']){
   current={...run(),state:'incomplete',succeeded:0,pending:state==='pending'?1:0,actions:['continue'],status:retryProjection[state].status,statusReason:retryProjection[state].statusReason,tasks:[{...retryable,state}]};
   await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await panel.getByRole('button',{name:'继续原任务',exact:true}).waitFor();
  }
  current={...run(),state:'incomplete',succeeded:0,pending:1,status:'blocked',statusReason:'round_incomplete',actions:[],tasks:[{...retryable,state:'incomplete',errorCode:'targets_completed_elsewhere'}]};
  await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await panel.getByRole('status').filter({hasText:'本轮尚未完成'}).waitFor();assert.equal(await panel.getByRole('button',{name:'继续原任务',exact:true}).count(),0);
 });
});
test('来源或资格失效后的历史成功计数不能冒充正常无产出成功', {timeout:20000},async t=>{
 const invalidated={...run(),status:'blocked',statusReason:'scope_revoked',actions:[],pending:0,revoked:1,tasks:run().tasks.map(task=>({...task,state:'revoked'}))};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:invalidated}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.locator(':scope > p').filter({hasText:'已处理 1 / 1 条文字目标'}).waitFor();
  assert.equal(await panel.getByText('已处理，未产生新记忆',{exact:true}).count(),0,'失效不能被解释成提取成功但没有值得保存的新记忆');
  await panel.getByRole('status').filter({hasText:'范围已失效'}).waitFor();
 });
});

test('页面暂停动作携带控制修订与操作标识，暂停后显示可继续',{timeout:20000},async t=>{
 let current={...run(),state:'running',status:'processing',statusReason:null,actions:['pause'],pending:1,succeeded:0};
 const actions=[];
 await withPanel(t,async(method,...args)=>{
  if(method==='readCurrent')return {connectionGeneration:3,run:current};
  if(method==='pause'){
   actions.push({method,args});current={...current,state:'paused',status:'paused',actions:['continue']};
   return {connectionGeneration:3,run:current};
  }
 },async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('button',{name:'暂停记忆处理'}).click();
  assert.equal(actions.length,1);assert.equal(actions[0].method,'pause');
  assert.equal(actions[0].args[0].runId,ids.run);assert.equal(actions[0].args[0].controlVersion,0);
  assert.equal(actions[0].args[0].connectionGeneration,3);assert.match(actions[0].args[0].operationId,/^[a-f0-9-]{36}$/);
  await panel.getByRole('status').filter({hasText:'已暂停'}).waitFor();
  await panel.getByRole('button',{name:'继续原任务',exact:true}).waitFor();
 });
});

test('全部适用阶段完成后页面显示整轮完成，不再声称主题未执行',{timeout:20000},async t=>{
 const completed={...run(),state:'completed',stage:'completed',laterStages:'completed'};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:completed}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});await panel.getByRole('status').filter({hasText:'本轮已完成'}).waitFor();
  assert.equal(await panel.getByText('主题整理、长期概览尚未执行，本轮未完成。',{exact:true}).count(),0);
 });
});

test('页面按真实主题和画像阶段显示处理中状态',{timeout:20000},async t=>{
 let current={...run(),state:'running',stage:'document_scene'};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('status').filter({hasText:'正在整理主题资料'}).waitFor({timeout:3000});
  current={...current,stage:'document_profile'};await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'正在整理长期概览'}).waitFor({timeout:3000});
 });
});
