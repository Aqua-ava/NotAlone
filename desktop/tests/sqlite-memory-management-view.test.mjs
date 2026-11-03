import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {emptyDocumentFixture} from '../../backend-ts/test/fixtures/memory-documents/empty-status-support.mjs';
const contact='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const source={contactId:contact,messageId:id,recordId:id,acceptedRevision:'1',quote:'合成原话证据'};
const candidate={id,scopeKind:'contact',contactId:contact,verificationState:'verified',body:'原始合成结论',state:'pending',stateRevision:'0',eventId:id,sources:[source],contributingContactIds:[contact]};
const view=()=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{candidates:[candidate],memories:[]}});
async function refreshVisible(page){await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
async function openMemoryMore(scope){const summary=scope.getByText('更多',{exact:true});await summary.waitFor();if(await summary.locator('..').getAttribute('open')===null)await summary.click();}
async function panel(t,command,inspect,withDocuments=false,selectedContact=contact,release=async()=>{},{initialLevel=withDocuments?'L2':'L1',keepMounted=true,withHistory=false}={}){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SqliteMemoryManagementPanel} from './src/renderer/SqliteMemoryManagementPanel';const listeners=new Set();window.invalidate=()=>{for(const fn of listeners)fn();};const bridge={read:(...args)=>window.command('read',...args),${withHistory ? "readHistory:(...args)=>window.command('readHistory',...args)," : ''}${withDocuments ? "readDocuments:(...args)=>window.command('readDocuments',...args)," : ''}decide:(...args)=>window.command('decide',...args),release:()=>window.release(),onInvalidated:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();let shown=true,selected='${selectedContact}',revision=1;const render=()=>root.render(${keepMounted?'':'shown&&'}<div hidden={!shown}><SqliteMemoryManagementPanel bridge={bridge} contactId={selected} scopeRevision={revision} visible={shown}/></div>);window.setPanelVisible=value=>{shown=value;render();};window.setPanelContact=value=>{selected=value;revision++;render();};render();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);await page.exposeFunction('command',command);await page.exposeFunction('release',release);await page.route('http://127.0.0.1/memory-management-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/memory-management-test');await page.addScriptTag({content:compiled.outputFiles[0].text});if(initialLevel!=='L1')await page.getByRole('button',{name:initialLevel,exact:true}).click();await inspect(page);
}
function flatDocuments(){
 const document=(documentId,kind,title,text)=>({id:documentId,versionNo:'1',scopeKind:'contact',contactId:contact,kind,title,statements:[{text,kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:id,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'合成记忆依据'}]}]});
 const documents=[document('33333333-3333-4333-8333-333333333333','scene','园艺主题','园艺主题的合成正文'),document('44444444-4444-4444-8444-444444444444','scene','周末活动','周末活动的合成正文'),document('55555555-5555-4555-8555-555555555555','profile','长期兴趣','长期兴趣的合成正文')];
 return {connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{status:'completed',publication:{id,members:documents.map(document=>({documentId:document.id,versionNo:document.versionNo}))},documents}};
}
async function captureFlatMemory(page,person){
 for(const width of [1100,680]){
  await page.setViewportSize({width,height:850});
  assert.equal(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)<=document.documentElement.clientWidth),true,`${person}在${width}px宽度没有水平溢出`);
  await page.locator('.sqlite-memory-management').screenshot({path:`/tmp/notalone-flat-memory-${person==='self'?'self-':''}${width===680?'narrow-':''}preview.png`});
 }
 await page.setViewportSize({width:1100,height:850});
}
test('相处时间线按直接来源排序，未知日期与候选独立展示，窄窗口不溢出',{timeout:20000},async t=>{
 const version=(body,date)=>({mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body,formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[{...source,sentAt:String(Date.parse(date)),timePrecision:'second'}],contributingContactIds:[contact]});
 const memory=(key,current)=>({id:key,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current,versions:current?[current]:[],decisions:[]});
 const old=memory('older',version('一起逛过河边的旧书店。','2026-10-19T12:00:00Z'));
 const recent=memory('newer',version('喝咖啡时喜欢换成燕麦奶，少糖。','2026-10-28T12:00:00Z'));
 await panel(t,async()=>({...view(),view:{memories:[old,memory('unavailable',null),recent],candidates:[{...candidate,body:'最近想找时间去海边走走。'}]}}),async page=>{
  await page.getByText(recent.current.body,{exact:true}).first().waitFor();
  for(const stylesheet of ['style.css','memory.css'])await page.addStyleTag({content:await readFile(new URL(`../src/renderer/${stylesheet}`,import.meta.url),'utf8')});
  await page.addStyleTag({content:'#root {padding:32px;max-width:1100px;margin:auto;}'});
  const entries=page.locator('.memory-timeline-item');
  assert.match(await entries.nth(0).innerText(),/燕麦奶/);assert.match(await entries.nth(1).innerText(),/旧书店/);
  assert.match(await entries.nth(2).innerText(),/聊天来源日期未知[\s\S]*当前无可引用版本/);
  assert.equal(await page.locator('.memory-candidates-aside').getByRole('article',{name:'记忆候选'}).count(),1);
  await page.setViewportSize({width:1100,height:900});
  const desktop=await page.locator('.memory-timeline-layout').evaluate(el=>{const [main,aside]=el.children;return {side:aside.getBoundingClientRect().left>=main.getBoundingClientRect().right};});
  assert.equal(desktop.side,true);
  await page.locator('.sqlite-memory-management').screenshot({path:'/tmp/notalone-memory-timeline-preview.png'});
  await entries.nth(0).getByRole('button',{name:'修改',exact:true}).click();await page.getByLabel('修正后的正文').fill('保留尚未提交的合成修正。');
  for(const width of [680,380]){
   await page.setViewportSize({width,height:900});
   const bounds=await page.locator('.memory-timeline-layout').evaluate(el=>{const [main,aside]=el.children;return {stacked:aside.getBoundingClientRect().top>=main.getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};});
   assert.deepEqual(bounds,{stacked:true,overflow:false});
   assert.equal(await page.getByLabel('修正后的正文').inputValue(),'保留尚未提交的合成修正。');
  }
 });
});
test('首次记忆只展示当前内容，来源和修改可达且更多保留撤销',{timeout:20000},async t=>{
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'1',body:'合成资料：周末喜欢去植物园。',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 let memory={id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]};
 const calls=[];
 await panel(t,async(method,input)=>{
  calls.push({method,input});
  if(method==='read')return {...view(),view:{candidates:[],memories:[memory]}};
  assert.equal(method,'decide');assert.equal(input.request.action,'withdraw');
  memory={...memory,headRevision:'2',state:'withdrawn',current:null};
  return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:null,action:'withdraw'}};
 },async page=>{
  const card=page.getByRole('article',{name:'正式记忆'});
  await card.getByText(version.body,{exact:true}).waitFor();await card.getByText('系统添加',{exact:true}).waitFor();
  assert.equal(await card.locator('.sqlite-memory-body').count(),1);
  for(const label of ['版本 1','当前版本','系统自动决定','当前人工保护未开启'])assert.equal(await card.getByText(label,{exact:false}).isVisible(),false);
  assert.equal(await card.getByText('更新历史',{exact:true}).count(),0);
  assert.equal(await card.getByText('来源已核验',{exact:true}).isVisible(),false);
  assert.equal(await card.getByRole('button',{name:'撤销首次自动采纳'}).count(),0);
  await card.getByText('查看来源',{exact:true}).click();await card.getByText(source.quote,{exact:true}).waitFor();await card.getByText('来源已核验',{exact:true}).waitFor();
  await card.getByRole('button',{name:'修改',exact:true}).click();await page.getByLabel('修正后的正文').fill('尚未保存的合成修正');await openMemoryMore(card);
  for(const name of ['记录变化','开启人工保护','撤销首次自动采纳'])assert.equal(await card.getByRole('button',{name,exact:true}).isDisabled(),true);
  assert.equal(await page.getByLabel('修正后的正文').inputValue(),'尚未保存的合成修正');await page.getByRole('button',{name:'取消编辑'}).click();
  await card.getByText(version.body,{exact:true}).waitFor();assert.equal(calls.filter(call=>call.method==='decide').length,0);
  await openMemoryMore(card);await card.getByText('更新历史',{exact:true}).waitFor();assert.equal(calls.filter(call=>call.method==='readHistory').length,0);
  await card.getByRole('button',{name:'撤销首次自动采纳'}).click();await page.getByRole('status').filter({hasText:'已撤销首次自动采纳'}).waitFor();
  assert.equal(await card.getByText(version.body,{exact:true}).count(),0);
  const request=calls.find(call=>call.method==='decide').input.request;assert.equal(request.expectedVersionNo,'1');assert.equal(request.expectedHeadRevision,'1');assert.equal(request.memoryId,id);
 });
});
test('首次记忆保护变更后仍可查看更新历史，未改变正文版本',{timeout:20000},async t=>{
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'1',body:'合成资料：喜欢安静的阅读环境。',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 let memory={id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]};
 const calls=[];
 await panel(t,async(method,input)=>{
  if(method==='read')return {...view(),view:{candidates:[],memories:[memory]}};
  assert.equal(method,'decide');calls.push(input.request);assert.equal(input.request.action,'protect');
  memory={...memory,headRevision:'2',manualProtection:true,decisions:[{id,action:'protect',actorKind:'user',createdAt:'1',expectedHeadRevision:'1',expectedVersionNo:'1',outcome:'applied'}]};
  return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:null,action:'protect'}};
 },async page=>{
  const card=page.getByRole('article',{name:'正式记忆'});
  await card.getByText(version.body,{exact:true}).waitFor();await openMemoryMore(card);await card.getByText('更新历史',{exact:true}).waitFor();
  await card.getByRole('button',{name:'开启人工保护'}).click();await page.getByRole('status').filter({hasText:'已开启当前人工保护'}).waitFor();
  assert.equal(memory.current.versionNo,'1');assert.equal(memory.headRevision,'2');assert.equal(calls[0].expectedHeadRevision,'1');
  await openMemoryMore(card);await card.getByText('更新历史',{exact:true}).click();
  const history=card.locator('.memory-version-history');await history.getByText('用户决定 · 已开启当前人工保护。 · 已生效',{exact:true}).waitFor();await history.getByText(version.body,{exact:true}).waitFor();
 });
});
test('L1 L2 L3 互斥切换，所选层全部记忆直接平铺且人物保持隔离',{timeout:20000},async t=>{
 const documentScopes=[];
 await panel(t,async(method,input)=>{
  if(method==='readDocuments'){documentScopes.push(input.scope.scopeKind);return flatDocuments();}
  return {...view(),scope:input.scope,view:{candidates:[{...candidate,scopeKind:input.scope.scopeKind,contactId:input.scope.contactId,body:input.scope.scopeKind==='self'?'本人的独立合成结论':candidate.body},{...candidate,id:'66666666-6666-4666-8666-666666666666',scopeKind:input.scope.scopeKind,contactId:input.scope.contactId,body:'第二条合成记忆'}],memories:[]}};
 },async page=>{
  await page.setViewportSize({width:1100,height:850});
  for(const stylesheet of ['style.css','memory.css'])await page.addStyleTag({content:await readFile(new URL(`../src/renderer/${stylesheet}`,import.meta.url),'utf8')});
  await page.addStyleTag({content:'#root {padding:28px;max-width:1100px;margin:auto;}'});
  const other=page.getByRole('button',{name:'对方',exact:true}),self=page.getByRole('button',{name:'我',exact:true}),levels=page.getByRole('group',{name:'记忆层级'});
  await page.getByText(candidate.body,{exact:true}).waitFor();await page.getByText('第二条合成记忆',{exact:true}).waitFor();
  assert.equal(await other.getAttribute('aria-pressed'),'true');assert.equal(await levels.getByRole('button',{name:'L1',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByRole('article',{name:'记忆候选'}).count(),2);assert.equal(await page.locator('.memory-flat-content .sqlite-memory-body').evaluateAll(nodes=>nodes.every(node=>node.closest('details')===null)),true);
  await captureFlatMemory(page,'contact');
  await levels.getByRole('button',{name:'L2',exact:true}).click();await page.getByText('园艺主题的合成正文',{exact:true}).waitFor();await page.getByText('周末活动的合成正文',{exact:true}).waitFor();
  assert.equal(await page.getByText(candidate.body,{exact:true}).isVisible(),false);assert.equal(await page.getByRole('article',{name:'主题资料'}).count(),2);assert.equal(await page.getByText('长期兴趣的合成正文',{exact:true}).count(),0);
  await levels.getByRole('button',{name:'L3',exact:true}).click();await page.getByText('长期兴趣的合成正文',{exact:true}).waitFor();assert.equal(await page.getByText('园艺主题的合成正文',{exact:true}).count(),0);
  for(const level of ['L1','L2','L3'])assert.equal(await levels.getByRole('button',{name:level,exact:true}).getAttribute('aria-pressed'),String(level==='L3'));
  await self.click();assert.equal(await self.getAttribute('aria-pressed'),'true');await page.getByText('本人全局概览不在当前联系人页面展示。',{exact:true}).waitFor();assert.equal(await page.getByText('长期兴趣的合成正文',{exact:true}).count(),0);
  await levels.getByRole('button',{name:'L2',exact:true}).click();await page.getByText('本人全局主题资料不在当前联系人页面展示。',{exact:true}).waitFor();
  await levels.getByRole('button',{name:'L1',exact:true}).click();await page.getByText('本人的独立合成结论',{exact:true}).waitFor();assert.equal(await page.getByText(candidate.body,{exact:true}).count(),0);assert.ok(documentScopes.every(scope=>scope==='contact'));
  await captureFlatMemory(page,'self');
 },true,contact,async()=>{},{initialLevel:'L1'});
});
test('平铺层级切换与自动刷新保留未提交编辑，资格失效撤下正文',{timeout:20000},async t=>{
 let calls=0,finish,entered;const pending=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 await panel(t,async()=>{if(++calls===2){entered();return pending;}return view();},async page=>{
  await page.getByRole('button',{name:'修改并采纳'}).click();const editor=page.getByLabel('修改候选正文');await editor.fill('平铺记忆中的未提交草稿');
  await page.getByRole('button',{name:'L2',exact:true}).click();assert.equal(await editor.isVisible(),false);await page.getByRole('button',{name:'L1',exact:true}).click();assert.equal(await editor.inputValue(),'平铺记忆中的未提交草稿');
  await refreshVisible(page);await started;assert.equal(await editor.inputValue(),'平铺记忆中的未提交草稿');finish(view());await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await editor.inputValue(),'平铺记忆中的未提交草稿');
  await page.evaluate(()=>window.invalidate());await page.getByRole('alert').filter({hasText:'已撤下正文'}).waitFor();assert.equal(await page.getByLabel('修改候选正文').count(),0);assert.equal(await page.getByText(candidate.body,{exact:true}).count(),0);
 });
});
test('人物切换后旧范围迟到读取不能恢复平铺正文',{timeout:20000},async t=>{
 let hold=false,finish,entered,complete;const pending=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;}),completed=new Promise(resolve=>{complete=resolve;});
 await panel(t,async(_method,input)=>{
  if(hold&&input.scope.scopeKind==='contact'){hold=false;entered();const result=await pending;complete();return result;}
  return {...view(),scope:input.scope,view:{candidates:[{...candidate,scopeKind:input.scope.scopeKind,contactId:input.scope.contactId,body:input.scope.scopeKind==='self'?'本人范围的合成资料':candidate.body}],memories:[]}};
 },async page=>{
  await page.getByText(candidate.body,{exact:true}).waitFor();hold=true;await refreshVisible(page);await started;await page.getByRole('button',{name:'我',exact:true}).click();await page.getByText('本人范围的合成资料',{exact:true}).waitFor();
  finish(view());await completed;await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.getByText(candidate.body,{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'我',exact:true}).getAttribute('aria-pressed'),'true');
 });
});
test('真实释放桥不会把正常对方与本人切换误报为资格失效，卸载仍释放读取',{timeout:20000},async t=>{
 const compiled=await build({entryPoints:['src/main/memory/sqlite-management.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 const deliveries=[],reads=[];let publish=async()=>{},releases=0,finishRelease,holdContact=false,enterOld,finishOld,completeOld;
 const released=new Promise(resolve=>{finishRelease=resolve;});
 const enteredOld=new Promise(resolve=>{enterOld=resolve;}),oldResult=new Promise(resolve=>{finishOld=resolve;}),oldCompleted=new Promise(resolve=>{completeOld=resolve;});
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async request=>{
  if(request.path.startsWith('/api/memory-documents'))return {generation:1,data:{scope:{scopeKind:'contact',contactId:contact},status:'idle',publication:null,documents:[]}};
  if(holdContact&&request.path.includes('scope_kind=contact')){holdContact=false;enterOld();return {generation:1,data:await oldResult};}
  return {generation:1,data:{candidates:[],memories:[]}};
 }},()=>{deliveries.push(publish());},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await panel(t,async(method,input)=>{const result=await(method==='read'?controller.read(input):controller.readDocuments(input));if(method==='read'){reads.push(input.scope.scopeKind);if(result.view.candidates.length)completeOld();}return result;},async page=>{
  publish=()=>page.evaluate(()=>window.invalidate());
  const section=page.getByRole('region',{name:'记忆候选与版本'}),empty=section.getByText('本页没有可展示的正式记忆。',{exact:true});
  await empty.waitFor();await section.getByRole('button',{name:'我',exact:true}).click();
  await Promise.all(deliveries);
  assert.deepEqual(await section.getByRole('alert').allTextContents(),[]);
  await empty.waitFor();await section.getByRole('button',{name:'对方',exact:true}).click();await empty.waitFor();
  await Promise.all(deliveries);assert.deepEqual(await section.getByRole('alert').allTextContents(),[]);assert.deepEqual(reads,['contact','self','contact']);assert.equal(releases,0);
  holdContact=true;await refreshVisible(page);await enteredOld;
  await section.getByRole('button',{name:'我',exact:true}).click();await empty.waitFor();
  finishOld({candidates:[candidate],memories:[]});await oldCompleted;await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await section.getByText(candidate.body,{exact:true}).count(),0);assert.deepEqual(await section.getByRole('alert').allTextContents(),[]);await empty.waitFor();
  controller.synchronize();await Promise.all(deliveries);await section.getByRole('alert').filter({hasText:'资料资格或连接已变化'}).waitFor();
  await section.getByRole('button',{name:'重试读取记忆资料'}).click();await empty.waitFor();
  await page.evaluate(()=>window.unmount());await released;await Promise.all(deliveries);assert.equal(releases,1);
 },true,contact,async()=>{releases++;controller.release();finishRelease();},{initialLevel:'L1'});
});
test('正常空提取完成后，主题资料页显示尚无发布而不是持续处理中',{timeout:20000},async t=>{
 const f=await emptyDocumentFixture(t),run=await f.runEmpty('empty-documents-page');assert.equal(run.status,'completed');
 await panel(t,async(method,input)=>({connectionGeneration:1,scope:input.scope,view:method==='readDocuments'?await f.documents.read(input.scope):{candidates:[],memories:[]}}),async page=>{
  const section=page.getByRole('region',{name:'主题资料与长期概览'});
  await section.getByText('当前尚无已发布的主题资料。',{exact:true}).waitFor();
  assert.equal(await section.getByText('本轮处理中，尚无可用的发布集合。',{exact:true}).count(),0);
 },true,f.contactId);
});
test('记忆自动读取保留未提交编辑，失败后撤下资料且仅显示重试',{timeout:20000},async t=>{
 let calls=0,fail=false,finish,entered;const pending=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 await panel(t,async method=>{
  assert.equal(method,'read');calls++;if(fail)throw new Error('synthetic_read_failure');
  if(calls===2){entered();return pending;}return view();
 },async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});
  await section.getByText(candidate.body,{exact:true}).waitFor();
  assert.equal(await section.getByRole('button',{name:'刷新记忆管理'}).count(),0);
  assert.equal(await section.getByRole('button',{name:'重试读取记忆资料'}).count(),0);
  await section.getByRole('button',{name:'修改并采纳'}).click();const editor=section.getByLabel('修改候选正文');await editor.fill('仍在编辑的合成草稿');
  await refreshVisible(page);await started;assert.equal(await editor.isEnabled(),true);assert.equal(await editor.inputValue(),'仍在编辑的合成草稿');
  finish({...view(),view:{candidates:[candidate,{...candidate,id:'33333333-3333-4333-8333-333333333333',body:'自动到达的新候选'}],memories:[]}});
  await section.getByText('自动到达的新候选',{exact:true}).waitFor();assert.equal(await editor.inputValue(),'仍在编辑的合成草稿');assert.equal(await editor.isEnabled(),true);
  fail=true;await refreshVisible(page);await section.getByRole('alert').filter({hasText:'来源或范围暂不可用'}).waitFor();
  assert.equal(await section.getByLabel('修改候选正文').count(),0);assert.equal(await section.getByText(candidate.body,{exact:true}).count(),0);
  const before=calls;await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(calls,before);
  fail=false;await section.getByRole('button',{name:'重试读取记忆资料'}).click();await section.getByText(candidate.body,{exact:true}).waitFor();assert.equal(await section.getByRole('button',{name:'重试读取记忆资料'}).count(),0);
 });
});
test('空主题资料也自动更新，读取失败时才显示主题重试',{timeout:20000},async t=>{
 let calls=0,fail=false,published=false;
 const documentView=()=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:published?{status:'completed',publication:{id,members:[]},documents:[]}:{status:'idle',publication:null,documents:[]}});
 await panel(t,async method=>{
  if(method==='read')return view();assert.equal(method,'readDocuments');calls++;if(fail)throw new Error('synthetic_documents_failure');return documentView();
 },async page=>{
  const docs=page.getByRole('region',{name:'主题资料与长期概览'});await docs.getByText('当前尚无已发布的主题资料。',{exact:true}).waitFor();
  assert.equal(await docs.getByRole('button',{name:'刷新主题资料'}).count(),0);assert.equal(await docs.getByRole('button',{name:'重试读取主题资料'}).count(),0);
  published=true;await refreshVisible(page);await docs.getByText('主题资料与长期概览已完成发布。',{exact:true}).waitFor();
  fail=true;await refreshVisible(page);await docs.getByRole('alert').filter({hasText:'来源或范围暂不可用'}).waitFor();
  const before=calls;await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(calls,before);
  fail=false;await docs.getByRole('button',{name:'重试读取主题资料'}).click();await docs.getByText('主题资料与长期概览已完成发布。',{exact:true}).waitFor();assert.equal(await docs.getByRole('button',{name:'重试读取主题资料'}).count(),0);
 },true);
});
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
 const v1={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'原先合成状态',formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
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
  await openMemoryMore(section);const undo=section.getByRole('button',{name:'撤销自动更新'});await undo.waitFor();assert.equal(await undo.isDisabled(),true);
  await section.getByRole('button',{name:'解除人工保护'}).click();await section.getByRole('status').filter({hasText:'已解除当前人工保护'}).waitFor();
  await openMemoryMore(section);await undo.click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
  assert.equal(calls[1].action,'restore');assert.equal(calls[1].expectedVersionNo,'2');assert.equal(calls[1].expectedHeadRevision,'8');assert.equal(calls[1].restoredFromVersionNo,'1');assert.deepEqual(calls[1].expectedMergedParents,[]);
  await openMemoryMore(section);await section.getByText('更新历史',{exact:true}).click();await section.getByText('恢复自版本 1，原前驱为版本 2。',{exact:true}).first().waitFor();assert.equal(await undo.count(),0);
  await section.getByRole('button',{name:'修改',exact:true}).click();await section.getByLabel('修正后的正文').fill('错误已纠正');await section.getByRole('button',{name:'保存错误修正'}).click();await section.getByRole('status').filter({hasText:'错误修正成功'}).waitFor();assert.equal(calls[2].action,'correct');
  await openMemoryMore(section);await section.getByRole('button',{name:'记录变化'}).click();await section.getByLabel('变化后的正文').fill('后来状态变化');await section.getByRole('button',{name:'保存变化记录'}).click();await section.getByRole('status').filter({hasText:'变化已记录'}).waitFor();assert.equal(calls[3].action,'change');
 });
});
test('并发冲突与来源失效各有反馈，失效后的迟到读取不能恢复候选正文',{timeout:20000},async t=>{
 let mode='normal',finish,entered;const pending=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 await panel(t,async(method)=>{
  if(method==='decide')return {status:mode==='source'?'source_stale':'conflict'};
  if(mode==='late'){entered();return pending;}return view();
 },async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});await section.getByText('原始合成结论',{exact:true}).waitFor();await section.getByRole('button',{name:'采纳原稿'}).click();await section.getByRole('alert').filter({hasText:'并发冲突'}).waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);
  mode='source';await section.getByRole('button',{name:'重试读取记忆资料'}).click();await section.getByRole('button',{name:'拒绝候选'}).click();await section.getByRole('alert').filter({hasText:'来源或范围已失效'}).waitFor();
  mode='late';await section.getByRole('button',{name:'重试读取记忆资料'}).click();await started;await page.evaluate(()=>window.invalidate());finish(view());await section.getByRole('alert').filter({hasText:'已撤下正文'}).waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);
 });
});
test('决定回执成功而随后读取失败时不冒报资料仍可用，原正文已撤下',{timeout:20000},async t=>{
 let applied=false;await panel(t,async method=>{if(method==='decide'){applied=true;return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:'1',action:'accept'}};}if(applied)throw new Error('synthetic_source_unavailable');return view();},async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});await section.getByRole('button',{name:'采纳原稿'}).click();await section.getByRole('alert').filter({hasText:'决定已保存，但当前资料暂不可读'}).waitFor();assert.equal(await section.getByText('原始合成结论',{exact:true}).count(),0);assert.equal(await section.getByRole('status').filter({hasText:'采纳成功'}).count(),0);
 });
});

test('真实主进程decode到页面：待核验候选与版本保持提示，旧版核验不继承给当前版本',{timeout:20000},async t=>{
 const compiled=await build({entryPoints:['src/main/memory/sqlite-management.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 const old={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'旧版已核验资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const current={...old,verificationState:'pending',versionNo:'2',body:'待核验正式资料',adoptionMode:'user',previousVersionNo:'1'};
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async()=>({generation:1,data:{candidates:[{...candidate,verificationState:'pending'}],memories:[{id,scopeKind:'contact',contactId:contact,headRevision:'2',state:'active',manualProtection:false,current,versions:[old,current],decisions:[]}]}})},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await panel(t,async(method,input)=>{assert.equal(method,'read');return controller.read(input);},async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'}),pending=section.getByRole('article',{name:'记忆候选'});
  await pending.getByText('来源待核验',{exact:true}).waitFor();assert.equal(await pending.getByText('来源已核验',{exact:true}).count(),0);
  await pending.getByText('查看来源',{exact:true}).click();await pending.getByText('合成原话证据',{exact:true}).waitFor();
  await pending.getByRole('button',{name:'采纳原稿'}).waitFor();
  const memory=section.getByRole('article',{name:'正式记忆'}),currentVersion=memory.getByText('待核验正式资料',{exact:true}).first().locator('..');
  await currentVersion.getByText('来源待核验',{exact:true}).waitFor();assert.equal(await currentVersion.getByText('来源已核验',{exact:true}).count(),0);
  await openMemoryMore(memory);await memory.getByText('更新历史',{exact:true}).click();
  const oldVersion=memory.locator('.sqlite-memory-old').filter({hasText:'旧版已核验资料'});await oldVersion.getByText('查看来源',{exact:true}).click();await oldVersion.getByText('来源已核验',{exact:true}).waitFor();
  await memory.getByText('已确认',{exact:true}).first().waitFor();
 });
});

test('多父合并明确展示整组恢复数量，提交当前头CAS并显示退休决定中文来历',{timeout:20000},async t=>{
 const v1={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'合并前资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const v2={...v1,mergeParents:[{memoryId:'33333333-3333-4333-8333-333333333333',versionNo:'1',headRevision:'2'}],mergeParentCount:2,versionNo:'2',body:'两项合并资料',previousVersionNo:'1'};
 let memory={id,scopeKind:'contact',contactId:contact,headRevision:'2',state:'active',manualProtection:false,current:v2,versions:[v1,v2],decisions:['auto_retire','auto_noop'].map((action,index)=>({id:index?'44444444-4444-4444-8444-444444444444':id,action,actorKind:'system',createdAt:'1',expectedHeadRevision:'1',expectedVersionNo:'1',outcome:'applied'}))};
 const calls=[];await panel(t,async(method,input)=>{
  if(method==='read')return {...view(),view:{candidates:[],memories:[memory]}};
  calls.push(input.request);const restored={...v1,versionNo:'3',formationKind:'restore',previousVersionNo:'2',restoredFromVersionNo:'1'};memory={...memory,current:restored,versions:[v1,v2,restored],headRevision:'3'};
  return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:'3',action:'restore'}};
 },async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});await openMemoryMore(section);await section.getByText('更新历史',{exact:true}).click();await section.getByText('系统自动决定 · 已并入合并资料 · 已生效',{exact:true}).waitFor();await section.getByText('系统自动决定 · 跳过重复资料 · 已生效',{exact:true}).waitFor();
  await openMemoryMore(section.getByRole('article',{name:'正式记忆'}).filter({hasText:'两项合并资料'}));await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
  assert.equal(calls[0].action,'restore');assert.equal(calls[0].expectedVersionNo,'2');assert.equal(calls[0].expectedHeadRevision,'2');assert.equal(calls[0].restoredFromVersionNo,'1');assert.deepEqual(calls[0].expectedMergedParents,v2.mergeParents);assert.equal(await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).count(),0);
 });
});

test('真实页面保护父资料后恢复失败，解除并刷新后携带新父头恢复整组',{timeout:20000},async t=>{
 const compiled=await build({stdin:{contents:"export {SqliteMemoryManagementController} from './src/main/memory/sqlite-management';export {BackendRequestFailure} from './src/main/backend/json-client';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {SqliteMemoryManagementController,BackendRequestFailure}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'被合并的原资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const secondaryId='33333333-3333-4333-8333-333333333333';
 let memory={id:secondaryId,scopeKind:'contact',contactId:contact,headRevision:'2',state:'withdrawn',manualProtection:false,current:null,versions:[version],decisions:[]};
 const prior={...version,body:'合并前另一项资料'},merged={...prior,versionNo:'2',body:'两项合并资料',previousVersionNo:'1',mergeParentCount:2,mergeParents:[{memoryId:secondaryId,versionNo:'1',headRevision:'2'}]};
 let primary={...memory,id,state:'active',current:merged,versions:[prior,merged]};const calls=[];
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async r=>{
  if(r.method==='POST'){
   calls.push(r.body);
   if(r.body.action==='restore'){
    if(memory.manualProtection)throw new BackendRequestFailure('response',409,'memory_protected');
    assert.deepEqual(r.body.expectedMergedParents,[{memoryId:secondaryId,versionNo:'1',headRevision:memory.headRevision}]);
    const restored={...prior,versionNo:'3',formationKind:'restore',previousVersionNo:'2',restoredFromVersionNo:'1'};primary={...primary,current:restored,versions:[prior,merged,restored],headRevision:'3'};
    const secondary={...version,versionNo:'2',formationKind:'restore',previousVersionNo:'1',restoredFromVersionNo:'1'};memory={...memory,state:'active',current:secondary,versions:[version,secondary],headRevision:'5'};
   }else memory={...memory,manualProtection:r.body.action==='protect',headRevision:String(Number(memory.headRevision)+1)};
   return {generation:1,data:{decisionId:id,memoryId:r.body.memoryId,versionNo:r.body.action==='restore'?'3':null,action:r.body.action}};
  }
  const current=primary.current.versionNo==='2'?{...merged,mergeParents:[{memoryId:secondaryId,versionNo:'1',headRevision:memory.headRevision}]}:primary.current;
  return {generation:1,data:{candidates:[],memories:[{...primary,current,versions:current.versionNo==='2'?[prior,current]:primary.versions},memory]}};
 }},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await panel(t,(method,input)=>method==='read'?controller.read(input):controller.decide(input),async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'}),secondary=section.getByRole('article',{name:'正式记忆'}).filter({hasText:'当前无可引用版本。'});
  await openMemoryMore(secondary);await secondary.getByRole('button',{name:'开启人工保护'}).click();await section.getByRole('status').filter({hasText:'已开启当前人工保护'}).waitFor();
  assert.equal(await secondary.getByRole('button',{name:'修改',exact:true}).count(),0);assert.equal(await secondary.getByRole('button',{name:'记录变化'}).count(),0);assert.equal(await secondary.getByRole('button',{name:/撤销|恢复合并前资料/}).count(),0);
  await openMemoryMore(section.getByRole('article',{name:'正式记忆'}).filter({hasText:'两项合并资料'}));await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).click();await section.getByRole('alert').filter({hasText:'人工保护'}).waitFor();
  await section.getByRole('button',{name:'重试读取记忆资料'}).click();await openMemoryMore(secondary);await secondary.getByRole('button',{name:'解除人工保护'}).click();await section.getByRole('status').filter({hasText:'已解除当前人工保护'}).waitFor();
  await openMemoryMore(section.getByRole('article',{name:'正式记忆'}).filter({hasText:'两项合并资料'}));await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
  assert.deepEqual(calls.filter(c=>c.action!=='restore').map(c=>[c.action,c.expectedVersionNo,c.expectedHeadRevision]),[['protect','1','2'],['unprotect','1','3']]);assert.equal(calls.at(-1).expectedMergedParents[0].headRevision,'4');assert.equal(primary.current.versionNo,'3');assert.equal(memory.current.versionNo,'2');
 });
});
test('真实decode到页面只展示待确认候选，已处理原稿不占侧栏，已撤销目标无当前版本',{timeout:20000},async t=>{
 const compiled=await build({entryPoints:['src/main/memory/sqlite-management.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 const second='33333333-3333-4333-8333-333333333333',pendingId='44444444-4444-4444-8444-444444444444',adoptedId='55555555-5555-4555-8555-555555555555';
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'合成目标正式资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const memory=(memoryId,state)=>({id:memoryId,scopeKind:'contact',contactId:contact,headRevision:'1',state,manualProtection:false,current:state==='active'?version:null,versions:[version],decisions:[]});
 const candidates=[{...candidate,state:'duplicate',body:'有效目标对应重复原稿'},{...candidate,id:second,state:'duplicate',body:'已撤销目标对应重复原稿'},{...candidate,id:pendingId,body:'尚待决定的独立原稿'},{...candidate,id:adoptedId,state:'adopted',body:'以前明确采纳的原稿'}];
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async()=>({generation:1,data:{candidates,memories:[memory(id,'active'),memory(second,'withdrawn')]}})},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await panel(t,async(method,input)=>{assert.equal(method,'read');return controller.read(input);},async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});
  const pending=section.getByRole('article',{name:'记忆候选'}).filter({hasText:'尚待决定的独立原稿'});await pending.getByRole('button',{name:'采纳原稿',exact:true}).waitFor();
  for(const body of ['有效目标对应重复原稿','已撤销目标对应重复原稿','以前明确采纳的原稿'])assert.equal(await section.getByText(body,{exact:true}).count(),0);
  assert.equal(await section.getByRole('complementary',{name:'待确认记忆'}).getByRole('article',{name:'记忆候选'}).count(),1);
  const withdrawn=section.getByRole('article',{name:'正式记忆'}).filter({hasText:'已撤销'});await withdrawn.getByText('当前无可引用版本。已撤销。',{exact:true}).waitFor();assert.equal(await withdrawn.getByText('当前版本',{exact:false}).count(),0);
 });
});

test('主题旧集合处理中可见，资格失效立即撤下正文和依据且迟到结果不能恢复',{timeout:20000},async t=>{
 const docId='33333333-3333-4333-8333-333333333333';
 const documentView={connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{status:'processing',publication:{id,members:[{documentId:docId,versionNo:'1'}]},documents:[{id:docId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'scene',title:'合成园艺',statements:[{text:'联系人喜欢合成园艺。',kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:id,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'正式合成记忆依据。'}]}]}]}};
 let hold=false,finish,entered;const pending=new Promise(r=>{finish=r;}),started=new Promise(r=>{entered=r;});
 await panel(t,async method=>{
  if(method==='read')return view();
  if(method==='readDocuments'){if(hold){entered();return pending;}return documentView;}
  throw new Error('unexpected command');
 },async page=>{
  const section=page.getByRole('region',{name:'主题资料与长期概览'});
  await section.getByText('联系人喜欢合成园艺。',{exact:true}).waitFor();
  await section.getByText('本轮处理中，当前仍可查看此前已发布资料。',{exact:true}).waitFor();
  await section.getByText('查看依据',{exact:true}).click();await section.getByText(`记忆 ${id} · 版本 1`,{exact:true}).waitFor();await section.getByText('正式合成记忆依据。',{exact:true}).waitFor();
  hold=true;await refreshVisible(page);await started;
  await page.evaluate(()=>window.invalidate());finish(documentView);
  await section.getByRole('alert').filter({hasText:'资料资格尚未重新核验，已撤下正文和依据。'}).waitFor();
  assert.equal(await section.getByText('联系人喜欢合成园艺。',{exact:true}).count(),0);
  assert.equal(await section.getByText(`记忆 ${id} · 版本 1`,{exact:true}).count(),0);assert.equal(await section.getByText('正式合成记忆依据。',{exact:true}).count(),0);
 },true);
});

test('已发布资料在后台来源失效后自动撤下正文和展开依据',{timeout:20000},async t=>{
 const docId='33333333-3333-4333-8333-333333333333';let invalid=false;
 const snapshot=()=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:invalid?{status:'needs_revalidation',publication:null,documents:[]}:{status:'completed',publication:{id,members:[{documentId:docId,versionNo:'1'}]},documents:[{id:docId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'scene',title:'合成主题',statements:[{text:'自动撤回的主题正文',kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:id,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'自动撤回的主题依据'}]}]}]}});
 await panel(t,async method=>method==='read'?view():snapshot(),async page=>{
  const docs=page.getByRole('region',{name:'主题资料与长期概览'});
  await docs.getByText('自动撤回的主题正文',{exact:true}).waitFor();await docs.getByText('查看依据',{exact:true}).click();await docs.getByText('自动撤回的主题依据',{exact:true}).waitFor();
  invalid=true;
  await docs.getByText('来源或资料已失效，等待重新核验。',{exact:true}).waitFor({timeout:5000});
  assert.equal(await docs.getByText('自动撤回的主题正文',{exact:true}).count(),0);assert.equal(await docs.getByText('自动撤回的主题依据',{exact:true}).count(),0);
 },true);
});

test('当前联系人本人视图不显示或请求全局本人概览',{timeout:20000},async t=>{
 const scopes=[];
 await panel(t,async(method,input)=>{
  if(method==='read')return view();
  if(method==='readDocuments'){scopes.push(input.scope.scopeKind);return {connectionGeneration:1,scope:input.scope,view:{status:'idle',publication:null,documents:[]}};}
  throw new Error('unexpected command');
 },async page=>{
  const management=page.getByRole('region',{name:'记忆候选与版本'});
  await management.getByRole('button',{name:'我',exact:true}).click();
  await management.getByRole('button',{name:'L3',exact:true}).click();
  await management.getByText('本人全局概览不在当前联系人页面展示。',{exact:true}).waitFor({timeout:3000});
  assert.equal(await page.getByRole('region',{name:'主题资料与长期概览'}).count(),0);
  assert.ok(scopes.every(kind=>kind==='contact'));
 },true);
});

test('修正资料时间待核验时管理页可查看并标明不能用于生成',{timeout:20000},async t=>{
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'needs_revalidation',versionNo:'1',body:'时间待核验的合成记忆',formationKind:'correction',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const snapshot={connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{candidates:[],memories:[{id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]}]}};
 await panel(t,async method=>method==='read'?snapshot:{connectionGeneration:1,scope:snapshot.scope,view:{status:'idle',publication:null,documents:[]}},async page=>{
  const management=page.getByRole('region',{name:'记忆候选与版本'});
  await management.getByRole('button',{name:'L1',exact:true}).click();
  // 首次保存不展示历史，但影响使用资格的提示仍直接可见。
  await management.getByText('时间待核验，暂不用于生成。',{exact:true}).first().waitFor({timeout:3000});
  assert.equal(await management.getByText('时间待核验，暂不用于生成。',{exact:true}).count(),1);
  await openMemoryMore(management);assert.equal(await management.getByText('更新历史',{exact:true}).count(),0);
  await management.getByText('时间待核验的合成记忆',{exact:true}).first().waitFor();
 },true);
});

test('主题资料区分并发冲突和待核验，待核验时不显示旧集合',{timeout:20000},async t=>{
 const docId='33333333-3333-4333-8333-333333333333';let status='conflict';
 const snapshot=()=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:status!=='invalid'?{status:status==='waiting'?'needs_revalidation':status,publication:{id,members:[{documentId:docId,versionNo:'1'}]},documents:[{id:docId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'profile',title:'长期背景',statements:[{text:'旧集合仍有资格。',kind:'fact',basis:'旧版有依据。',section:'interests',uncertainty:'',temporalStatus:'stable',leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:id,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'合法旧版记忆依据。'}]}]}]}:{status:'needs_revalidation',publication:null,documents:[]}});
 await panel(t,async method=>method==='read'?view():snapshot(),async page=>{
  await page.getByRole('button',{name:'L3',exact:true}).click();
  const section=page.getByRole('region',{name:'主题资料与长期概览'});await section.getByText('本轮存在并发冲突；以下仍是当前可用的已发布资料。',{exact:true}).waitFor();await section.getByText('旧集合仍有资格。',{exact:true}).waitFor();
  status='waiting';await refreshVisible(page);await section.getByText('本轮资料待核验；以下仍是当前可用的已发布资料。',{exact:true}).waitFor();await section.getByText('旧集合仍有资格。',{exact:true}).waitFor();
  status='invalid';await refreshVisible(page);await section.getByText('来源或资料已失效，等待重新核验。',{exact:true}).waitFor();assert.equal(await section.getByText('旧集合仍有资格。',{exact:true}).count(),0);assert.equal(await section.getByText('长期背景',{exact:true}).count(),0);
 },true);
});

test('改变记忆保护时立即撤下主题旧快照，晚到读取不能恢复，成功后重验',{timeout:20000},async t=>{
 const docId='33333333-3333-4333-8333-333333333333';
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'合成正式资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const memory={id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]};
 const old={connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{status:'completed',publication:{id,members:[{documentId:docId,versionNo:'1'}]},documents:[{id:docId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'scene',title:'合成主题',statements:[{text:'旧主题正文',kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:id,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'旧主题依据'}]}]}]}};
 let docCalls=0,releaseRead,releaseDecision,enteredRead,enteredDecision;const heldRead=new Promise(r=>{releaseRead=r;}),heldDecision=new Promise(r=>{releaseDecision=r;}),readStarted=new Promise(r=>{enteredRead=r;}),decisionStarted=new Promise(r=>{enteredDecision=r;});
 await panel(t,async method=>{
  if(method==='read')return {...view(),view:{candidates:[],memories:[memory]}};
  if(method==='readDocuments'){if(++docCalls===1)return old;if(docCalls===2){enteredRead();return heldRead;}return {...old,view:{status:'needs_revalidation',publication:null,documents:[]}};}
  if(method==='decide'){enteredDecision();await heldDecision;return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:null,action:'protect'}};}
 },async page=>{
  const management=page.getByRole('region',{name:'记忆候选与版本'}),docs=page.getByRole('region',{name:'主题资料与长期概览'});
  await docs.getByText('旧主题正文',{exact:true}).waitFor();await docs.getByText('查看依据',{exact:true}).click();await docs.getByText('旧主题依据',{exact:true}).waitFor();
  await refreshVisible(page);await readStarted;
  await management.getByRole('button',{name:'L1',exact:true}).click();
  await openMemoryMore(management);await management.getByRole('button',{name:'开启人工保护'}).click();await decisionStarted;
  await management.getByRole('button',{name:'L2',exact:true}).click();
  assert.equal(await page.getByText('旧主题正文',{exact:true}).count(),0);assert.equal(await page.getByText('旧主题依据',{exact:true}).count(),0);
  releaseRead(old);assert.equal(await page.getByText('旧主题正文',{exact:true}).count(),0);
  releaseDecision();await management.getByRole('button',{name:'L1',exact:true}).click();await management.getByRole('status').filter({hasText:'已开启当前人工保护'}).waitFor();await management.getByRole('button',{name:'L2',exact:true}).click();
  await page.getByRole('region',{name:'主题资料与长期概览'}).getByText('来源或资料已失效，等待重新核验。',{exact:true}).waitFor();
  assert.equal(await page.getByText('旧主题正文',{exact:true}).count(),0);assert.equal(await page.getByText('旧主题依据',{exact:true}).count(),0);
 },true);
});

test('记忆决定失败或资格失效后的迟到回执不能恢复主题旧正文',{timeout:25000},async t=>{
 const docId='33333333-3333-4333-8333-333333333333';
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'可管理记忆',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const memory={id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]};
 const old={connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{status:'completed',publication:{id,members:[{documentId:docId,versionNo:'1'}]},documents:[{id:docId,versionNo:'1',scopeKind:'contact',contactId:contact,kind:'scene',title:'旧主题',statements:[{text:'不可复活的旧主题',kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:id,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'不可复活的旧依据'}]}]}]}};
 for(const mode of ['conflict','late'])await t.test(mode,async sub=>{
  let release,entered,docReads=0;const pending=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  await panel(sub,async method=>{
   if(method==='read')return {...view(),view:{candidates:[],memories:[memory]}};
   if(method==='readDocuments'){docReads++;return docReads===1?old:{...old,view:{status:'needs_revalidation',publication:null,documents:[]}};}
   if(method==='decide'){entered();if(mode==='late'){await pending;return {status:'applied',result:{decisionId:id,memoryId:id,versionNo:null,action:'protect'}};}return {status:'conflict'};}
  },async page=>{
   const management=page.getByRole('region',{name:'记忆候选与版本'});
   await page.getByText('不可复活的旧主题',{exact:true}).waitFor();
   await management.getByRole('button',{name:'L1',exact:true}).click();
   await openMemoryMore(management);await management.getByRole('button',{name:'开启人工保护'}).click();await started;
   if(mode==='late'){await page.evaluate(()=>window.invalidate());release();}
   else await management.getByRole('alert').filter({hasText:'并发冲突'}).waitFor();
   await management.getByRole('button',{name:'L2',exact:true}).click();
   await page.getByRole('region',{name:'主题资料与长期概览'}).getByText('资料资格尚未重新核验，已撤下正文和依据。',{exact:true}).waitFor();
   assert.equal(await page.getByText('不可复活的旧主题',{exact:true}).count(),0);
   assert.equal(await page.getByText('不可复活的旧依据',{exact:true}).count(),0);
   if(mode==='late')assert.equal(await management.getByRole('status').filter({hasText:'已开启当前人工保护'}).count(),0);
  },true);
 });
});

test('图片来源明确显示模型观察和固定版本，不伪装成文字引文',async t=>{
 const image={...source,quote:'',contentKind:'image',contentRef:{file_id:id,sha256:'a'.repeat(64),mime_type:'image/png',media_generation:'0'},description:'日程卡显示每周六练习吉他'};
 await panel(t,async()=>({...view(),view:{candidates:[{...candidate,sources:[image]}],memories:[]}}),async page=>{
  await page.getByText('原始合成结论',{exact:true}).waitFor();
  await page.getByText('查看来源',{exact:true}).click();
  await page.getByText('图片依据',{exact:true}).waitFor();
  await page.getByText('模型观察：日程卡显示每周六练习吉他',{exact:true}).waitFor();
  assert.equal(await page.locator('blockquote').count(),0);
  await page.getByText('来源定位',{exact:true}).click();
  await page.getByText(`图片版本：${id}`,{exact:true}).waitFor();
  await page.screenshot({path:'/tmp/notalone-image-memory-evidence.png'});
 });
});


test('记忆页预加载后切回直接显示，隐藏时暂停刷新但持续撤下失效资料',{timeout:20000},async t=>{
 let reads=0,hold=false,finish;
 await panel(t,async method=>{
  assert.equal(method,'read');reads++;
  if(hold)return new Promise(resolve=>{finish=resolve;});
  return view();
 },async page=>{
  const text=page.getByText(candidate.body,{exact:true});await text.waitFor();
  await page.evaluate(()=>window.setPanelVisible(false));await page.evaluate(()=>new Promise(requestAnimationFrame));
  const before=reads;await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(reads,before,'隐藏页面不继续读取');
  hold=true;
  const opened=await page.evaluate(async()=>{const start=performance.now();window.setPanelVisible(true);await new Promise(requestAnimationFrame);return {elapsed:performance.now()-start,loading:document.body.textContent.includes('正在核对记忆资料'),body:document.body.textContent.includes('原始合成结论')};});
  assert.equal(opened.loading,false);assert.equal(opened.body,true);t.diagnostic(`预加载后切回首帧 ${opened.elapsed.toFixed(1)}ms，无核对提示`);
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await text.isVisible(),true);
  await page.evaluate(()=>window.setPanelVisible(false));await page.evaluate(()=>window.invalidate());
  assert.equal(await text.count(),0,'隐藏时失效也立即清除资料');
  if(finish){hold=false;finish(view());}
  await page.evaluate(()=>window.setPanelVisible(true));await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await text.count(),0,'旧在途结果不能恢复失效资料');
  await page.getByRole('button',{name:'重试读取记忆资料'}).click();await text.waitFor();
  await page.evaluate(()=>{window.setPanelVisible(false);window.setPanelContact(null);});await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await text.count(),0,'切换范围立即清除旧正文');
 });
});


test('相同延迟下记忆切页复用首帧，不等待重新核对',{timeout:20000},async t=>{
 const results=[];
 for(const keepMounted of [false,true]){
  await panel(t,async()=>{await new Promise(resolve=>setTimeout(resolve,200));return view();},async page=>{
   const text=page.getByText(candidate.body,{exact:true});await text.waitFor();const samples=[];
   for(let index=0;index<3;index++){
    await page.evaluate(()=>window.setPanelVisible(false));await page.evaluate(()=>new Promise(requestAnimationFrame));
    const first=await page.evaluate(async()=>{window.openedAt=performance.now();window.setPanelVisible(true);await new Promise(requestAnimationFrame);return {loading:document.body.textContent.includes('正在核对记忆资料'),body:document.body.textContent.includes('原始合成结论')};});
    await text.waitFor();samples.push(await page.evaluate(()=>performance.now()-window.openedAt));
    assert.equal(first.loading,!keepMounted);assert.equal(first.body,keepMounted);
   }
   results.push({keepMounted,samples:samples.map(value=>Number(value.toFixed(1)))});
  },false,contact,async()=>{},{keepMounted});
 }
 t.diagnostic(`相同 200ms 只读桥延迟，三次切回可见耗时(ms)：${JSON.stringify(results)}`);
});


test('主题资料预加载后切层与切页保留正文，隐藏层不轮询',{timeout:20000},async t=>{
 let reads=0;
 await panel(t,async method=>{if(method==='readDocuments'){reads++;return flatDocuments();}return view();},async page=>{
  const body=page.getByText('园艺主题的合成正文',{exact:true});await body.waitFor();
  await page.getByRole('button',{name:'L1',exact:true}).click();const before=reads;
  await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(reads,before);
  await page.evaluate(()=>window.setPanelVisible(false));await page.evaluate(()=>new Promise(requestAnimationFrame));
  await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(reads,before);
  await page.evaluate(()=>window.setPanelVisible(true));await page.getByRole('button',{name:'L2',exact:true}).click();
  assert.equal(await body.isVisible(),true);assert.equal(await page.getByText('正在核对主题资料…',{exact:true}).count(),0);
 },true);
});


test('记忆列表与展开历史逐页替换，未展开不读取旧版，末页禁用继续',{timeout:20000},async t=>{
 const calls=[],revision='a'.repeat(64);
 const current=index=>({mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'43',body:`第${index+1}条合成记忆`,formationKind:'correction',adoptionMode:'user',previousVersionNo:'42',restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]});
 const memory=index=>({id:`${(index+1).toString(16).padStart(8,'0')}-3333-4333-8333-333333333333`,scopeKind:'contact',contactId:contact,headRevision:'43',state:'active',manualProtection:false,current:current(index),versions:[current(index)],decisions:[]});
 await panel(t,async(method,input)=>{
  calls.push({method,input});
  if(method==='readHistory'){
   const offset=Number(input.cursor?.slice(1)??0),numbers=Array.from({length:Math.min(20,43-offset)},(_,index)=>43-offset-index).reverse();
   return {connectionGeneration:1,scope:input.scope,view:{memoryId:input.memoryId,headRevision:'43',revision,versions:numbers.map(n=>({...current(0),versionNo:String(n),body:`历史版本${n}`,previousVersionNo:n===1?null:String(n-1)})),decisions:[],nextCursor:offset+20<43?`h${offset+20}`:null}};
  }
  const offset=Number(input.cursor?.slice(1)??0);
  return {...view(),view:{candidates:[],memories:Array.from({length:Math.min(20,45-offset)},(_,index)=>memory(offset+index)),page:{revision,nextCursor:offset+20<45?`p${offset+20}`:null}}};
 },async page=>{
  await page.getByText('第1条合成记忆',{exact:true}).waitFor();assert.equal(await page.getByRole('article',{name:'正式记忆',exact:true}).count(),20);assert.equal(calls.filter(call=>call.method==='readHistory').length,0);
  await page.getByRole('button',{name:'下一页记忆',exact:true}).click();await page.getByText('第21条合成记忆',{exact:true}).waitFor();assert.equal(await page.getByText('第1条合成记忆',{exact:true}).count(),0);assert.equal(await page.getByRole('article',{name:'正式记忆',exact:true}).count(),20);
  await page.getByRole('button',{name:'下一页记忆',exact:true}).click();await page.getByText('第41条合成记忆',{exact:true}).waitFor();assert.equal(await page.getByRole('article',{name:'正式记忆',exact:true}).count(),5);assert.equal(await page.getByRole('button',{name:'下一页记忆',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'上一页记忆',exact:true}).click();await page.getByText('第21条合成记忆',{exact:true}).waitFor();
  await openMemoryMore(page.getByRole('article',{name:'正式记忆'}).first());assert.equal(calls.filter(call=>call.method==='readHistory').length,0);await page.getByText('更新历史',{exact:true}).first().click();await page.getByText('历史版本43',{exact:true}).waitFor();assert.equal(calls.filter(call=>call.method==='readHistory').length,1);assert.equal(await page.locator('.memory-version-history[open] .sqlite-memory-body').count(),20);
  await page.getByRole('button',{name:'更早的版本与决定',exact:true}).click();await page.getByText('历史版本23',{exact:true}).waitFor();assert.equal(await page.getByText('历史版本43',{exact:true}).count(),0);
  await page.getByRole('button',{name:'更早的版本与决定',exact:true}).click();await page.getByText('历史版本1',{exact:true}).waitFor();assert.equal(await page.locator('.memory-version-history[open] .sqlite-memory-body').count(),3);assert.equal(await page.getByRole('button',{name:'更早的版本与决定',exact:true}).isDisabled(),true);
  for(const stylesheet of ['style.css','memory.css'])await page.addStyleTag({content:await readFile(new URL(`../src/renderer/${stylesheet}`,import.meta.url),'utf8')});
  await page.setViewportSize({width:680,height:850});await page.locator('.sqlite-memory-management').screenshot({path:'/tmp/notalone-management-pagination-preview.png'});
  await page.evaluate(()=>window.invalidate());await page.getByRole('alert').filter({hasText:'已撤下正文'}).waitFor();assert.equal(await page.getByText('历史版本1',{exact:true}).count(),0);
 },false,contact,async()=>{},{withHistory:true});
});


test('目录准备明确显示进度并短间隔继续，不冒充当前范围为空',{timeout:10000},async t=>{
 let reads=0;
 await panel(t,async()=>++reads===1?{...view(),view:{candidates:[],memories:[],page:{revision:'a'.repeat(64),nextCursor:null,preparing:true}}}:view(),async page=>{
  await page.getByRole('status').filter({hasText:'正在准备记忆列表'}).waitFor();assert.equal(await page.getByText('本页没有可展示的正式记忆。',{exact:true}).count(),0);
  await page.getByText(candidate.body,{exact:true}).waitFor();assert.equal(reads,2);assert.equal(await page.getByRole('status').filter({hasText:'正在准备记忆列表'}).count(),0);
 });
});

for(const redactedCurrent of [false,true])test(`同头版本列表刷新重新核验展开历史，迟到旧页不能恢复正文（当前版${redactedCurrent?'失效':'仍有效'}）`,{timeout:15000},async t=>{
 const current={mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'2',body:'独立的当前合成版本',formationKind:'correction',adoptionMode:'user',previousVersionNo:'1',restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const old={...current,versionNo:'1',body:'仅旧来源支持的合成历史',previousVersionNo:null};
 const cleared={...old,body:null,contentState:'redacted',provenanceState:'invalidated',sources:[]};
 let refreshed=false,historyReads=0,releaseLate;const cursors=[],late=new Promise(resolve=>{releaseLate=resolve;});
 const historical=version=>({connectionGeneration:1,scope:{scopeKind:'contact',contactId:contact},view:{memoryId:id,headRevision:'2',revision:'a'.repeat(64),versions:[version],decisions:[],nextCursor:'older'}});
 await panel(t,async(method,input)=>{
  if(method==='readHistory'){cursors.push(input.cursor);historyReads++;if(historyReads===2)return late;return historical(refreshed?cleared:old);}
  const latest=refreshed&&redactedCurrent?{...current,body:null,contentState:'redacted',provenanceState:'invalidated',sources:[]}:current;
  return {...view(),view:{candidates:[],memories:[{id,scopeKind:'contact',contactId:contact,headRevision:'2',state:'active',manualProtection:false,current:latest.body===null?null:latest,versions:[latest],decisions:[]}],page:{revision:'a'.repeat(64),nextCursor:null}}};
 },async page=>{
  await page.getByText(current.body,{exact:true}).waitFor();assert.equal(historyReads,0);
  await openMemoryMore(page);await page.getByText('更新历史',{exact:true}).click();await page.getByText(old.body,{exact:true}).waitFor();
  await page.getByRole('button',{name:'更早的版本与决定',exact:true}).click();
  refreshed=true;await refreshVisible(page);
  await page.getByText('正文已清除或来源已失效。',{exact:true}).waitFor();
  assert.equal(await page.getByText(old.body,{exact:true}).count(),0);assert.equal(historyReads,3);assert.deepEqual(cursors,[undefined,'older','older']);
  releaseLate(historical(old));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByText(old.body,{exact:true}).count(),0);assert.equal(await page.getByText(current.body,{exact:true}).count(),redactedCurrent?0:1);
  await page.getByText('更新历史',{exact:true}).click();await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(historyReads,3,'折叠历史不因列表刷新请求旧版');
  await page.getByText('更新历史',{exact:true}).click();await page.getByText('正文已清除或来源已失效。',{exact:true}).waitFor();assert.equal(historyReads,4);
  await page.getByText('更多',{exact:true}).click();await refreshVisible(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(historyReads,4,'收起更多后不再读取已展开的历史');assert.equal(await page.getByText('正文已清除或来源已失效。',{exact:true}).count(),0);
 },false,contact,async()=>{},{withHistory:true});
});


test('已采纳原稿按需从首次记忆历史读取，无待确认项时主栏铺满且来源失效撤下原稿',{timeout:20000},async t=>{
 const compiled=await build({entryPoints:['src/main/memory/sqlite-management.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'1',body:'修改后的正式记忆',formationKind:'adoption',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const original={...candidate,state:'adopted',body:'采纳前保留的合成原稿'};
 const memory={id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]};
 let historyReads=0;
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async request=>{
  const history=request.path.startsWith('/api/memory-management/history?');if(history)historyReads++;
  return {generation:1,data:history?{memoryId:id,headRevision:'1',revision:'a'.repeat(64),nextCursor:null,versions:[{...version,originalCandidates:[original]}],decisions:[]}:{candidates:[original],memories:[memory]}};
 }},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await panel(t,(method,input)=>method==='readHistory'?controller.readHistory(input):controller.read(input),async page=>{
  const card=page.getByRole('article',{name:'正式记忆',exact:true});await card.getByText(version.body,{exact:true}).waitFor();
  for(const stylesheet of ['style.css','memory.css'])await page.addStyleTag({content:await readFile(new URL(`../src/renderer/${stylesheet}`,import.meta.url),'utf8')});
  await page.addStyleTag({content:'#root {padding:32px;max-width:1100px;margin:auto;}'});
  assert.equal(await page.locator('.memory-candidates-aside').count(),0);assert.equal(await page.getByText(original.body,{exact:true}).count(),0);
  assert.equal(historyReads,0);
  for(const width of [1100,680,380]){
   await page.setViewportSize({width,height:900});
   const bounds=await page.locator('.memory-timeline-layout').evaluate(el=>({full:Math.abs(el.getBoundingClientRect().width-el.firstElementChild.getBoundingClientRect().width)<1,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}));
   assert.deepEqual(bounds,{full:true,overflow:false});
  }
  await page.setViewportSize({width:1100,height:900});await page.locator('.sqlite-memory-management').screenshot({path:'/tmp/notalone-memory-without-candidates.png'});
  await openMemoryMore(card);assert.equal(historyReads,0);
  await card.getByText('更新历史',{exact:true}).click();await card.getByText('提取原稿',{exact:true}).waitFor();assert.equal(historyReads,1);
  await card.getByText('提取原稿',{exact:true}).click();const draft=card.getByRole('article',{name:'已采纳原稿',exact:true});await draft.getByText(original.body,{exact:true}).waitFor();
  assert.equal(await draft.getByRole('button').count(),0);await draft.getByText('查看来源',{exact:true}).click();await draft.getByText(source.quote,{exact:true}).waitFor();
  await page.locator('.sqlite-memory-management').screenshot({path:'/tmp/notalone-memory-original-in-history.png'});
  await page.evaluate(()=>window.invalidate());await page.getByRole('alert').waitFor();
  assert.equal(await page.getByText(original.body,{exact:true}).count(),0);assert.equal(await page.getByText(source.quote,{exact:true}).count(),0);
 },false,contact,async()=>{},{withHistory:true});
});
