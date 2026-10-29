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

/** 仅IPC业务边界为显式替身；实际React、浏览器事件及渲染均执行。 */
async function panel(t,execute){
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SqliteReplyCandidatesPanel}from'./src/renderer/SqliteReplyCandidatesPanel';
  const listeners=new Set();const bridge={candidates:{execute:request=>window.__execute(request).finally(()=>{window.__settled=(window.__settled||0)+1;})},onInvalidated:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const root=createRoot(document.getElementById('root'));let props={bridge,contactId:${JSON.stringify(ids.contact)},scopeRevision:1,sessionId:${JSON.stringify(ids.session)},onSubmitted:receipt=>window.__submitted(receipt)};
  const render=()=>root.render(React.createElement(SqliteReplyCandidatesPanel,props));window.__invalidate=()=>{for(const listener of listeners)listener({revision:2,contactId:props.contactId,scopeRevision:props.scopeRevision});};
  window.__switch=()=>{props={...props,contactId:${JSON.stringify(ids.other)},scopeRevision:2,sessionId:${JSON.stringify(ids.otherSession)}};render();};render();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
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
 const region=f.page.getByRole('region',{name:'候选回复'}),first=region.getByRole('textbox',{name:'候选第1条',exact:true}),second=region.getByRole('textbox',{name:'候选第2条',exact:true});
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

test('覆盖不完整须本次确认，失败核对沿同请求键且显式选稿才携入',{timeout:30000},async t=>{
 let generated=0;const f=await panel(t,async operation=>{
  if(operation.action==='read')return {...pageData(original(),'incomplete'),availableSkills:[{packageId:ids.skill,name:'合成明确选择的方法',revisionNo:1}]};
  if(operation.action==='select')return {id:ids.selection,candidateId:operation.candidateId,versionNo:operation.versionNo,selectionNo:1};
  if(operation.action==='generate'){if(++generated===1)throw new Error('候选结果尚未确认，请保留原请求重试核对。');return receipt(operation,true);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'候选回复'}),draft=region.getByRole('textbox',{name:'本次想法',exact:true}),generate=region.getByRole('button',{name:'生成候选',exact:true});
 await expect(region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true})).toBeVisible();await draft.fill('合成本次表达要求');await expect(generate).toBeDisabled();assert.equal(generated,0);
 await region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true}).check();await expect(generate).toBeEnabled();await region.getByRole('combobox',{name:'本次回复Skill',exact:true}).selectOption(ids.skill);
 await region.getByRole('button',{name:'以此版本继续',exact:true}).click();await expect(region.getByRole('status')).toContainText('下一次明确请求');assert.equal(generated,0);
 await generate.click();await expect(region.getByRole('alert').filter({hasText:'候选结果尚未确认'})).toBeVisible();await expect(draft).toHaveValue('合成本次表达要求');
 await region.getByRole('button',{name:'重试核对候选',exact:true}).click();await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests.length,2);assert.equal(requests[0].acceptIncomplete,true);assert.equal(requests[0].selectedPackageId,ids.skill);assert.equal(requests[1].selectedPackageId,ids.skill);assert.equal(requests[0].carriedSelectionId,ids.selection);assert.equal(requests[1].requestKey,requests[0].requestKey);assert.equal(requests[1].text,requests[0].text);assert.equal(requests[1].carriedSelectionId,ids.selection);
 await expect(draft).toHaveValue('');await expect(region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true})).not.toBeChecked();
});

test('来源失效立即移除草稿、候选、依据及Skill，迟到读取和生成均不能恢复旧快照',{timeout:30000},async t=>{
 let mode='ready';const readEntered=Promise.withResolvers(),lateRead=Promise.withResolvers(),generateEntered=Promise.withResolvers(),lateGenerate=Promise.withResolvers();
 const f=await panel(t,async operation=>{
  if(operation.action==='read'){if(mode==='late-read'){readEntered.resolve();return lateRead.promise;}return pageData();}
  if(operation.action==='generate'){generateEntered.resolve(operation);return lateGenerate.promise;}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'候选回复'}),draft=region.getByRole('textbox',{name:'本次想法',exact:true});
 const assertCleared=async()=>{
  await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
  await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 };
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');await draft.fill('来源失效前的草稿');
 mode='late-read';await region.getByRole('button',{name:'重新读取候选',exact:true}).click();await readEntered.promise;
 await f.page.evaluate(()=>window.__invalidate());await assertCleared();lateRead.resolve(pageData());await f.page.waitForFunction(()=>window.__settled===2);await assertCleared();
 mode='ready';await region.getByRole('button',{name:'重新读取候选',exact:true}).click();await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');
 await draft.fill('生成期间失效的草稿');await region.getByRole('button',{name:'生成候选',exact:true}).click();const pending=await generateEntered.promise;
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
 const region=f.page.getByRole('region',{name:'候选回复'}),draft=region.getByRole('textbox',{name:'本次想法',exact:true});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');await draft.fill('甲联系人草稿');
 deferOld=true;await region.getByRole('button',{name:'重新读取候选',exact:true}).click();await entered.promise;await f.page.evaluate(()=>window.__switch());
 await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 release.resolve(pageData());await f.page.waitForFunction(()=>window.__settled===3);
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 await draft.fill('乙联系人的本次想法');await region.getByRole('button',{name:'生成候选',exact:true}).click();await expect.poll(()=>f.submitted.length).toBe(1);
 const generated=f.commands.find(c=>c.action==='generate');assert.equal(generated.contactId,ids.other);assert.equal(generated.scopeRevision,2);assert.equal(generated.sessionId,ids.otherSession);assert.equal(generated.text,'乙联系人的本次想法');assert.equal(generated.acceptIncomplete,false);assert.equal(generated.carriedSelectionId,undefined);
});

test('候选继续被后端判定失效时同时清草稿、旧携入及Skill选择快照',{timeout:30000},async t=>{
 let selected=0;const f=await panel(t,async operation=>{
  if(operation.action==='read')return {...pageData(),availableSkills:[{packageId:ids.skill,name:'将失效的合成方法',revisionNo:1}]};
  if(operation.action==='select'){if(++selected===1)return {id:ids.selection};throw new Error('本次候选来源已失效，请重新读取。');}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'候选回复'}),draft=region.getByRole('textbox',{name:'本次想法',exact:true});
 await expect(region.getByRole('button',{name:'以此版本继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以此版本继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await draft.fill('资格失效时必须清掉的合成草稿');await region.getByRole('combobox',{name:'本次回复Skill',exact:true}).selectOption(ids.skill);await region.getByRole('button',{name:'以此版本继续',exact:true}).click();
 await expect(region.getByRole('alert')).toContainText('已失效');await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);await expect(region.getByRole('combobox',{name:'本次回复Skill',exact:true})).toHaveCount(0);await expect(region.getByText('本次实际载入的 Skill',{exact:true})).toHaveCount(0);
});
