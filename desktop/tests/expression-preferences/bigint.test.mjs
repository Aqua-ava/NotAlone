import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
async function modules(t){const root=await mkdtemp(path.join(tmpdir(),'notalone-preference-bigint-'));t.after(()=>rm(root,{recursive:true,force:true}));const outfile=path.join(root,'entry.mjs');await build({stdin:{contents:[
 'src/shared/expression-preference-json.ts','src/main/expression-preferences/bridge.ts','src/preload/expression-preferences.ts','src/main/expression-preferences/client.ts','src/main/backend/json-client.ts'].map(p=>`export * from ${JSON.stringify(path.resolve(p))}`).join('\n'),resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(outfile).href);}
const contact='11111111-1111-4111-8111-111111111111',preference='22222222-2222-4222-8222-222222222222';
const wire='{"preference_id":"'+preference+'","text":"合成偏好","scope":{"contact_id":null,"reply_mode":null},"revision":9007199254740993,"confirmed_operation_key":"33333333-3333-4333-8333-333333333333","origin":{"kind":"manual"},"source_ids":[],"confirmed_at":"2026-10-24T00:00:00Z","updated_at":"2026-10-24T00:00:00Z"}';
test('偏好无损JSON保留数字wire和bigint，拒绝已舍入revision',async t=>{
 const api=await modules(t),item=api.parsePreferenceJson(wire);assert.equal(item.revision,9007199254740993n);
 assert.equal(api.stringifyPreferenceJson({expected_revision:item.revision}),'{"expected_revision":9007199254740993}');
 assert.equal(api.readExpressionPreference(item).revision,9007199254740993n);
 assert.throws(()=>api.readExpressionPreference({...item,revision:9007199254740993}));
 assert.equal(api.parsePreferenceJson('{"revision":1}').revision,1);
});
test('主进程到preload结构化克隆保留bigint，未知响应后同操作键重试PATCH与DELETE',async t=>{
 const api=await modules(t);let current=api.parsePreferenceJson(wire),failure=true;const bodies=[],handlers=new Map();
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},requestJson:async ({method,body})=>{
  if(method==='GET')return {generation:1,data:{preferences:current?[current]:[]}};
  bodies.push(structuredClone(body));if(failure){failure=false;throw Error('合成丢响应');}
  if(method==='PATCH'){current={...current,text:body.text,revision:body.expected_revision+1n};return {generation:1,data:{preference:current}};}
  current=null;return {generation:1,data:{state:'deleted'}};
 }};
 const contacts={onStateChanged:()=>()=>{},getState:()=>({selectedContactId:contact,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId:contact}]})};
 api.installExpressionPreferenceBridge({handle:(name,fn)=>handlers.set(name,fn),publish:()=>{}},backend,contacts);
 const bridge=api.createExpressionPreferenceBridge({invoke:async(name,...args)=>structuredClone(await handlers.get(name)(...structuredClone(args))),on:()=>{},removeListener:()=>{}});
 const selection={contactId:contact,scopeRevision:1};await bridge.refresh(selection);
 assert.equal((await bridge.getState()).preferences[0].revision,9007199254740993n);
 const edit={...selection,preferenceId:preference,expectedRevision:9007199254740993n,text:'修改合成偏好',appliesTo:'owner',replyMode:null,confirmLongTerm:true};
 await assert.rejects(bridge.update(edit));await bridge.update(edit);assert.equal(bodies[0].operation_key,bodies[1].operation_key);
 assert.equal((await bridge.getState()).preferences[0].revision,9007199254740994n);
 failure=true;const removal={...selection,preferenceId:preference,expectedRevision:9007199254740994n};await assert.rejects(bridge.remove(removal));await bridge.remove(removal);assert.equal(bodies[2].operation_key,bodies[3].operation_key);
 assert.deepEqual((await bridge.getState()).preferences,[]);
});
test('真实共享HTTP客户端保留偏好大整数往返，同时保持安全整数与浮点',async t=>{
 const api=await modules(t);const {createServer}=await import('node:http');let received='';
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received=Buffer.concat(chunks).toString('utf8');res.setHeader('Content-Type','application/json');res.end('{"preference":'+wire+',"safe":42,"fraction":1.25}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new api.JsonClient({port:server.address().port,token:'synthetic',pid:process.pid});
 const result=await client.perform({method:'PATCH',path:'/api/expression-preferences/'+preference,body:{expected_revision:9007199254740993n,safe:42,fraction:1.25}});
 assert.equal(received,'{"expected_revision":9007199254740993,"safe":42,"fraction":1.25}');assert.equal(result.data.preference.revision,9007199254740993n);assert.equal(result.data.safe,42);assert.equal(result.data.fraction,1.25);
});
test('生产React面板通过真实HTTP和preload编辑bigint修订，数字wire不转字符串', {timeout:30000}, async t=>{
 const api=await modules(t);const {createServer}=await import('node:http');const {chromium,expect}=await import('@playwright/test');
 let current=api.parsePreferenceJson(wire),received;
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);res.setHeader('Content-Type','application/json');
  if(req.method==='GET'){res.end(api.stringifyPreferenceJson({preferences:[current]}));return;}
  received=Buffer.concat(chunks).toString('utf8');const body=api.parsePreferenceJson(received);current={...current,text:body.text,revision:body.expected_revision+1n};res.end(api.stringifyPreferenceJson({preference:current}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});t.after(()=>browser.close());
 const page=await browser.newPage(),client=new api.JsonClient({port:server.address().port,token:'synthetic',pid:process.pid}),handlers=new Map(),pending=[];
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},requestJson:async options=>({generation:1,data:(await client.perform(options)).data})};
 const contacts={onStateChanged:()=>()=>{},getState:()=>({selectedContactId:contact,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId:contact}]})};
 api.installExpressionPreferenceBridge({handle:(name,fn)=>handlers.set(name,fn),publish:(name,state)=>{pending.push(page.evaluate(({name,state})=>window.__receive?.(name,state),{name,state}));}},backend,contacts);
 await page.exposeFunction('__invoke',(name,args)=>handlers.get(name)(...args));await page.setContent('<div id="root"></div>');
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ExpressionPreferences}from'./src/renderer/ExpressionPreferences';import{createExpressionPreferenceBridge}from'./src/preload/expression-preferences';
 const listeners=new Map();window.__receive=(name,state)=>{for(const fn of listeners.get(name)||[])fn(undefined,state)};
 window.notalone={expressionPreferences:createExpressionPreferenceBridge({invoke:(name,...args)=>window.__invoke(name,args),on:(name,fn)=>listeners.set(name,[...(listeners.get(name)||[]),fn]),removeListener:(name,fn)=>listeners.set(name,(listeners.get(name)||[]).filter(x=>x!==fn))})};
 createRoot(document.getElementById('root')).render(React.createElement(ExpressionPreferences,{replies:{state:{contactId:${JSON.stringify(contact)},scopeRevision:1}}}));`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',logLevel:'silent'});
 await page.addScriptTag({content:compiled.outputFiles[0].text});await page.getByText('长期表达偏好',{exact:true}).click();
 await expect(page.getByRole('list',{name:'长期表达偏好目录'})).toContainText('9007199254740993');
 await page.getByRole('button',{name:'修改长期偏好：合成偏好'}).click();await page.getByRole('textbox',{name:'长期表达要求'}).fill('浏览器实际修改');await page.getByRole('checkbox',{name:'明确长期保存'}).check();await page.getByRole('button',{name:'确认修改长期偏好',exact:true}).click();
 await expect(page.getByRole('list',{name:'长期表达偏好目录'})).toContainText('9007199254740994');
 assert.match(received,/"expected_revision":9007199254740993(?:,|})/);assert.doesNotMatch(received,/"expected_revision":"/);assert.equal(current.text,'浏览器实际修改');await Promise.all(pending);
});
