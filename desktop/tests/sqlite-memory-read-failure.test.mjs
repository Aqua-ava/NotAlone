import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const contact='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const scope={scopeKind:'contact',contactId:contact},read={scope,displayContactId:contact,scopeRevision:1};
const source={contactId:contact,messageId:id,recordId:id,acceptedRevision:'1',quote:'合成已核验依据'};
const current={mergeParents:[],mergeParentCount:0,verificationState:'verified',timeStatus:'eligible',versionNo:'1',body:'合成已核验记忆正文',formationKind:'correction',adoptionMode:'user',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:id,sources:[source],contributingContactIds:[contact]};
const memory={id,scopeKind:'contact',contactId:contact,headRevision:'1',state:'active',manualProtection:false,current,versions:[current],decisions:[]};
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'notalone-memory-read-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'ports.mjs');
 await build({stdin:{contents:"export {BackendRequestFailure,JsonClient} from './src/main/backend/json-client';export {installSqliteMemoryManagementBridge} from './src/main/memory/sqlite-management';export {createSqliteMemoryManagementBridge} from './src/preload/sqlite-memory-management';",resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const ports=await import(pathToFileURL(output)),handlers=new Map(),invalidations=[],state={selectedContactId:contact,scopeRevision:1};let failure=null,generation=1;
 const controller=ports.installSqliteMemoryManagementBridge({handle:(channel,handler)=>handlers.set(channel,handler),publish:channel=>invalidations.push(channel)}, {onStateChanged:()=>()=>{},getConnectionGeneration:()=>generation,requestJson:async request=>{
  if(failure)throw typeof failure==='function'?await failure(request):failure;
  if(request.path.startsWith('/api/memory-management/history'))return {generation,data:{memoryId:id,headRevision:'1',versions:[current],decisions:[],revision:'a'.repeat(64),nextCursor:null}};
  if(request.path.startsWith('/api/memory-documents'))return {generation,data:{scope,status:'idle',publication:null,documents:[]}};
  return {generation,data:{memories:[memory],candidates:[]}};
 }},{getState:()=>state});
 const invoke=async(channel,...args)=>JSON.parse(JSON.stringify(await handlers.get(channel)(...args)));
 const bridge=ports.createSqliteMemoryManagementBridge({invoke,on:()=>{},removeListener:()=>{}});
 return {ports,bridge,controller,invoke,invalidations,state,setFailure:value=>{failure=value;},changeConnection:()=>{generation++;}};
}

test('运输超时具有独立错误码，普通连接中断仍保持连接类别',async t=>{
 const {ports}=await fixture(t),server=createServer(()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new ports.JsonClient({port:server.address().port,token:'synthetic-token'});
 await assert.rejects(client.perform({method:'GET',path:'/api/memory-management',timeoutMs:20}),error=>error.kind==='connection'&&error.code==='request_timeout');
});

for(const code of ['request_timeout',undefined])test(`记忆、历史与主题读取${code?'超时':'连接失败'}不广播资料失效，安全错误码跨桥保留`,async t=>{
 const f=await fixture(t);await f.bridge.read(read);f.setFailure(new f.ports.BackendRequestFailure('connection',undefined,code));
 for(const call of [()=>f.bridge.read(read),()=>f.bridge.readHistory({...read,memoryId:id,expectedHeadRevision:'1'}),()=>f.bridge.readDocuments(read)]){
  assert.deepEqual(JSON.parse(JSON.stringify(await call())),{readFailure:code?'memory_read_timeout':'memory_read_unavailable'});
 }
 assert.deepEqual(f.invalidations,[]);
 f.setFailure(new f.ports.BackendRequestFailure('response',409,'memory_source_stale'));await assert.rejects(f.bridge.read(read));
 assert.deepEqual(f.invalidations,['memory:management-invalidated']);
});

for(const change of ['scope','connection','invalidation'])test(`在途超时同时发生${change}变化仍撤下资料，不回填旧范围`,{timeout:5000},async t=>{
 const f=await fixture(t);let enter,finish;const entered=new Promise(resolve=>{enter=resolve;}),pending=new Promise(resolve=>{finish=resolve;});
 f.setFailure(async()=>{enter();return pending;});const reading=f.bridge.read(read);await entered;
 if(change==='scope')f.state.scopeRevision++;else if(change==='connection')f.changeConnection();else f.controller.synchronize();
 finish(new f.ports.BackendRequestFailure('connection',undefined,'request_timeout'));
 await assert.rejects(reading);assert.deepEqual(f.invalidations,['memory:management-invalidated']);
});

test('真实控制器与页面：超时保留已核验正文、依据和编辑，显示可重试提示，首次超时也可恢复',{timeout:20000},async t=>{
 const f=await fixture(t),compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {createSqliteMemoryManagementBridge} from './src/preload/sqlite-memory-management';import {SqliteMemoryManagementPanel} from './src/renderer/SqliteMemoryManagementPanel';const preload=createSqliteMemoryManagementBridge({invoke:(channel,...args)=>window.command(channel,...args),on:()=>{},removeListener:()=>{}});const bridge={...preload,read:async(...args)=>JSON.parse(JSON.stringify(await preload.read(...args))),readHistory:async(...args)=>JSON.parse(JSON.stringify(await preload.readHistory(...args))),readDocuments:async(...args)=>JSON.parse(JSON.stringify(await preload.readDocuments(...args)))};createRoot(document.getElementById('root')).render(<SqliteMemoryManagementPanel bridge={bridge} contactId='${contact}' scopeRevision={1}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(3000);
 await page.exposeFunction('command',f.invoke);await page.route('http://127.0.0.1/memory-read-failure',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 const open=async()=>{await page.goto('http://127.0.0.1/memory-read-failure');await page.addScriptTag({content:compiled.outputFiles[0].text});};
 await open();await page.getByText(current.body,{exact:true}).waitFor();await page.getByRole('button',{name:'修改',exact:true}).click();await page.getByLabel('修正后的正文').fill('合成未提交编辑');
 await page.getByText('查看来源',{exact:true}).click();await page.getByText(source.quote,{exact:true}).waitFor();
 f.setFailure(new f.ports.BackendRequestFailure('connection',undefined,'request_timeout'));await page.getByRole('button',{name:'重新读取第一页'}).click();
 await page.getByRole('alert').filter({hasText:'读取超时，请重试'}).waitFor();assert.equal(await page.getByText(current.body,{exact:true}).count(),1);assert.equal(await page.getByText(source.quote,{exact:true}).isVisible(),true);assert.equal(await page.getByLabel('修正后的正文').inputValue(),'合成未提交编辑');assert.deepEqual(f.invalidations,[]);
 f.setFailure(null);await page.getByRole('button',{name:'重试读取记忆资料'}).click();await page.waitForFunction(()=>!document.querySelector('[role="alert"]'));assert.equal(await page.getByText(current.body,{exact:true}).count(),1);
 f.setFailure(new f.ports.BackendRequestFailure('connection',undefined,'request_timeout'));await open();await page.getByRole('alert').filter({hasText:'读取超时，请重试'}).waitFor();await page.getByRole('button',{name:'重试读取记忆资料'}).waitFor();
 f.setFailure(null);await page.getByRole('button',{name:'重试读取记忆资料'}).click();await page.getByText(current.body,{exact:true}).waitFor();assert.deepEqual(f.invalidations,[]);
});
