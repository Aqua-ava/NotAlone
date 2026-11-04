import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const contact='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const source={contactId:contact,messageId:id,recordId:id,acceptedRevision:'1',quote:'合成原话证据',sentAt:String(Date.parse('2026-10-28T12:00:00Z')),timePrecision:'second'};
const version=extra=>({mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'喝咖啡时喜欢换成燕麦奶，少糖。',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact],...extra});
const memory=current=>({id:'33333333-3333-4333-8333-333333333333',scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current,versions:[current],decisions:[]});
const view=current=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{candidates:[],memories:[memory(current)],page:{revision:'a'.repeat(64),nextCursor:null}}});

async function panel(t,command,inspect){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SqliteMemoryManagementPanel} from './src/renderer/SqliteMemoryManagementPanel';const listeners=new Set();window.invalidate=()=>{for(const fn of listeners)fn();};const bridge={read:(...args)=>window.command('read',...args),decide:(...args)=>window.command('decide',...args),release:async()=>{},onInvalidated:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};createRoot(document.getElementById('root')).render(<SqliteMemoryManagementPanel bridge={bridge} contactId="${contact}" scopeRevision={1} visible={true}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(4000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('command',command);
 await page.route('http://127.0.0.1/source-recheck-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await page.goto('http://127.0.0.1/source-recheck-test');await page.addScriptTag({content:compiled.outputFiles[0].text});
 await inspect(page);assert.deepEqual(errors,[],'页面不应抛出错误');
}

test('读取授权暂不可用时显示已保存正文、来源日期和待重新核验提示；恢复后提示消失',async t=>{
 let pending=true;
 await panel(t,async()=>view(version(pending?{sourcePendingRecheck:true}:{})),async page=>{
  const card=page.getByRole('article',{name:'正式记忆'});
  await card.getByText('喝咖啡时喜欢换成燕麦奶，少糖。').waitFor();
  assert.match(await card.innerText(),/聊天来源/);
  assert.doesNotMatch(await card.innerText(),/当前无可引用版本|聊天来源日期未知/);
  await card.getByText('来源待重新核验').waitFor();
  // 授权恢复：失效通知撤下快照，回到页面触发重新读取。
  pending=false;await page.evaluate(()=>{window.invalidate();document.dispatchEvent(new Event('visibilitychange'));});
  await card.getByText('来源待重新核验').waitFor({state:'detached'});
  await card.getByText('喝咖啡时喜欢换成燕麦奶，少糖。').waitFor();
 });
});

test('来源真实失效时仍只显示无可引用版本，不显示正文',async t=>{
 const hidden={...version({body:null,contentState:'redacted',provenanceState:'invalidated',sources:[]})};
 await panel(t,async()=>({...view(hidden),view:{candidates:[],memories:[{...memory(hidden),current:null,versions:[hidden]}],page:{revision:'a'.repeat(64),nextCursor:null}}}),async page=>{
  const card=page.getByRole('article',{name:'正式记忆'});
  await card.getByText('当前无可引用版本').waitFor();
  assert.equal(await card.getByText('来源待重新核验').count(),0);
 });
});
