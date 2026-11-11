import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const ids={run:'11111111-1111-4111-8111-111111111111',task:'22222222-2222-4222-8222-222222222222',contact:'33333333-3333-4333-8333-333333333333'};
const run=()=>({runId:ids.run,state:'incomplete',total:1,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',status:'blocked',statusReason:'later_stages_pending',sharedFaultCode:null,actions:[],controlVersion:0,pending:0,revoked:0,calls:{prepared:0,sending:0,succeeded:4,failed:0,unknown:0},
 tasks:[{taskId:ids.task,scopeKind:'contact',contactId:ids.contact,state:'succeeded',total:1,succeeded:1,errorCode:null}],inputs:[],candidates:[]});
async function withPanel(t,command,testPage,automaticEnabled=true){
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {FixedMemoryProcessingPanel} from './src/renderer/FixedMemoryProcessingPanel';
 const listeners=new Set();window.invalidate=()=>{for(const listener of listeners)listener();};const bridge=new Proxy({},{get:(_,method)=>method==='onInvalidated'?(listener)=>{listeners.add(listener);return()=>listeners.delete(listener);}:(...args)=>window.command(method,...args)});const root=createRoot(document.getElementById('root'));let contactId='${ids.contact}',pageVisible=true;window.show=mounted=>root.render(mounted?<div hidden={!pageVisible}><FixedMemoryProcessingPanel bridge={bridge} contactId={contactId} visible={pageVisible}/></div>:null);window.setPageVisible=visible=>{pageVisible=visible;window.show(true);};window.selectContact=id=>{contactId=id;window.show(true);};window.show(true);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);
 await page.exposeFunction('command',async(method,...args)=>{if(method==='readAutomatic')return {connectionGeneration:1,enabled:automaticEnabled};const value=await command(method,...args);return method==='readCurrent'&&value&&!Object.hasOwn(value,'contactId')?{...value,contactId:args[0]?.contactId}:value;});await page.route('http://127.0.0.1/fixed-memory-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/fixed-memory-test');await page.addScriptTag({content:compiled.outputFiles[0].text});await testPage(page);
}
// 回到可见页面走正式的自动状态读取，不通过已移除的刷新按钮。
const revisit=page=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));

test('切换联系人读取各自状态，旧范围迟到不回填，未选联系人不读取全局',async t=>{
 const other='44444444-4444-4444-8444-444444444444',entered=Promise.withResolvers(),late=Promise.withResolvers();let first=true;
 const reads=[],failed={...run(),state:'failed',succeeded:0,total:8,failed:8,status:'blocked',statusReason:'contact_failed',tasks:[{...run().tasks[0],state:'failed',total:8,succeeded:0,errorCode:'memory_extraction_source_insufficient'}]};
 await withPanel(t,async(method,input)=>{
  if(method!=='readCurrent')return;
  reads.push(input?.contactId);
  if(first){first=false;entered.resolve();return late.promise;}
  if(input?.contactId===other)return {connectionGeneration:1,contactId:other,run:null};
  return {connectionGeneration:1,contactId:ids.contact,run:failed};
 },async page=>{
  await entered.promise;
  await page.evaluate(id=>window.selectContact(id),other);
  await page.getByText('暂无处理记录',{exact:true}).waitFor();
  assert.deepEqual(reads,[ids.contact,other]);
  late.resolve({connectionGeneration:1,contactId:ids.contact,run:failed});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('处理受阻',{exact:true}).count(),0);
  await page.evaluate(()=>window.selectContact(null));
  await page.getByText('请先选择联系人，再查看记忆处理状态。',{exact:true}).waitFor();
  assert.equal(reads.length,2);
  await page.evaluate(id=>window.selectContact(id),ids.contact);
  await page.getByText('提取结果未通过来源核验，本轮尚未完成。',{exact:true}).waitFor();
  assert.equal(await page.getByText('部分联系人处理受阻',{exact:true}).count(),0);
 });
});

test('当前来源范围已撤销时，不把历史提取失败当作当前受阻原因',async t=>{
 const current={...run(),state:'revoked',status:'blocked',statusReason:'run_revoked',revoked:1,
  tasks:[{...run().tasks[0],state:'revoked',errorCode:'memory_extraction_source_insufficient'}]};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:undefined,async page=>{
  await page.getByText('范围已失效',{exact:true}).waitFor();
  assert.equal(await page.getByText('提取结果未通过来源核验，本轮尚未完成。',{exact:true}).count(),0);
 });
});

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
   current={...run(),...projection,total:2,succeeded:1,actions:[],laterStages:projection.status==='completed'?'completed':'pending',candidates:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,body:'不在状态卡重复展示的合成候选',state:'verified_pending_decision',origin:'auto'}]};
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
  await panel.getByText('最近一批提取与核验：已处理 1 / 3 条消息目标',{exact:true}).waitFor();
  const progress=panel.getByRole('progressbar',{name:'消息提取与核验进度'});
  assert.equal(await progress.getAttribute('value'),'1');assert.equal(await progress.getAttribute('max'),'3');
  current={...current,succeeded:3,pending:0};
  await panel.getByText('最近一批提取与核验：已处理 3 / 3 条消息目标',{exact:true}).waitFor();
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
  assert.equal(await panel.getByText('最近一批提取与核验：已处理 99 / 99 条消息目标',{exact:true}).count(),0);
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

test('后续阶段合并等待显示实际阶段与到期时间，页面保持只读', {timeout:20000},async t=>{
 let current={...run(),status:'waiting',statusReason:'later_stages_scheduled',stage:'document_scene',nextDueAt:Date.now()+3_600_000};
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:current}:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByRole('status').filter({hasText:'等待整理主题资料'}).waitFor();
  await panel.getByText(/预计.*开始/).waitFor();
  current={...current,stage:'document_profile'};await revisit(page);
  await panel.getByRole('status').filter({hasText:'等待更新长期概览'}).waitFor();
  assert.equal(await panel.getByText('本轮已完成',{exact:true}).count(),0);
  assert.equal(await panel.getByRole('button').count(),0);
 });
});

test('首轮尚未建立时显示真实待提取队列，旧轮完成不掩盖新消息', {timeout:20000},async t=>{
 let current={connectionGeneration:1,run:null,queue:{pending:4,nextDueAt:Date.now()+600_000,blockedContacts:0}};
 await withPanel(t,async method=>method==='readCurrent'?current:undefined,async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText(/增量待提取消息 4 条/).waitFor();
  current={...current,run:{...run(),status:'completed',state:'completed',stage:'completed',laterStages:'completed'},queue:{pending:6,nextDueAt:null,blockedContacts:1}};
  await revisit(page);await panel.getByText(/增量待提取消息 6 条/).waitFor();
  await panel.getByText(/当前联系人已暂停或受阻/).waitFor();
  await panel.getByRole('status').filter({hasText:'等待提取与核验'}).waitFor();
  assert.equal(await panel.getByText('本轮已完成',{exact:true}).count(),0);
  assert.equal(await panel.getByRole('button').count(),0);
 });
});

test('图文目标分别显示真实处理量，未就绪图片不计为已处理',async t=>{
 await withPanel(t,async()=>({connectionGeneration:1,run:{...run(),total:3,succeeded:2,contentCounts:[{kind:'text',total:2,succeeded:2},{kind:'image',total:1,succeeded:0}]},queue:{pending:1,nextDueAt:null,blockedContacts:0,content:[{kind:'image',pending:1,unavailable:2}]}}),async page=>{
  await page.getByText('文字：已处理 2 / 2 条',{exact:true}).waitFor();
  await page.getByText('图片：已处理 0 / 1 条',{exact:true}).waitFor();
  await page.getByText('图片尚未就绪 2 条，未计为已处理。',{exact:true}).waitFor();
  await page.screenshot({path:'/tmp/notalone-image-memory-progress.png'});
 });
});


test('记忆页隐藏后暂停处理状态轮询，失效仍撤下且返回时重新读取',{timeout:20000},async t=>{
 let reads=0;
 await withPanel(t,async method=>{if(method==='readCurrent'){reads++;return {connectionGeneration:1,run:null};}},async page=>{
  await page.getByText('暂无处理记录',{exact:true}).waitFor();
  await page.evaluate(()=>window.setPageVisible(false));await page.evaluate(()=>new Promise(requestAnimationFrame));
  const before=reads;await revisit(page);await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(reads,before);
  await page.evaluate(()=>window.invalidate());await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(await page.getByText('暂无处理记录',{exact:true}).count(),0);
  await page.evaluate(()=>window.setPageVisible(true));await page.getByText('暂无处理记录',{exact:true}).waitFor();assert.equal(reads,before+1);
 });
});

test('裁决类未知回执提供放弃重试：需二次确认，确认后携带控制修订与操作标识', {timeout:20000},async t=>{
 const unknownRun={...run(),status:'blocked',statusReason:'model_receipt_unknown',unknown:1,actions:['abandon_unknown'],controlVersion:3,calls:{prepared:0,sending:0,succeeded:0,failed:0,unknown:1}};
 let current=unknownRun;const abandoned=[];
 await withPanel(t,async(method,input)=>{
  if(method==='readCurrent')return {connectionGeneration:2,run:current};
  if(method==='abandonUnknown'){abandoned.push(input);current={...unknownRun,statusReason:'later_stages_pending',unknown:0,actions:[],controlVersion:4,calls:{...unknownRun.calls,unknown:0,failed:1}};return {connectionGeneration:2,run:current};}
 },async page=>{
  const panel=page.getByRole('region',{name:'固定范围记忆处理'});
  await panel.getByText('调用结果待核实',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'恢复本轮处理'}).count(),0,'只发布放弃动作时不显示继续');
  await panel.getByText('费用仍记为未知',{exact:false}).waitFor();
  await panel.getByRole('button',{name:'放弃未知调用并重试'}).click();
  assert.equal(abandoned.length,0,'首次点击只进入确认');
  await panel.getByRole('button',{name:'取消'}).click();
  await panel.getByRole('button',{name:'放弃未知调用并重试'}).click();
  await panel.getByRole('button',{name:'确认放弃并重试'}).click();
  await panel.getByRole('button').first().waitFor({state:'detached'});
  assert.equal(abandoned.length,1);
  assert.equal(abandoned[0].runId,ids.run);assert.equal(abandoned[0].controlVersion,3);assert.equal(abandoned[0].connectionGeneration,2);
  assert.match(abandoned[0].operationId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 });
});

test('隔离图片显示中文原因与窄重试入口，防重且完成后重新读取权威状态',async t=>{
 let current={connectionGeneration:1,run:{...run(),total:3,succeeded:1,isolated:2,actions:['retry_images'],controlVersion:4,
  contentCounts:[{kind:'image',total:3,succeeded:1,isolated:2}]},queue:{pending:0,nextDueAt:null,blockedContacts:0,content:[{kind:'image',pending:0,unavailable:0,isolated:2}]}};
 const requested=Promise.withResolvers(),finish=Promise.withResolvers(),requests=[];
 await withPanel(t,async(method,input)=>{
  if(method==='readCurrent')return current;
  if(method==='retryImages'){requests.push(input);requested.resolve();await finish.promise;return current;}
 },async page=>{
  await page.getByText('2 张图片未能送入模型',{exact:true}).waitFor();
  const retry=page.getByRole('button',{name:'稍后重试图片',exact:true});await retry.click();await requested.promise;
  assert.equal(await page.getByRole('button',{name:'正在登记重试…'}).isDisabled(),true);
  await page.getByRole('button',{name:'正在登记重试…'}).evaluate(button=>button.click());assert.equal(requests.length,1);
  assert.equal(requests[0].runId,ids.run);assert.equal(requests[0].controlVersion,4);assert.equal(requests[0].connectionGeneration,1);assert.match(requests[0].operationId,/^[a-f0-9-]{36}$/);
  current={...current,run:{...current.run,isolated:0,actions:[],contentCounts:[{kind:'image',total:3,succeeded:1,isolated:0}]},queue:{...current.queue,content:[{kind:'image',pending:2,unavailable:0,isolated:0}]}};
  finish.resolve();await page.getByText('2 张图片未能送入模型',{exact:true}).waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'稍后重试图片',exact:true}).count(),0);
 });
});

test('总开关关闭时图片重试禁用，其他历史轮的隔离数量不冒充当前轮可重试',async t=>{
 const calls=[],current={connectionGeneration:1,run:{...run(),total:3,succeeded:1,isolated:2,actions:['retry_images']},
  queue:{pending:0,nextDueAt:null,blockedContacts:0,content:[{kind:'image',pending:0,unavailable:0,isolated:5}]}};
 await withPanel(t,async method=>{calls.push(method);if(method==='readCurrent')return current;},async page=>{
  await page.getByText('2 张图片未能送入模型',{exact:true}).waitFor();
  await page.getByText('另有 3 张图片未能送入模型，保留在原处理记录中。',{exact:true}).waitFor();
  const retry=page.getByRole('button',{name:'稍后重试图片',exact:true});assert.equal(await retry.isDisabled(),true);assert.equal(await retry.getAttribute('class'),'button');
  await retry.evaluate(button=>button.click());assert.equal(calls.includes('retryImages'),false);
 },false);
});

test('只有历史隔离计数或缺少后端资格时不显示图片重试按钮',async t=>{
 await withPanel(t,async method=>method==='readCurrent'?{connectionGeneration:1,run:{...run(),isolated:0,actions:[]},
  queue:{pending:0,nextDueAt:null,blockedContacts:0,content:[{kind:'image',pending:0,unavailable:0,isolated:2}]}}:undefined,async page=>{
  await page.getByText('另有 2 张图片未能送入模型，保留在原处理记录中。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'稍后重试图片',exact:true}).count(),0);
 });
});

test('图片重试失败保留幂等标识，切换联系人后旧回执不回填或刷新旧范围',async t=>{
 const other='44444444-4444-4444-8444-444444444444',requests=[],reads=[],finish=Promise.withResolvers(),entered=Promise.withResolvers();let attempts=0;
 await withPanel(t,async(method,input)=>{
  if(method==='readCurrent'){reads.push(input.contactId);return {connectionGeneration:1,contactId:input.contactId,run:input.contactId===other?null:{...run(),total:3,succeeded:1,isolated:2,actions:['retry_images'],controlVersion:4}};}
  if(method==='retryImages'){requests.push(input);if(++attempts===1)throw new Error('synthetic_failure');entered.resolve();return finish.promise;}
 },async page=>{
  const retry=page.getByRole('button',{name:'稍后重试图片',exact:true});await retry.click();
  await page.getByText('图片重试结果暂未确认，请核对最新状态后重试。',{exact:true}).waitFor();await retry.click();await entered.promise;
  assert.equal(requests.length,2);assert.equal(requests[0].operationId,requests[1].operationId);
  await page.evaluate(id=>window.selectContact(id),other);await page.getByText('暂无处理记录',{exact:true}).waitFor();
  const count=reads.length;finish.resolve({connectionGeneration:1,run:run()});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(reads.length,count);assert.equal(await page.getByText('2 张图片未能送入模型',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'稍后重试图片',exact:true}).count(),0);
 });
});
