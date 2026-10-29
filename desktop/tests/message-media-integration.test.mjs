import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { fixture } from '../../backend-ts/test/media-support.mjs';
import { SqliteContactHttp } from '../../backend-ts/src/contacts/sqlite/http.ts';
import { SqliteMediaHttp } from '../../backend-ts/src/media/sqlite/http.ts';
import { authorizeSqliteRequest } from '../../backend-ts/src/sqlite-host-plugin.ts';

function deferred() { let resolve; const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; }
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

test('生产CSP页面经具名桥和认证SQLite保存单条图片，真实显示后撤下ACK才完成清除',{timeout:25000},async t=>{
 let executions=0;
 // 黄金样例替代17的渠道/类型适配器；只证明本票文件生命周期，真实浏览器另行验证PNG可显示。
 const adapter={version:'synthetic-page-png-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',execute:async context=>{
  executions++;await context.checkpoint();
  await context.save({role:'image_display',expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),
   bytes:(async function*(){yield png.subarray(0,20);await context.checkpoint();yield png.subarray(20);})(),
   validate:async localPath=>{assert.deepEqual(await readFile(localPath),png);return {format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:'thumbnail',qualityProof:null};}});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-page-png-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-page-png-one'}};
 }};
 const cleanups=[];
 const f=await fixture({after:callback=>cleanups.push(callback)},adapter);
 const message=f.messages.find(m=>m.kind==='image');assert.ok(message);
 let browser,page,server,media,publicationReady=false;
 const releaseGate=deferred(),releaseArrived=deferred();let holdRelease=false;
 const publications=[],publicationFailures=[],calls=[],releaseEvidence=[];
 let dispatch=Promise.resolve();
 t.after(async()=>{
  releaseGate.resolve();const failures=[];
  for(const cleanup of [()=>media?.dispose(),()=>browser?.close(),async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}},...cleanups.reverse()]){
   try{await cleanup();}catch(error){failures.push(error);}
  }
  if(failures.length)throw new AggregateError(failures,'隔离媒体页面资源清理失败');
 });
 const nodeBundle=await build({stdin:{contents:`
 export { BackendHost } from './src/main/backend/host';
 export { RuntimeClient } from './src/main/backend/runtime-client';
 export { installContactSessionBridge } from './src/main/contacts/bridge';
 export { installMessageMediaBridge } from './src/main/media/bridge';
 export { pageRoleAllowed } from './src/main/page-commands';
 `,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {BackendHost,RuntimeClient,installContactSessionBridge,installMessageMediaBridge,pageRoleAllowed}=await import(`data:text/javascript;base64,${Buffer.from(nodeBundle.outputFiles[0].text).toString('base64')}`);
 const html=await readFile(new URL('../src/renderer/index.html',import.meta.url),'utf8');
 const csp=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
 assert.ok(csp?.includes("script-src 'self'"));assert.ok(csp.includes("connect-src 'none'"));assert.ok(csp.includes("img-src 'self' blob:"));
 const servedHtml=html.replace('src="./index.tsx"','src="./message-media-integration.js"');assert.notEqual(servedHtml,html);
 let browserScript='';
 const token=randomBytes(32).toString('base64url'),contactHttp=new SqliteContactHttp(f.contacts),mediaHttp=new SqliteMediaHttp(f.media);
 server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/index.html'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}).end(servedHtml);return;}
  if(req.method==='GET'&&req.url==='/message-media-integration.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(browserScript);return;}
  if(!authorizeSqliteRequest(req,token)){res.writeHead(401,{'Content-Type':'application/json'}).end('{"error":"unauthorized"}');return;}
  calls.push({method:req.method,path:req.url});
  try{if(!await mediaHttp.handle(req,res)&&!await contactHttp.handle(req,res))res.writeHead(404,{'Content-Type':'application/json'}).end('{"error":"not_found"}');}
  catch{res.writeHead(500,{'Content-Type':'application/json'}).end('{"error":"integration_transport_failed"}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 // 仅固定隔离HTTP运输目标，跳过桌面宿主发现/启动；实际请求、认证、领域和文件结果均使用生产实现。
 const backend=new BackendHost(f.root);backend.state={phase:'connected'};backend.generation=1;
 backend.target=new RuntimeClient({address:`127.0.0.1:${port}`,port,token,pid:process.pid});
 const handlers=new Map();
 const commands={handle(channel,handler,role){handlers.set(channel,{handler,role});},publish(channel,state){
  publications.push(channel);
  if(publicationReady)dispatch=dispatch.then(()=>page.evaluate(({channel,state})=>window.mediaDeliver(channel,state),{channel,state})).catch(()=>{publicationFailures.push(channel);});
 }};
 const contacts=installContactSessionBridge(commands,backend);await contacts.refreshContacts();
 assert.equal(contacts.getState().directoryPhase,'ready');contacts.selectContact({contactId:f.contact,scopeRevision:contacts.getState().scopeRevision});
 media=installMessageMediaBridge(commands,backend,contacts);
 const selection={contactId:f.contact,messageId:message.id,scopeRevision:contacts.getState().scopeRevision};
 const compiled=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {MessageMediaPanel} from './src/renderer/MessageMediaPanel';
 import {createMessageMediaBridge} from './src/preload/media';
 const listeners=new Map();
 const transport={invoke:(channel,...args)=>window.mediaInvoke(channel,...args),on:(channel,listener)=>{let group=listeners.get(channel);if(!group)listeners.set(channel,group=new Set());group.add(listener);},removeListener:(channel,listener)=>listeners.get(channel)?.delete(listener)};
 window.mediaDeliver=(channel,state)=>{for(const listener of listeners.get(channel)??[])listener({},state);};
 const bridge=createMessageMediaBridge(transport);
 createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={bridge} selection={${JSON.stringify(selection)}} messageType="image"/>);
 window.mediaPageReady=true;
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,loader:{'.css':'empty'},logLevel:'silent'});
 browserScript=compiled.outputFiles[0].text;
 browser=await chromium.launch({headless:true,channel:'chrome'});page=await browser.newPage();
 await page.exposeFunction('mediaInvoke',async(channel,...args)=>{
  const command=handlers.get(channel);assert.ok(command);assert.equal(pageRoleAllowed('helper',command.role),true);
  if(channel==='media:release-preview'){
   // 仅延迟IPC传输，不伪造释放结果；DOM证据采集后，原具名handler仍执行真实认证DELETE。
   releaseEvidence.push(await page.evaluate(()=>({imageSrc:document.querySelector('img')?.getAttribute('src')??null,imageCount:document.querySelectorAll('img[src]').length})));
   releaseArrived.resolve();if(holdRelease)await releaseGate.promise;
  }
  return command.handler(...args);
 });
 await page.goto(`http://127.0.0.1:${port}/index.html`);await page.waitForFunction(()=>window.mediaPageReady===true);publicationReady=true;
 assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),csp);
 // 保留生产网络与脚本限制：连接被CSP拒绝，动态内联脚本也不能执行。
 assert.equal(await page.evaluate(async()=>{try{await fetch('/api/runtime/status');return false;}catch{return true;}}),true);
 assert.equal(await page.evaluate(()=>{const script=document.createElement('script');script.textContent='window.inlineScriptEscaped=true';document.head.append(script);return window.inlineScriptEscaped===true;}),false);
 assert.equal(executions,0);
 await page.getByRole('button',{name:'媒体文件',exact:true}).click();
 await expect(page.getByRole('button',{name:'保存这条图片',exact:true})).toBeEnabled();assert.equal(executions,0);
 await page.getByRole('button',{name:'保存这条图片',exact:true}).click();
 await expect(page.getByText('已保存有限结果',{exact:true})).toBeVisible();await expect(page.getByText('缩略图，原图未取得',{exact:true})).toBeVisible();
 assert.equal(executions,1);
 const saved=await f.media.read(f.contact,message.id);assert.equal(saved.latestAttempt.state,'completed');assert.equal(saved.latestAttempt.outcome,'limited');assert.equal(saved.files.length,1);
 const current=await f.storage.execute('media.file',{ownerId:f.owner,contactId:f.contact,messageId:message.id,fileId:saved.files[0].fileId});
 const filePath=f.media.files.location(current.address);assert.deepEqual(await readFile(filePath),png);
 await page.getByRole('button',{name:'查看文件',exact:true}).click();
 const image=page.getByRole('img',{name:'本条消息的已存图片'});await expect(image).toHaveAttribute('src',/^blob:/);
 await expect.poll(()=>image.evaluate(element=>({complete:element.complete,width:element.naturalWidth,height:element.naturalHeight}))).toEqual({complete:true,width:1,height:1});
 holdRelease=true;await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await releaseArrived.promise;
 await expect(image).toHaveCount(0);assert.deepEqual(releaseEvidence,[{imageSrc:null,imageCount:0}]);
 let deletion;
 await expect.poll(async()=>{deletion=(await f.media.deletion.list({ownerId:f.owner})).find(op=>op.scope.kind==='media_result_clear');return deletion?.state;},{timeout:3000}).toBe('cleaning');
 assert.notEqual(deletion.state,'completed');assert.equal((await lstat(filePath)).isFile(),true);
 releaseGate.resolve();await expect(page.getByText('媒体已清除，聊天占位保留',{exact:true})).toBeVisible();
 const receipt=await f.media.deletion.status({ownerId:f.owner,operationId:deletion.operationId});assert.equal(receipt.state,'completed');assert.equal(receipt.checks.some(check=>check.result.result==='blocked'),false);
 await assert.rejects(lstat(filePath),{code:'ENOENT'});assert.deepEqual((await f.media.read(f.contact,message.id)).files,[]);
 const preserved=(await f.history.read(f.contact)).messages.find(m=>m.id===message.id);assert.ok(preserved);assert.equal(preserved.kind,'image');assert.equal(preserved.text,null);
 assert.equal(executions,1);assert.equal(calls.filter(call=>call.method==='POST'&&call.path===`/api/contacts/${f.contact}/messages/${message.id}/media`).length,1);
 assert.equal(calls.filter(call=>call.method==='DELETE'&&call.path.startsWith('/api/media/previews/')).length,1);
 assert.equal(calls.some(call=>call.path==='/api/runtime/status'),false);assert.equal(publications.includes('media:preview-revoking'),true);assert.deepEqual(publicationFailures,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
