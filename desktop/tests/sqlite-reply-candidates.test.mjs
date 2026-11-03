import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

const ids={contact:'11111111-1111-4111-8111-111111111111',other:'22222222-2222-4222-8222-222222222222',session:'33333333-3333-4333-8333-333333333333',otherSession:'44444444-4444-4444-8444-444444444444',candidate:'55555555-5555-4555-8555-555555555555',request:'66666666-6666-4666-8666-666666666666',selection:'77777777-7777-4777-8777-777777777777',skill:'88888888-8888-4888-8888-888888888888'};
const original=()=>({candidateId:ids.candidate,versionNo:1,origin:'model',parentVersionNo:null,parts:['合成候选第一条','合成候选第二条'],basis:[{itemNo:1,kind:'message',text:'同联系人实际输入依据',verification:'actual_input'}]});
const pageData=(version=original(),phase='complete')=>({requests:[{requestId:ids.request,coverageWarning:null,sourceState:'available',candidates:[version],selections:[],loadedSkills:[{packageId:ids.skill,revisionNo:1,relativePath:'SKILL.md',text:'本次实际加载的合成Skill正文'}]}],coverage:{phase}});
const receipt=(request,replayed=false)=>({session_id:request.sessionId,request_key:request.requestKey,segmented:false,replayed});

test('SQLite恢复原表达工作区，两种动作及背景和语气设置真实传给生成',{timeout:30000},async t=>{
 const f=await panel(t,async operation=>operation.action==='generate'?receipt(operation):pageData());
 const region=f.page.getByRole('region',{name:'表达工作区'});
 const draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('heading',{name:'有什么想说的？',exact:true})).toBeVisible();
 const express=region.getByRole('button',{name:'帮我表达',exact:true}),suggest=region.getByRole('button',{name:'帮我想想',exact:true});
 await expect(express).toBeDisabled();await expect(suggest).toBeEnabled();await suggest.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(1);
 assert.equal(f.commands.find(c=>c.action==='generate').workspace.action,'suggest');
 assert.equal(f.commands.find(c=>c.action==='generate').workspace.draftText,'');
 await region.getByText('最近聊天 · 查看／补充',{exact:true}).click();
 await region.getByRole('checkbox',{name:'参考最近聊天和相关关系资料',exact:true}).uncheck();
 await region.getByRole('textbox',{name:'补充聊天上下文',exact:true}).fill('对方：今天有些忙');
 await region.getByText('语气和本次要求',{exact:true}).click();
 await region.getByRole('combobox',{name:'本次语气',exact:true}).selectOption('concise');
 await region.getByRole('textbox',{name:'本次要求',exact:true}).fill('简短一些');
 await draft.fill('想问问下班了吗');await express.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(2);
 assert.deepEqual(f.commands.filter(c=>c.action==='generate')[1].workspace,{action:'express',draftText:'想问问下班了吗',tone:'concise',instruction:'简短一些',contextText:'对方：今天有些忙',includeRelationshipContext:false,excludedMessageIds:[]});
 await expect(draft).toHaveValue('');
});

test('近期消息可排除且刷新背景保留未保存的候选编辑',{timeout:30000},async t=>{
 const message='99999999-9999-4999-8999-999999999999';
 const f=await panel(t,async operation=>operation.action==='generate'?receipt(operation):{...pageData(),recentMessages:[{messageId:message,sender:'contact',text:'本次可用的合成聊天',occurredAt:null,timePrecision:null,displayPosition:'1',ordering:'unknown'}]});
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('textbox',{name:'候选第1条',exact:true}).fill('尚未保存的候选编辑');
 await region.getByText('最近聊天 · 查看／补充',{exact:true}).click();
 await region.getByRole('checkbox',{name:'使用消息：本次可用的合成聊天',exact:true}).uncheck();
 await expect(region.getByRole('button',{name:'以此版本继续',exact:true})).toBeDisabled();
 await region.getByRole('button',{name:'刷新最近聊天',exact:true}).click();
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('尚未保存的候选编辑');
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(1);
 assert.deepEqual(f.commands.find(c=>c.action==='generate').workspace.excludedMessageIds,[message]);
});

test('关闭关系背景后撤销旧候选携入，生成不提交被后端禁止的组合',{timeout:30000},async t=>{
 const f=await panel(t,async operation=>operation.action==='generate'?receipt(operation):operation.action==='select'?{id:ids.selection}:pageData());
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('button',{name:'以此版本继续',exact:true}).click();
 await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await region.getByText('最近聊天 · 查看／补充',{exact:true}).click();
 await region.getByRole('checkbox',{name:'参考最近聊天和相关关系资料',exact:true}).uncheck();
 await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
 await expect(region.getByRole('button',{name:'以此版本继续',exact:true})).toBeDisabled();
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(1);
 assert.equal(f.commands.find(c=>c.action==='generate').carriedSelectionId,undefined);
 assert.equal(f.commands.find(c=>c.action==='generate').workspace.includeRelationshipContext,false);
});

test('暂时失去生成资格保留想法，结果未知只核对原请求且保留后来编辑',{timeout:30000},async t=>{
 let checks=0;
 const f=await panel(t,async operation=>{if(operation.action==='read')return pageData();if(operation.action==='status')return {requestKey:operation.requestKey,phase:++checks===1?'unknown':'committed',sent:true,errorCode:null,retryable:false,startedAt:1000,finishedAt:2000};throw new Error('候选结果尚未确认，请保留原请求重试核对。');});
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await draft.fill('原请求的想法');
 await f.page.evaluate(()=>window.__setDisabled(true));await expect(draft).toBeDisabled();
 await f.page.evaluate(()=>window.__setDisabled(false));await expect(draft).toBeEnabled();await expect(draft).toHaveValue('原请求的想法');
 await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toContainText('结果暂未确认');
 await expect(region.getByRole('button',{name:'帮我想想',exact:true})).toBeDisabled();
 await draft.fill('后来改写的新想法');await region.getByRole('button',{name:'核对原请求',exact:true}).click();
 await expect(region.getByText('已找到原请求保存的候选。',{exact:true})).toBeVisible();
 const generated=f.commands.filter(c=>c.action==='generate'),checked=f.commands.filter(c=>c.action==='status');assert.equal(generated.length,1);assert.equal(checked.length,2);assert.ok(checked.every(c=>c.requestKey===generated[0].requestKey));
 await expect(draft).toHaveValue('后来改写的新想法');
});

test('Skill自动选择无需手选，仅展示实际名称或不可用提示',{timeout:30000},async t=>{
 let data={...pageData(),availableSkills:[{packageId:ids.skill,name:'合成安慰策略',revisionNo:1}]};
 data.requests[0].loadedSkills[0].name='合成安慰策略';data.requests[0].loadedSkills.push({packageId:ids.skill,name:'合成安慰策略',revisionNo:1,relativePath:'references/large.md',text:'large'.repeat(25000)});
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toBeVisible();
 await expect(region.getByRole('combobox')).toHaveCount(0);
 await expect(region.getByText('本次策略：合成安慰策略',{exact:true})).toBeVisible();
 data={...data,requests:[{...data.requests[0],loadedSkills:[],skillWarning:'回复策略暂不可用'}]};
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();
 await expect(region.getByText('回复策略暂不可用',{exact:true})).toBeVisible();
 await expect(region.getByText('本次策略：合成安慰策略',{exact:true})).toHaveCount(0);
 await region.getByRole('textbox',{name:'候选第1条',exact:true}).fill('失效策略后的候选仍可编辑');
 await expect(region.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
});

/** 仅IPC业务边界为显式替身；实际React、浏览器事件及渲染均执行。 */
async function panel(t,execute,initialDraft=''){
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SqliteReplyCandidatesPanel}from'./src/renderer/SqliteReplyCandidatesPanel';
  const listeners=new Set();const bridge={candidates:{execute:request=>window.__execute(request).finally(()=>{window.__settled=(window.__settled||0)+1;})},onInvalidated:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const root=createRoot(document.getElementById('root'));let props={bridge,contactId:${JSON.stringify(ids.contact)},scopeRevision:1,sessionId:${JSON.stringify(ids.session)},initialDraft:${JSON.stringify(initialDraft)},onSubmitted:receipt=>window.__submitted(receipt)};
  const render=()=>root.render(React.createElement(SqliteReplyCandidatesPanel,props));window.__invalidate=()=>{for(const listener of listeners)listener({revision:2,contactId:props.contactId,scopeRevision:props.scopeRevision});};
  window.__setDisabled=disabled=>{props={...props,disabled};render();};window.__switch=()=>{props={...props,contactId:${JSON.stringify(ids.other)},scopeRevision:2,sessionId:${JSON.stringify(ids.otherSession)}};render();};render();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<div id="root"></div>');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(5000);const commands=[],submitted=[];
 await page.exposeFunction('__execute',async request=>{commands.push(request);return execute(request,commands);});await page.exposeFunction('__submitted',value=>submitted.push(value));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:compiled.outputFiles[0].text});
 return {page,commands,submitted};
}

test('候选页面读取真实版本结构、保存多条编辑稿并选择具体版本',{timeout:30000},async t=>{
 let version=original();const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData(version);
  if(operation.action==='edit'){version={...version,versionNo:2,parentVersionNo:1,origin:'manual',parts:operation.parts,basis:version.basis.map(b=>({...b,verification:'inherited_unverified'}))};return version;}
  if(operation.action==='version')return original();
  if(operation.action==='select')return {id:ids.selection,candidateId:operation.candidateId,versionNo:operation.versionNo,selectionNo:1};
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),first=region.getByRole('textbox',{name:'候选第1条',exact:true}),second=region.getByRole('textbox',{name:'候选第2条',exact:true});
 await expect(first).toHaveValue('合成候选第一条');await expect(second).toHaveValue('合成候选第二条');
 await region.getByText('依据',{exact:true}).click();await expect(region.getByText('同联系人实际输入依据',{exact:true})).toBeVisible();await region.getByText('本次实际载入的 Skill',{exact:true}).click();await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toBeVisible();
 await first.fill('手工修改后的第一条');await second.fill('手工修改后的第二条');await region.getByRole('button',{name:'保存修改',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='edit').length).toBe(1);
 const edit=f.commands.find(c=>c.action==='edit');assert.equal(edit.candidateId,ids.candidate);assert.equal(edit.versionNo,1);assert.deepEqual(edit.parts,['手工修改后的第一条','手工修改后的第二条']);
 await expect(region.getByRole('status')).toContainText('未重新核验');
 await region.getByRole('button',{name:'选用此版本',exact:true}).click();await expect.poll(()=>f.commands.filter(c=>c.action==='select').length).toBe(1);
 assert.equal(f.commands.find(c=>c.action==='select').versionNo,2);
 await region.getByRole('button',{name:'查看上一版',exact:true}).click();await expect(first).toHaveValue('合成候选第一条');await expect(second).toHaveValue('合成候选第二条');
 await region.getByRole('button',{name:'回到最新版本',exact:true}).click();await expect(first).toHaveValue('手工修改后的第一条');await expect(second).toHaveValue('手工修改后的第二条');
});

test('覆盖不完整可直接使用，明确未发送失败的新请求保留显式选稿',{timeout:30000},async t=>{
 let generated=0;const f=await panel(t,async operation=>{
  if(operation.action==='read')return {...pageData(original(),'incomplete'),availableSkills:[{packageId:ids.skill,name:'合成明确选择的方法',revisionNo:1}]};
  if(operation.action==='select')return {id:ids.selection,candidateId:operation.candidateId,versionNo:operation.versionNo,selectionNo:1};
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'discussion_generation_failed',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('候选结果尚未确认，请保留原请求重试核对。');return receipt(operation,true);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true}),generate=region.getByRole('button',{name:'帮我表达',exact:true});
 await expect(region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true})).toHaveCount(0);await draft.fill('合成本次表达要求');await expect(generate).toBeEnabled();assert.equal(generated,0);
 await region.getByRole('button',{name:'以此版本继续',exact:true}).click();await expect(region.getByRole('status')).toContainText('下一次明确请求');assert.equal(generated,0);
 await generate.click();await expect(region.getByRole('alert')).toContainText('尚未发给模型');await expect(draft).toHaveValue('合成本次表达要求');
 await region.getByRole('button',{name:'重新生成',exact:true}).click();await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests.length,2);assert.equal(requests[0].acceptIncomplete,false);assert.equal(requests[0].selectedPackageId,undefined);assert.equal(requests[1].selectedPackageId,undefined);assert.equal(requests[0].carriedSelectionId,ids.selection);assert.notEqual(requests[1].requestKey,requests[0].requestKey);assert.equal(requests[1].text,requests[0].text);assert.equal(requests[1].carriedSelectionId,ids.selection);
 await expect(draft).toHaveValue('');await expect(region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true})).toHaveCount(0);
});

test('聊天读取恢复失败保留独立想法，撤下旧候选后可明确重试生成',{timeout:30000},async t=>{
 let generated=0;
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'reply_sources_not_ready',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('聊天读取暂未恢复，请重试生成。');return receipt(operation);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toBeVisible();
 await draft.fill('我自己写下的独立想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText('聊天读取暂未恢复，请重试生成。');
 await expect(draft).toHaveValue('我自己写下的独立想法');
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);
 await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 const retry=region.getByRole('button',{name:'重试生成',exact:true});await expect(retry).toBeEnabled();
 assert.equal(generated,1,'准备失败后不能自动另发生成请求');
 await retry.click();await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests.length,2);assert.notEqual(requests[0].requestKey,requests[1].requestKey);assert.equal(requests[1].text,'我自己写下的独立想法');assert.equal(requests[1].carriedSelectionId,undefined);
});

test('聊天读取恢复失败不保留旧选稿及其派生草稿，新生成不再携入旧稿',{timeout:30000},async t=>{
 let generated=0;
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='select')return {id:ids.selection};
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'reply_sources_not_ready',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('聊天读取暂未恢复，请重试生成。');return receipt(operation);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await region.getByRole('button',{name:'以此版本继续',exact:true}).click();
 await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await draft.fill('从旧选稿继续修改的想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText('聊天读取暂未恢复，请重试生成。');
 await expect(draft).toHaveValue('');await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
 await expect(region.getByRole('button',{name:'重试生成',exact:true})).toHaveCount(0);
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 await draft.fill('重新写下的独立想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests[0].carriedSelectionId,ids.selection);assert.equal(requests[1].carriedSelectionId,undefined);assert.equal(requests[1].text,'重新写下的独立想法');
});

test('聊天恢复提示后仍按原请求核对，模型结果未知时不能换请求重发',{timeout:30000},async t=>{
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'unknown',sent:true,errorCode:null,retryable:false,startedAt:1000,finishedAt:null};
  if(operation.action==='generate')throw new Error('聊天读取暂未恢复，请重试生成。');
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('textbox',{name:'有什么想说的',exact:true}).fill('还不能另发的想法');
 await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toContainText('结果暂未确认');
 await expect(region.getByRole('button',{name:'重试生成',exact:true})).toHaveCount(0);
 await expect(region.getByRole('button',{name:'帮我想想',exact:true})).toBeDisabled();
 await region.getByRole('button',{name:'核对原请求',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='status').length).toBe(2);
 const request=f.commands.find(c=>c.action==='generate');assert.equal(f.commands.filter(c=>c.action==='generate').length,1);assert.ok(f.commands.filter(c=>c.action==='status').every(c=>c.requestKey===request.requestKey));
});

test('已确认联系人在历史未开始或后台读取中均能直接生成',{timeout:30000},async t=>{
 let phase='not_started';
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData(original(),phase);
  if(operation.action==='generate')return receipt(operation);
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 for(const next of ['not_started','running','incomplete']){
  phase=next;await region.getByRole('button',{name:'刷新候选',exact:true}).click();
  await region.getByRole('textbox',{name:'有什么想说的',exact:true}).fill('合成本次表达');
  const generate=region.getByRole('button',{name:'帮我表达',exact:true});
  await expect(generate).toBeEnabled();await generate.click();
  await expect(region.getByRole('textbox',{name:'有什么想说的',exact:true})).toHaveValue('');
 }
 assert.equal(f.commands.filter(c=>c.action==='generate').length,3);
 assert.ok(f.commands.filter(c=>c.action==='generate').every(c=>c.acceptIncomplete===false));
 await expect(region.getByText(/完成后才能生成|使用已同步部分继续/)).toHaveCount(0);
});

test('来源失效立即移除草稿、候选、依据及Skill，迟到读取和生成均不能恢复旧快照',{timeout:30000},async t=>{
 let mode='ready';const readEntered=Promise.withResolvers(),lateRead=Promise.withResolvers(),generateEntered=Promise.withResolvers(),lateGenerate=Promise.withResolvers();
 const f=await panel(t,async operation=>{
  if(operation.action==='read'){if(mode==='late-read'){readEntered.resolve();return lateRead.promise;}return pageData();}
  if(operation.action==='generate'){generateEntered.resolve(operation);return lateGenerate.promise;}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 const assertCleared=async()=>{
  await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
  await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 };
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');await draft.fill('来源失效前的草稿');
 mode='late-read';await region.getByRole('button',{name:'刷新候选',exact:true}).click();await readEntered.promise;
 await f.page.evaluate(()=>window.__invalidate());await assertCleared();lateRead.resolve(pageData());await f.page.waitForFunction(()=>window.__settled===2);await assertCleared();
 mode='ready';await region.getByRole('button',{name:'刷新候选',exact:true}).click();await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');
 await draft.fill('生成期间失效的草稿');await region.getByRole('button',{name:'帮我表达',exact:true}).click();const pending=await generateEntered.promise;
 await f.page.evaluate(()=>window.__invalidate());await assertCleared();lateGenerate.resolve(receipt(pending));await f.page.waitForFunction(()=>window.__settled===4);await assertCleared();assert.equal(f.submitted.length,0);
 await expect(region.getByText('候选已保存，最终消息请自行发送。',{exact:true})).toHaveCount(0);
});

test('切换联系人撤下旧草稿与快照，旧读取迟到不能跨范围恢复',{timeout:30000},async t=>{
 let deferOld=false;const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const f=await panel(t,async operation=>{
  if(operation.action==='read'){
   if(operation.contactId===ids.other)return {requests:[],coverage:{phase:'complete'}};
   if(deferOld){entered.resolve();return release.promise;}return pageData();
  }
  if(operation.action==='generate')return receipt(operation);
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');await draft.fill('甲联系人草稿');
 deferOld=true;await region.getByRole('button',{name:'刷新候选',exact:true}).click();await entered.promise;await f.page.evaluate(()=>window.__switch());
 await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 release.resolve(pageData());await f.page.waitForFunction(()=>window.__settled===3);
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 await draft.fill('乙联系人的本次想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();await expect.poll(()=>f.submitted.length).toBe(1);
 const generated=f.commands.find(c=>c.action==='generate');assert.equal(generated.contactId,ids.other);assert.equal(generated.scopeRevision,2);assert.equal(generated.sessionId,ids.otherSession);assert.equal(generated.text,'乙联系人的本次想法');assert.equal(generated.acceptIncomplete,false);assert.equal(generated.carriedSelectionId,undefined);
});

test('候选继续被后端判定失效时同时清草稿、旧携入及实际Skill快照',{timeout:30000},async t=>{
 let selected=0;const f=await panel(t,async operation=>{
  if(operation.action==='read')return {...pageData(),availableSkills:[{packageId:ids.skill,name:'将失效的合成方法',revisionNo:1}]};
  if(operation.action==='select'){if(++selected===1)return {id:ids.selection};throw new Error('本次候选来源已失效，请重新读取。');}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('button',{name:'以此版本继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以此版本继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await draft.fill('资格失效时必须清掉的合成草稿');await region.getByRole('button',{name:'以此版本继续',exact:true}).click();
 await expect(region.getByRole('alert')).toContainText('已失效');await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);await expect(region.getByRole('combobox',{name:'本次回复Skill',exact:true})).toHaveCount(0);await expect(region.getByText('本次实际载入的 Skill',{exact:true})).toHaveCount(0);
});

test('权威读取发现已展示候选资格失效时清草稿与旧携入，不只移除候选列表',{timeout:30000},async t=>{
 let invalid=false;const f=await panel(t,async op=>{
  if(op.action==='select')return {id:ids.selection};
  if(op.action==='read')return invalid?{...pageData(),requests:[{...pageData().requests[0],sourceState:'unavailable',candidates:[],loadedSkills:[],selections:[]}]}:pageData();
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('button',{name:'以此版本继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以此版本继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();await draft.fill('后端已判失效时不应残留的草稿');invalid=true;
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();await expect(draft).toHaveValue('');await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
});

test('短暂读取失败后权威读取确认来源失效，仍撤下旧选稿草稿与携入',{timeout:30000},async t=>{
 let reads=0;const f=await panel(t,async op=>{
  if(op.action==='select')return {id:ids.selection};
  if(op.action==='read'){
   if(++reads===1)return pageData();
   if(reads===2)throw new Error('候选结果尚未确认，请重新读取。');
   return {...pageData(),requests:[{...pageData().requests[0],sourceState:'unavailable',candidates:[],loadedSkills:[],selections:[]}]};
  }
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true}),read=region.getByRole('button',{name:'刷新候选',exact:true});
 await expect(region.getByRole('button',{name:'以此版本继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以此版本继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();await draft.fill('短暂读失败后仍挂旧选稿的合成草稿');
 await read.click();await expect(region.getByRole('alert')).toContainText('尚未确认');await expect(draft).toHaveValue('短暂读失败后仍挂旧选稿的合成草稿');
 await read.click();await expect(region.getByText('这次候选的来源已失效，正文与依据已撤下。',{exact:true})).toBeVisible();await expect(draft).toHaveValue('');await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
});


test('首次会话带入已有想法并通过 SQLite 候选接口提交', {timeout:30000}, async t => {
 const f=await panel(t,async operation=>operation.action==='read'?pageData():receipt(operation),'合成的首次表达想法');
 const region=f.page.getByRole('region',{name:'表达工作区'}), draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(draft).toHaveValue('合成的首次表达想法');
 await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect.poll(()=>f.submitted.length).toBe(1);
 const request=f.commands.find(command=>command.action==='generate');
 assert.equal(request.text,'合成的首次表达想法');assert.equal(request.contactId,ids.contact);assert.equal(request.sessionId,ids.session);
});


test('本轮进度独立于历史失败，轻量状态显示真实阶段且未发送失败可新请求重试',{timeout:30000},async t=>{
 let phase='preparing',calls=0;const gate=Promise.withResolvers();
 const f=await panel(t,async op=>{
  if(op.action==='read')return {requests:[{requestId:ids.request,generationState:'failed',coverageWarning:null,sourceState:'unavailable',candidates:[],selections:[],loadedSkills:[]}],coverage:{phase:'complete'}};
  if(op.action==='status')return {requestKey:op.requestKey,phase,sent:phase==='generating',errorCode:phase==='failed'?'discussion_preparation_timeout':null,retryable:phase==='failed',startedAt:1000,finishedAt:phase==='failed'?2000:null};
  if(op.action==='generate'){if(++calls===1)return gate.promise;return receipt(op);}
  throw new Error('未授权操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(region.getByText('本次候选生成失败，没有可选正文。',{exact:true})).toBeVisible();
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect(region.getByText('正在整理本次资料…',{exact:true})).toBeVisible();
 await expect(region.getByText('本次候选生成失败，没有可选正文。',{exact:true})).toHaveCount(0);
 phase='generating';await expect(region.getByText('正在等待模型回复…',{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(c=>c.action==='read').length,1,'进度核对不拉整页聊天与历史');
 phase='failed';gate.reject(new Error('合成运输失败'));
 await expect(region.getByRole('alert')).toContainText('尚未发给模型');
 await region.getByRole('button',{name:'重新生成',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(2);
 const requests=f.commands.filter(c=>c.action==='generate');assert.notEqual(requests[0].requestKey,requests[1].requestKey);
});
