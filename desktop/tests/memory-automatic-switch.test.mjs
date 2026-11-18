import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import { launchChromium } from './helpers/browser.mjs';

/** 开关组件与面板提示在真实 Chromium 中的行为；桥为合成桩，不连接后端。 */
async function withSwitch(t,command,inspect){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';
  import {MemoryProcessingEntry} from './src/renderer/MemoryProcessingEntry';
  const invalidations=new Set();window.invalidate=()=>{for(const listener of invalidations)listener();};
  const bridge=new Proxy({},{get:(_,method)=>method==='onInvalidated'?listener=>{invalidations.add(listener);return()=>invalidations.delete(listener);}
   :method==='readMode'?async()=>({connectionGeneration:1,mode:'sqlite'})
   // 与真实主进程控制器一致：设置成功后通知所有持有页面重新核对。
   :method==='setAutomatic'?async(...args)=>{const result=await window.command(method,...args);window.invalidate();return result;}
   :(...args)=>window.command(method,...args)});
  new MutationObserver(()=>document.querySelectorAll('details.memory-processing-disclosure').forEach(node=>{node.open=true;})).observe(document.getElementById('root'),{childList:true,subtree:true});
  createRoot(document.getElementById('root')).render(<MemoryProcessingEntry bridge={bridge} backend={{onStateChanged:()=>()=>{}}} contactId="33333333-3333-4333-8333-333333333333" releaseOnUnmount={false}>{null}</MemoryProcessingEntry>);`,
  resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await launchChromium({ timeout: 10000 });t.after(()=>browser.close());
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
  assert.equal(calls.filter(method=>method==='readAutomatic').length,1,'开关和面板共用一次权威读取');
  await toggle.click();
  await card.getByText('已开启：已导入的历史和新增消息会自动提取记忆').waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'),'true');
  await page.getByRole('button',{name:'恢复本轮处理'}).waitFor();
  assert.equal(await page.getByText('记忆自动处理已关闭：新消息只保存').count(),0);
  assert.ok(calls.includes('setAutomatic'));
 });
});

test('失效后只接受最新开关回执，旧读取不能恢复过时的开启状态',async t=>{
 const old=Promise.withResolvers();let reads=0;
 await withSwitch(t,async(method,...args)=>{
  if(method==='readAutomatic')return ++reads===1?old.promise:{connectionGeneration:1,enabled:false};
  if(method==='readCurrent')return {connectionGeneration:1,contactId:args[0].contactId,run:blockedRun};
 },async page=>{
  await page.waitForFunction(()=>document.querySelector('[role="switch"]')!==null);
  assert.equal(await page.getByRole('button',{name:'恢复本轮处理'}).count(),0,'开关未核实时不提供恢复动作');
  await page.evaluate(()=>window.invalidate());
  const toggle=page.getByRole('switch');
  await page.getByText('已关闭：App 不会自动提取记忆').waitFor();
  old.resolve({connectionGeneration:1,enabled:true});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await toggle.getAttribute('aria-checked'),'false');
  assert.equal(await page.getByRole('button',{name:'恢复本轮处理'}).count(),0);
  assert.equal(reads,2,'一次失效只重新读取一次开关');
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

test('保存和随后读取均失败时保留未知状态，不宣称已读到最新值',async t=>{
 let saving=false;
 await withSwitch(t,async(method,...args)=>{
  if(method==='readAutomatic'){if(saving)throw new Error('合成读取失败');return {connectionGeneration:1,enabled:false};}
  if(method==='setAutomatic'){saving=true;throw new Error('合成保存失败');}
  if(method==='readCurrent')return {connectionGeneration:1,contactId:args[0].contactId,run:blockedRun};
 },async page=>{
  const card=page.getByRole('region',{name:'记忆自动处理开关'});
  await card.getByText('已关闭：App 不会自动提取记忆').waitFor();
  await card.getByRole('switch').click();
  await card.getByRole('alert').filter({hasText:'自动处理状态暂不可用'}).waitFor();
  assert.equal(await card.getByRole('switch').isDisabled(),true);
  assert.equal(await card.getByText('已重新读取最新状态').count(),0);
  assert.equal(await page.getByRole('button',{name:'恢复本轮处理'}).count(),0);
 });
});
