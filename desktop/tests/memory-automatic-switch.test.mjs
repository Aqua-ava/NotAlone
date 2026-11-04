import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

/** 开关组件与面板提示在真实 Chromium 中的行为；桥为合成桩，不连接后端。 */
async function withSwitch(t,command,inspect){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
  import {MemoryAutomaticSwitch} from './src/renderer/MemoryAutomaticSwitch';
  import {FixedMemoryProcessingPanel} from './src/renderer/FixedMemoryProcessingPanel';
  const invalidations=new Set();window.invalidate=()=>{for(const listener of invalidations)listener();};
  const bridge=new Proxy({},{get:(_,method)=>method==='onInvalidated'?listener=>{invalidations.add(listener);return()=>invalidations.delete(listener);}
   // 与真实主进程控制器一致：设置成功后通知所有持有页面重新核对。
   :method==='setAutomatic'?async(...args)=>{const result=await window.command(method,...args);window.invalidate();return result;}
   :(...args)=>window.command(method,...args)});
  createRoot(document.getElementById('root')).render(<><MemoryAutomaticSwitch bridge={bridge}/><FixedMemoryProcessingPanel bridge={bridge} contactId="33333333-3333-4333-8333-333333333333" releaseOnUnmount={false}/></>);`,
  resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(4000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('command',command);
 await page.route('http://127.0.0.1/automatic-switch-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await page.goto('http://127.0.0.1/automatic-switch-test');await page.addScriptTag({content:compiled.outputFiles[0].text});
 try{await inspect(page);}catch(error){if(errors.length)error.message+=`\n页面错误：${errors.join(' | ')}`;throw error;}
 assert.deepEqual(errors,[],'页面不应抛出错误');
}
const blockedRun={runId:'11111111-1111-4111-8111-111111111111',state:'paused',total:2,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',status:'paused',statusReason:null,sharedFaultCode:null,actions:['continue'],controlVersion:3,pending:1,revoked:0,calls:{prepared:0,sending:0,succeeded:1,failed:0,unknown:0},tasks:[],inputs:[],candidates:[]};

test('默认关闭：显示关闭说明与开启按钮，面板提示并隐藏恢复入口；开启后可恢复',async t=>{
 let enabled=false;const calls=[];
 await withSwitch(t,async(method,...args)=>{
  calls.push(method);
  if(method==='readAutomatic')return {connectionGeneration:1,enabled};
  if(method==='setAutomatic'){enabled=args[0].enabled;return {connectionGeneration:1,enabled};}
  if(method==='readCurrent')return {connectionGeneration:1,contactId:args[0].contactId,run:blockedRun,queue:{pending:0,nextDueAt:null,blockedContacts:0}};
  return undefined;
 },async page=>{
  const card=page.getByRole('region',{name:'记忆自动处理开关'});
  const toggle=card.getByRole('switch');
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'),'false');
  assert.match(await toggle.innerText(),/开启自动处理/);
  await card.getByText('已关闭：App 不会自动提取记忆，也不会为此调用模型').waitFor();
  await page.getByText('记忆自动处理已关闭：新消息只保存，不会提取记忆').waitFor();
  assert.equal(await page.getByRole('button',{name:'恢复本轮处理'}).count(),0,'关闭时不提供会被拒绝的恢复入口');
  await toggle.click();
  await card.getByText('已开启：已导入的历史和新增消息会自动提取记忆').waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'),'true');
  await page.getByRole('button',{name:'恢复本轮处理'}).waitFor();
  assert.equal(await page.getByText('记忆自动处理已关闭：新消息只保存').count(),0);
  assert.ok(calls.includes('setAutomatic'));
 });
});

test('状态读取失败时不猜测开关：按钮不可用并显示可重试提示；保存失败重新读取权威状态',async t=>{
 let readFails=true,setFails=false,enabled=false;
 await withSwitch(t,async(method,...args)=>{
  if(method==='readAutomatic'){if(readFails)throw new Error('合成读取失败');return {connectionGeneration:1,enabled};}
  if(method==='setAutomatic'){if(setFails)throw new Error('合成保存失败');enabled=args[0].enabled;return {connectionGeneration:1,enabled};}
  if(method==='readCurrent')return {connectionGeneration:1,contactId:args[0].contactId,run:null,queue:{pending:0,nextDueAt:null,blockedContacts:0}};
  return undefined;
 },async page=>{
  const card=page.getByRole('region',{name:'记忆自动处理开关'});
  await card.getByRole('alert').filter({hasText:'自动处理状态暂不可用'}).waitFor();
  assert.equal(await card.getByRole('switch').isDisabled(),true);
  assert.equal(await page.getByText('记忆自动处理已关闭：新消息只保存').count(),0,'未读到状态时不显示已关闭');
  readFails=false;await page.evaluate(()=>window.invalidate());
  await card.getByText('已关闭：App 不会自动提取记忆').waitFor();
  setFails=true;await card.getByRole('switch').click();
  await card.getByRole('alert').filter({hasText:'操作结果暂未确认'}).waitFor();
  assert.equal(await card.getByRole('switch').getAttribute('aria-checked'),'false','保存失败后仍以重新读取的值为准');
 });
});
