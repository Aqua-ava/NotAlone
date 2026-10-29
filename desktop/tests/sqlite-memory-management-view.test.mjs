import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const contact='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const source={contactId:contact,messageId:id,recordId:id,acceptedRevision:'1',quote:'合成原话证据'};
const candidate={id,scopeKind:'contact',contactId:contact,body:'原始合成结论',state:'pending',stateRevision:'0',eventId:id,sources:[source],contributingContactIds:[contact]};
const view=()=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{candidates:[candidate],memories:[]}});
async function panel(t,command,inspect){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SqliteMemoryManagementPanel} from './src/renderer/SqliteMemoryManagementPanel';const listeners=new Set();window.invalidate=()=>{for(const fn of listeners)fn();};const bridge={read:(...args)=>window.command('read',...args),decide:(...args)=>window.command('decide',...args),release:async()=>{},onInvalidated:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};createRoot(document.getElementById('root')).render(<SqliteMemoryManagementPanel bridge={bridge} contactId='${contact}' scopeRevision={1}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);await page.exposeFunction('command',command);await page.route('http://127.0.0.1/memory-management-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/memory-management-test');await page.addScriptTag({content:compiled.outputFiles[0].text});await inspect(page);
}
test('候选保留固定原稿，修改采纳提交真实修订和编辑正文，失效撤下正文依据和草稿',{timeout:20000},async t=>{
 const decisions=[];await panel(t,async(method,input)=>{if(method==='read')return view();if(method==='decide'){decisions.push(input);return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:'1',action:'edit_accept'}};}},async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});await section.getByText('原始合成结论',{exact:true}).waitFor();
  await section.getByRole('button',{name:'修改并采纳'}).click();await section.getByLabel('修改候选正文').fill('本次修改采纳');await section.getByRole('button',{name:'保存修改并采纳'}).click();await section.getByRole('status').filter({hasText:'修改采纳成功'}).waitFor();
  assert.equal(decisions[0].request.action,'edit_accept');assert.deepEqual(decisions[0].request.candidateRevisions,['0']);assert.equal(decisions[0].request.body,'本次修改采纳');assert.equal(decisions[0].connectionGeneration,1);
  await section.getByRole('button',{name:'修改并采纳'}).click();await section.getByLabel('修改候选正文').fill('失效编辑草稿');await section.getByText('查看来源',{exact:true}).click();await section.getByText('合成原话证据',{exact:true}).waitFor();
  await page.evaluate(()=>window.invalidate());await section.getByRole('alert').waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);assert.equal(await section.getByText('合成原话证据',{exact:true}).count(),0);assert.equal(await section.getByLabel('修改候选正文').count(),0);
 });
});
test('自动更新撤销使用当前头CAS新增恢复版本，人工保护须独立解除，纠错和变化分开记录',{timeout:20000},async t=>{
 const v1={versionNo:'1',body:'原先合成状态',formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const v2={...v1,versionNo:'2',body:'自动更新状态',adoptionMode:'auto',previousVersionNo:'1'};
 let memory={id,scopeKind:'contact',contactId:contact,headRevision:'7',state:'active',manualProtection:true,current:v2,versions:[v1,v2],decisions:[]};
 const calls=[];
 await panel(t,async(method,input)=>{
  if(method==='read')return {...view(),view:{candidates:[],memories:[memory]}};
  calls.push(input.request);const action=input.request.action;
  if(action==='unprotect')memory={...memory,manualProtection:false,headRevision:'8'};
  if(action==='restore'){const v3={...v1,versionNo:'3',formationKind:'restore',previousVersionNo:'2',restoredFromVersionNo:'1'};memory={...memory,headRevision:'9',current:v3,versions:[v1,v2,v3]};}
  if(action==='correct'||action==='change'){const next={...memory.current,body:input.request.body,versionNo:String(Number(memory.current.versionNo)+1),formationKind:action==='correct'?'correction':'change',previousVersionNo:memory.current.versionNo,restoredFromVersionNo:null};memory={...memory,headRevision:String(Number(memory.headRevision)+1),current:next,versions:[...memory.versions,next]};}
  return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:memory.current.versionNo,action}};
 },async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});
  const undo=section.getByRole('button',{name:'撤销自动更新'});await undo.waitFor();assert.equal(await undo.isDisabled(),true);
  await section.getByRole('button',{name:'解除人工保护'}).click();await section.getByRole('status').filter({hasText:'已解除当前人工保护'}).waitFor();
  await undo.click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
  assert.equal(calls[1].action,'restore');assert.equal(calls[1].expectedVersionNo,'2');assert.equal(calls[1].expectedHeadRevision,'8');assert.equal(calls[1].restoredFromVersionNo,'1');
  await section.getByText('恢复自版本 1，原前驱为版本 2。',{exact:true}).first().waitFor();assert.equal(await undo.count(),0);
  await section.getByRole('button',{name:'纠正错误'}).click();await section.getByLabel('修正后的正文').fill('错误已纠正');await section.getByRole('button',{name:'保存错误修正'}).click();await section.getByRole('status').filter({hasText:'错误修正成功'}).waitFor();assert.equal(calls[2].action,'correct');
  await section.getByRole('button',{name:'记录变化'}).click();await section.getByLabel('变化后的正文').fill('后来状态变化');await section.getByRole('button',{name:'保存变化记录'}).click();await section.getByRole('status').filter({hasText:'变化已记录'}).waitFor();assert.equal(calls[3].action,'change');
 });
});
test('并发冲突与来源失效各有反馈，失效后的迟到读取不能恢复候选正文',{timeout:20000},async t=>{
 let mode='normal',finish,entered;const pending=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 await panel(t,async(method)=>{
  if(method==='decide')return {status:mode==='source'?'source_stale':'conflict'};
  if(mode==='late'){entered();return pending;}return view();
 },async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});await section.getByText('原始合成结论',{exact:true}).waitFor();await section.getByRole('button',{name:'采纳原稿'}).click();await section.getByRole('alert').filter({hasText:'并发冲突'}).waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);
  mode='source';await section.getByRole('button',{name:'刷新记忆管理'}).click();await section.getByRole('button',{name:'拒绝候选'}).click();await section.getByRole('alert').filter({hasText:'来源或范围已失效'}).waitFor();
  mode='late';await section.getByRole('button',{name:'刷新记忆管理'}).click();await started;await page.evaluate(()=>window.invalidate());finish(view());await section.getByRole('alert').filter({hasText:'已撤下正文'}).waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);
 });
});
test('决定回执成功而随后读取失败时不冒报资料仍可用，原正文已撤下',{timeout:20000},async t=>{
 let applied=false;await panel(t,async method=>{if(method==='decide'){applied=true;return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:'1',action:'accept'}};}if(applied)throw new Error('synthetic_source_unavailable');return view();},async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});await section.getByRole('button',{name:'采纳原稿'}).click();await section.getByRole('alert').filter({hasText:'决定已保存，但当前资料暂不可读'}).waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);assert.equal(await section.getByRole('status').filter({hasText:'采纳成功'}).count(),0);
 });
});
