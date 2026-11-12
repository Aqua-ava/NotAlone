import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const contact='11111111-1111-4111-8111-111111111111',docId='22222222-2222-4222-8222-222222222222',pubId='33333333-3333-4333-8333-333333333333',memoryId='44444444-4444-4444-8444-444444444444';
const request={scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1};
let root,Controller,browserCode;
test.before(async()=>{
 root=await mkdtemp(path.join(tmpdir(),'notalone-profile-selection-view-'));const output=path.join(root,'controller.mjs');
 await build({entryPoints:['src/main/memory/sqlite-management.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 Controller=(await import(pathToFileURL(output))).SqliteMemoryManagementController;
 const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SqliteMemoryDocumentsPanel} from './src/renderer/SqliteMemoryDocumentsPanel';const bridge={readDocuments:input=>window.readSelection(input),onInvalidated:()=>()=>{}};const root=createRoot(document.getElementById('root'));let level='L3';window.setLevel=value=>{level=value;render();};function render(){root.render(<SqliteMemoryDocumentsPanel bridge={bridge} request={${JSON.stringify(request)}} level={level}/>);}render();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 browserCode=result.outputFiles[0].text;
});
test.after(async()=>{if(root)await rm(root,{recursive:true,force:true});});
function response(count=15,profileSelection){
 const statement=index=>({text:`合成长期概览第${index+1}条`,kind:'fact',basis:null,section:'life_context',uncertainty:null,temporalStatus:'stable',leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memory_id:memoryId,revision:1,level:'contact',provenance_kind:'source_supported',memoryText:'正式合成记忆依据。'}]});
 return {scope:request.scope,status:'completed',publication:{id:pubId,members:count?[{documentId:docId,versionNo:'1'}]:[]},documents:count?[{id:docId,versionNo:'1',...request.scope,kind:'profile',title:'合成长期概览',statements:Array.from({length:count},(_,i)=>statement(i))}]:[],...(profileSelection===undefined?{}:{profileSelection})};
}
function controller(handle){return new Controller({getConnectionGeneration:()=>1,requestJson:async r=>({generation:1,data:await handle(r)})},()=>{},{getState:()=>({selectedContactId:contact,scopeRevision:1})});}
async function panel(t,value,inspect){
 const instance=controller(async()=>value),browser=await chromium.launch({channel:'chrome',headless:true,timeout:10000});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(4000);await page.exposeFunction('readSelection',input=>instance.readDocuments(input));
 await page.route('http://127.0.0.1/profile-selection-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/profile-selection-test');await page.addScriptTag({content:browserCode});await inspect(page);
}
test('文档读取保留逐条核验计数，旧发布没有计数字段仍可查看',async()=>{
 let value=response();const instance=controller(async()=>value);
 assert.equal(Object.hasOwn((await instance.readDocuments(request)).view,'profileSelection'),false);
 value=response(15,{accepted:15,rejected:1,retained:0});const snapshot=await instance.readDocuments(request);
 assert.deepEqual(snapshot.view.profileSelection,{accepted:15,rejected:1,retained:0});assert.equal(snapshot.view.status,'completed');assert.equal(snapshot.view.documents[0].statements.length,15);
 value=response(1,{accepted:0,rejected:1,retained:1});assert.deepEqual((await instance.readDocuments(request)).view.profileSelection,{accepted:0,rejected:1,retained:1});
});
test('核验选择计数必须为非负整数且与新发布条目数量一致',async()=>{
 let value=response();const instance=controller(async()=>value);
 for(const selected of [{accepted:-1,rejected:1,retained:0},{accepted:'15',rejected:1,retained:0},{accepted:15,rejected:0.5,retained:0},{accepted:15,rejected:1,retained:NaN},{accepted:16,rejected:1,retained:0},{accepted:0,rejected:1,retained:999},null]){value=response(15,selected);await assert.rejects(instance.readDocuments(request));}
 value={...response(0,{accepted:0,rejected:16,retained:0}),publication:null};await assert.rejects(instance.readDocuments(request));
});
test('长期概览显示通过与未通过计数，正文可查看，主题页不混入概览提示',{timeout:20000},async t=>{
 await panel(t,response(15,{accepted:15,rejected:1,retained:0}),async page=>{
  const message='核验结果：15 条通过，1 条未通过。未通过的新提案未采纳。';await page.getByText(message,{exact:true}).waitFor();await page.getByText('合成长期概览第15条',{exact:true}).waitFor();
  assert.equal(await page.getByText('主题资料与长期概览已完成发布。',{exact:true}).count(),1);
  await page.evaluate(()=>window.setLevel('L2'));await page.waitForFunction(()=>!document.body.textContent.includes('核验结果：'));assert.equal(await page.getByText(message,{exact:true}).count(),0);
 });
});
test('新提案全部未通过时保留已有有效概览正文并说明核验结果',{timeout:20000},async t=>{
 await panel(t,response(1,{accepted:0,rejected:1,retained:1}),async page=>{
  await page.getByText('核验结果：0 条通过，1 条未通过。未通过的新提案未采纳。另保留 1 条已有有效内容。',{exact:true}).waitFor();await page.getByText('合成长期概览第1条',{exact:true}).waitFor();
 });
});
