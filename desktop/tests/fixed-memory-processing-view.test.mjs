import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const ids={run:'11111111-1111-4111-8111-111111111111',task:'22222222-2222-4222-8222-222222222222',contact:'33333333-3333-4333-8333-333333333333'};
const run=()=>({runId:ids.run,state:'incomplete',total:1,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',
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
  await panel.getByText('已处理，未产生新记忆',{exact:true}).waitFor();await panel.getByText('主题整理、长期概览尚未执行，本轮未完成。',{exact:true}).waitFor();assert.equal(await panel.getByText('本轮已完成',{exact:true}).count(),0);
  current={...run(),candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'合成候选正文',state:'verified_pending_decision',origin:'auto'}]};
  await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await panel.getByText('合成候选正文',{exact:true}).waitFor();
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
   return {connectionGeneration:1,run:{...run(),state:'failed',succeeded:0,unknown:1,candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'合法候选快照',state:'verified_pending_decision',origin:'auto'}]}};
  }
 },async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('合法候选快照',{exact:true}).waitFor();await panel.getByText('调用结果待核实',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'继续原任务',exact:true}).count(),0);
  mode='denied';await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await panel.getByRole('alert').waitFor();assert.equal(await panel.getByText('合法候选快照',{exact:true}).count(),0);
  mode='late';await panel.getByRole('button',{name:'刷新处理状态',exact:true}).click();await entered;await page.evaluate(()=>window.invalidate());release({connectionGeneration:1,run:{...run(),candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'不得恢复旧正文',state:'verified_pending_decision',origin:'auto'}]}});
  await panel.getByRole('alert').waitFor();assert.equal(await panel.getByText('不得恢复旧正文',{exact:true}).count(),0);
 });
});
