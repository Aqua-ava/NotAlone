import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const contact='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const source={contactId:contact,messageId:id,recordId:id,acceptedRevision:'1',quote:'合成来源原话'};
const candidate={id,scopeKind:'contact',contactId:contact,verificationState:'verified',body:'本页待确认的合成记忆',state:'pending',stateRevision:'0',eventId:id,sources:[source],contributingContactIds:[contact]};
let browserCode;

test.before(async()=>{
 const result=await build({stdin:{contents:`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {SqliteMemoryManagementPanel} from './src/renderer/SqliteMemoryManagementPanel';
  const listeners=new Set();
  const bridge={read:input=>window.command('read',input),readDocuments:input=>window.command('readDocuments',input),decide:input=>window.command('decide',input),release:async()=>{},onInvalidated:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const root=createRoot(document.getElementById('root'));
  let hints={documentsRefreshKey:0,completedRunId:null};
  window.updateHints=next=>{hints={...hints,...next};render();};
  window.invalidate=()=>{for(const listener of listeners)listener();};
  function render(){root.render(<SqliteMemoryManagementPanel bridge={bridge} contactId='${contact}' scopeRevision={1} {...hints}/>);}
  render();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 browserCode=result.outputFiles[0].text;
});

async function panel(t,command,inspect){
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});
 t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(4000);
 // 本组只核验显式处理通知；周期刷新另由现有页面回归覆盖，避免计时噪声影响请求次数。
 await page.addInitScript(()=>{const original=window.setInterval;window.setInterval=(callback,_interval,...args)=>original(callback,60000,...args);});
 await page.exposeFunction('command',command);
 await page.route('http://127.0.0.1/memory-browser-updates',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await page.goto('http://127.0.0.1/memory-browser-updates');
 await page.addScriptTag({content:browserCode});
 await inspect(page);
}

function memories(input,{page=true}={}){
 const second=!!input.cursor;
 return {connectionGeneration:1,scope:input.scope,view:{candidates:[{...candidate,body:second?'第二页的合成记忆':candidate.body}],memories:[],...(page?{page:{revision:'a'.repeat(64),nextCursor:second?null:'next-page'}}:{})}};
}

function documents(input,number=1){
 const items=[['33333333-3333-4333-8333-333333333333','scene','主题资料',`第${number}次主题正文`],['44444444-4444-4444-8444-444444444444','profile','长期概览',`第${number}次概览正文`]].map(([documentId,kind,title,text])=>({id:documentId,versionNo:'1',...input.scope,kind,title,statements:[{text,kind:'fact',references:[]}]}));
 return {connectionGeneration:1,scope:input.scope,view:{status:'completed',publication:{id,members:items.map(document=>({documentId:document.id,versionNo:document.versionNo}))},documents:items}};
}

async function settle(page){await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});}

function gate(t,label){
 let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const timer=setTimeout(()=>reject(new Error(`未等到${label}`)),5000);promise.catch(()=>{});t.after(()=>clearTimeout(timer));
 return {promise,resolve:value=>{clearTimeout(timer);resolve(value);}};
}

test('处理进度只刷新发布资料，新的完成轮次才刷新具体记忆',{timeout:20000},async t=>{
 let reads=0,documentReads=0;
 await panel(t,async(method,input)=>{
  if(method==='read'){reads++;return memories(input);}
  assert.equal(method,'readDocuments');return documents(input,++documentReads);
 },async page=>{
  await page.getByText(candidate.body,{exact:true}).waitFor();
  await page.getByText('第1次主题正文',{exact:true}).waitFor({state:'attached'});
  await page.evaluate(()=>window.updateHints({documentsRefreshKey:1}));
  await page.getByText('第2次主题正文',{exact:true}).waitFor({state:'attached'});
  assert.equal(reads,1,'一般处理进度不能反复读取具体记忆');
  await page.evaluate(()=>window.updateHints({documentsRefreshKey:2,completedRunId:'completed-round-1'}));
  await page.getByText('第3次主题正文',{exact:true}).waitFor({state:'attached'});await settle(page);
  assert.equal(reads,2,'首次完成通知重读一次具体记忆');
  await page.evaluate(()=>window.updateHints({documentsRefreshKey:3,completedRunId:'completed-round-1'}));
  await page.getByText('第4次主题正文',{exact:true}).waitFor({state:'attached'});await settle(page);
  assert.equal(reads,2,'同一轮次的重复通知不重读具体记忆');assert.equal(documentReads,4);
  t.diagnostic(JSON.stringify({workload:'初读、两次普通进度、一次新完成通知',reads,documentReads}));
 });
});

test('新完成轮次将具体记忆重读到第一页并重置上一页导航',{timeout:20000},async t=>{
 const cursors=[];
 await panel(t,async(method,input)=>{
  if(method==='read'){cursors.push(input.cursor??null);return memories(input);}
  return documents(input);
 },async page=>{
  await page.getByText(candidate.body,{exact:true}).waitFor();
  await page.getByRole('button',{name:'下一页记忆',exact:true}).click();
  await page.getByText('第二页的合成记忆',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'上一页记忆',exact:true}).isEnabled(),true);
  await page.evaluate(()=>window.updateHints({completedRunId:'completed-round-2'}));
  await page.getByText(candidate.body,{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'上一页记忆',exact:true}).isDisabled(),true);
  assert.deepEqual(cursors,[null,'next-page',null]);
 });
});

test('决定期间的完成通知合并到决定后的权威重读，避免重复读取',{timeout:20000},async t=>{
 const started=gate(t,'记忆决定开始'),release=gate(t,'记忆决定结束'),events=[];
 let reads=0,documentReads=0,deciding=false;
 await panel(t,async(method,input)=>{
  if(method==='decide'){
   deciding=true;events.push('decide:start');started.resolve();await release.promise;deciding=false;events.push('decide:completed');
   return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:'1',action:'accept'}};
  }
  assert.equal(deciding,false,'决定尚未结束时不能启动后续读取');events.push(method);
  if(method==='read'){reads++;return memories(input);}
  return documents(input,++documentReads);
 },async page=>{
  await page.getByText(candidate.body,{exact:true}).waitFor();
  await page.getByText('第1次主题正文',{exact:true}).waitFor({state:'attached'});
  await page.getByRole('button',{name:'采纳原稿',exact:true}).click();await started.promise;
  const before=reads;
  await page.evaluate(()=>window.updateHints({completedRunId:'completed-during-decision',documentsRefreshKey:1}));await settle(page);
  assert.equal(reads,before);assert.equal(documentReads,1);
  assert.equal(await page.getByText('第1次主题正文',{exact:true}).count(),0,'决定开始即撤下旧发布资料');
  release.resolve();
  await page.getByRole('status').filter({hasText:'采纳成功'}).waitFor();
  await page.getByText('第2次主题正文',{exact:true}).waitFor({state:'attached'});await settle(page);
  assert.equal(events[events.indexOf('decide:completed')+1],'read','决定后先核对具体记忆');
  assert.equal(reads,2,'决定前已到达的完成通知由决定后的权威重读覆盖');assert.equal(documentReads,2);
  t.diagnostic(JSON.stringify({workload:'决定中收到完成通知',reads,documentReads,events}));
 });
});

test('权威重读已经开始后到达的新完成通知仍会再读，不遗漏新资料',{timeout:20000},async t=>{
 const started=gate(t,'决定后的权威重读'),release=gate(t,'权威重读返回');
 let reads=0;
 await panel(t,async(method,input)=>{
  if(method==='decide')return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:'1',action:'accept'}};
  if(method==='readDocuments')return documents(input);
  const number=++reads;
  if(number===2){started.resolve();await release.promise;}
  const snapshot=memories(input);
  snapshot.view.candidates[0].body=number===3?'新完成轮次保存的合成资料':candidate.body;
  return snapshot;
 },async page=>{
  await page.getByText(candidate.body,{exact:true}).waitFor();
  await page.getByRole('button',{name:'采纳原稿',exact:true}).click();await started.promise;
  await page.evaluate(()=>window.updateHints({completedRunId:'completed-after-authoritative-read-started'}));await settle(page);
  assert.equal(reads,2,'当前权威读取未结束时先保留新完成提示');
  release.resolve();await page.getByText('新完成轮次保存的合成资料',{exact:true}).waitFor();
  assert.equal(reads,3,'新完成通知不能被已开始的旧读取吞掉');
 });
});

test('主题与概览切换复用同一已发布集合，读取次数不随层级切换增长',{timeout:20000},async t=>{
 let reads=0,documentReads=0;
 await panel(t,async(method,input)=>{
  if(method==='read'){reads++;return memories(input);}
  return documents(input,++documentReads);
 },async page=>{
  await page.getByText(candidate.body,{exact:true}).waitFor();
  await page.getByText('第1次主题正文',{exact:true}).waitFor({state:'attached'});
  await page.getByRole('button',{name:'主题资料',exact:true}).click();
  await page.getByText('第2次主题正文',{exact:true}).waitFor();
  for(let index=0;index<3;index++){
   await page.getByRole('button',{name:'长期概览',exact:true}).click();await page.getByText('第2次概览正文',{exact:true}).waitFor();
   await page.getByRole('button',{name:'主题资料',exact:true}).click();await page.getByText('第2次主题正文',{exact:true}).waitFor();
  }
  assert.equal(documentReads,2);assert.equal(reads,1);
  t.diagnostic(JSON.stringify({workload:'初读、进入主题、主题与概览往返三次',reads,documentReads}));
 });
});
