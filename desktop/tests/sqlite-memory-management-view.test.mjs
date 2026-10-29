import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const contact='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const source={contactId:contact,messageId:id,recordId:id,acceptedRevision:'1',quote:'合成原话证据'};
const candidate={id,scopeKind:'contact',contactId:contact,verificationState:'verified',body:'原始合成结论',state:'pending',stateRevision:'0',eventId:id,sources:[source],contributingContactIds:[contact]};
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
  const undo=section.getByRole('button',{name:'撤销自动更新'});await undo.waitFor();assert.equal(await undo.isDisabled(),true);
  await section.getByRole('button',{name:'解除人工保护'}).click();await section.getByRole('status').filter({hasText:'已解除当前人工保护'}).waitFor();
  await undo.click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
  assert.equal(calls[1].action,'restore');assert.equal(calls[1].expectedVersionNo,'2');assert.equal(calls[1].expectedHeadRevision,'8');assert.equal(calls[1].restoredFromVersionNo,'1');assert.deepEqual(calls[1].expectedMergedParents,[]);
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
  await memory.getByText('查看版本与决定历史',{exact:true}).click();
  await memory.locator('.sqlite-memory-old').filter({hasText:'旧版已核验资料'}).getByText('来源已核验',{exact:true}).waitFor();
  await currentVersion.getByText('用户采纳',{exact:false}).waitFor();
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
  const section=page.getByRole('region',{name:'记忆候选与版本'});await section.getByText('查看版本与决定历史',{exact:true}).click();await section.getByText('系统自动决定 · 已并入合并资料 · 已生效',{exact:true}).waitFor();await section.getByText('系统自动决定 · 跳过重复资料 · 已生效',{exact:true}).waitFor();
  await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
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
  await secondary.getByRole('button',{name:'开启人工保护'}).click();await section.getByRole('status').filter({hasText:'已开启当前人工保护'}).waitFor();
  assert.equal(await secondary.getByRole('button',{name:'纠正错误'}).count(),0);assert.equal(await secondary.getByRole('button',{name:'记录变化'}).count(),0);assert.equal(await secondary.getByRole('button',{name:/撤销|恢复合并前资料/}).count(),0);
  await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).click();await section.getByRole('alert').filter({hasText:'人工保护'}).waitFor();
  await section.getByRole('button',{name:'刷新记忆管理'}).click();await secondary.getByRole('button',{name:'解除人工保护'}).click();await section.getByRole('status').filter({hasText:'已解除当前人工保护'}).waitFor();
  await section.getByRole('button',{name:'恢复合并前资料（共2项）'}).click();await section.getByRole('status').filter({hasText:'已新增恢复版本'}).waitFor();
  assert.deepEqual(calls.filter(c=>c.action!=='restore').map(c=>[c.action,c.expectedVersionNo,c.expectedHeadRevision]),[['protect','1','2'],['unprotect','1','3']]);assert.equal(calls.at(-1).expectedMergedParents[0].headRevision,'4');assert.equal(primary.current.versionNo,'3');assert.equal(memory.current.versionNo,'2');
 });
});
test('真实decode到页面的重复终态不显示已采纳或操作按钮，已撤销目标无当前版本',{timeout:20000},async t=>{
 const compiled=await build({entryPoints:['src/main/memory/sqlite-management.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {SqliteMemoryManagementController}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
 const second='33333333-3333-4333-8333-333333333333',pendingId='44444444-4444-4444-8444-444444444444',adoptedId='55555555-5555-4555-8555-555555555555';
 const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'合成目标正式资料',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
 const memory=(memoryId,state)=>({id:memoryId,scopeKind:'contact',contactId:contact,headRevision:'1',state,manualProtection:false,current:state==='active'?version:null,versions:[version],decisions:[]});
 const candidates=[{...candidate,state:'duplicate',body:'有效目标对应重复原稿'},{...candidate,id:second,state:'duplicate',body:'已撤销目标对应重复原稿'},{...candidate,id:pendingId,body:'尚待决定的独立原稿'},{...candidate,id:adoptedId,state:'adopted',body:'以前明确采纳的原稿'}];
 const controller=new SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async()=>({generation:1,data:{candidates,memories:[memory(id,'active'),memory(second,'withdrawn')]}})},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await panel(t,async(method,input)=>{assert.equal(method,'read');return controller.read(input);},async page=>{
  const section=page.getByRole('region',{name:'记忆候选与版本'});
  for(const body of ['有效目标对应重复原稿','已撤销目标对应重复原稿']){
   const duplicate=section.getByRole('article',{name:'记忆候选'}).filter({hasText:body});
   await duplicate.getByText('已跳过重复资料',{exact:false}).waitFor();assert.equal(await duplicate.getByText('已采纳',{exact:false}).count(),0);assert.equal(await duplicate.getByRole('button').count(),0);
  }
  const pending=section.getByRole('article',{name:'记忆候选'}).filter({hasText:'尚待决定的独立原稿'});await pending.getByRole('button',{name:'采纳原稿',exact:true}).waitFor();
  const adopted=section.getByRole('article',{name:'记忆候选'}).filter({hasText:'以前明确采纳的原稿'});await adopted.getByText('已采纳',{exact:false}).waitFor();assert.equal(await adopted.getByRole('button').count(),0);
  const withdrawn=section.getByRole('article',{name:'正式记忆'}).filter({hasText:'已撤销'});await withdrawn.getByText('当前无可引用版本。',{exact:true}).waitFor();assert.equal(await withdrawn.getByText('当前版本',{exact:false}).count(),0);
 });
});
