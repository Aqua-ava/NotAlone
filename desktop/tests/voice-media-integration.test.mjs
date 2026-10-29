import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../../backend-ts/test/media-support.mjs';
import {SqliteMediaHttp} from '../../backend-ts/src/media/sqlite/http.ts';
import {SqliteContactHttp} from '../../backend-ts/src/contacts/sqlite/http.ts';
import {authorizeSqliteRequest} from '../../backend-ts/src/sqlite-host-plugin.ts';
import {VoiceMediaAdapter} from '../../backend-ts/src/media/voice/adapter.ts';
import {SilkWasmDecoder} from '../../backend-ts/src/media/voice/decoder.ts';

function deferred(){let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};}
test('正式页面保存单语音有限结果，停读后本地WASM重转并播放，清除先撤下音频再释放',{timeout:25000},async t=>{
 const {encode}=createRequire(new URL('../../backend-ts/package.json',import.meta.url))('silk-wasm');
 const pcm=Buffer.alloc(9600);for(let i=0;i<4800;i++)pcm.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*440*i/24000)),i*2);
 const {data:silk}=await encode(pcm,24000);let reads=0,failDecode=true;
 const source={read:async c=>{reads++;return {authority:c.token,close:async()=>{},expectedBytes:silk.length,expectedSha256:createHash('sha256').update(silk).digest('hex'),bytes:(async function*(){yield silk;})(),finish:async()=>({protocol:'voice-complete-read-v1',complete:true,expectedBytes:silk.length,association:{protocol:'media-association-v1',profileId:'synthetic-voice-page-v1',recordId:c.source.recordId,messageId:c.messageId,resourceIdentity:'synthetic-voice-one'}})};}};
 const wasm=new SilkWasmDecoder();const adapter=new VoiceMediaAdapter({source,decoder:{decode:async(...args)=>{if(failDecode)throw Error('合成首轮失败');return wasm.decode(...args);},close:()=>wasm.close()}});
 const cleanup=[];const f=await fixture({after:cb=>cleanup.push(cb)},adapter);const message=f.messages.find(m=>m.kind==='voice');
 let browser,page,server,media,ready=false,holdRelease=false;let dispatch=Promise.resolve();const releaseArrived=deferred(),releaseGate=deferred();const released=[];
 t.after(async()=>{ready=false;releaseGate.resolve();const failures=[];for(const close of [()=>media?.dispose(),async()=>{await dispatch;await browser?.close();},async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}},...cleanup.reverse()])try{await close();}catch(e){failures.push(e);}if(failures.length)throw new AggregateError(failures);});
 const node=await build({stdin:{contents:`export {BackendHost} from './src/main/backend/host';export {RuntimeClient} from './src/main/backend/runtime-client';export {installContactSessionBridge} from './src/main/contacts/bridge';export {installMessageMediaBridge} from './src/main/media/bridge';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {BackendHost,RuntimeClient,installContactSessionBridge,installMessageMediaBridge}=await import(`data:text/javascript;base64,${Buffer.from(node.outputFiles[0].text).toString('base64')}`);
 const html=(await readFile('src/renderer/index.html','utf8')).replace('src="./index.tsx"','src="./voice-integration.js"');let script='';const token=randomBytes(32).toString('base64url');const api=new SqliteMediaHttp(f.media),contactApi=new SqliteContactHttp(f.contacts);
 server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/index.html'){res.writeHead(200,{'Content-Type':'text/html'}).end(html);return;}
  if(req.method==='GET'&&req.url==='/voice-integration.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(script);return;}
  if(!authorizeSqliteRequest(req,token)){res.writeHead(401).end();return;}
  try{if(!await api.handle(req,res)&&!await contactApi.handle(req,res))res.writeHead(404).end();}catch{res.writeHead(500).end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 // 仅将运输指向隔离HTTP；正式主进程桥、预加载桥、控制器及服务全部保留。
 const backend=new BackendHost(f.root);backend.state={phase:'connected'};backend.generation=1;backend.target=new RuntimeClient({address:`127.0.0.1:${port}`,port,token,pid:process.pid});
 const handlers=new Map();const commands={handle:(channel,handler)=>handlers.set(channel,handler),publish:(channel,state)=>{if(ready)dispatch=dispatch.then(()=>page.evaluate(({channel,state})=>window.deliver(channel,state),{channel,state}));}};
 const contacts=installContactSessionBridge(commands,backend);await contacts.refreshContacts();contacts.selectContact({contactId:f.contact,scopeRevision:contacts.getState().scopeRevision});media=installMessageMediaBridge(commands,backend,contacts);
 const selection={contactId:f.contact,messageId:message.id,scopeRevision:contacts.getState().scopeRevision};
 const compiled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MessageMediaPanel} from './src/renderer/MessageMediaPanel';import {createMessageMediaBridge} from './src/preload/media';const listeners=new Map();const transport={invoke:(c,...a)=>window.invoke(c,...a),on:(c,l)=>{let s=listeners.get(c);if(!s)listeners.set(c,s=new Set());s.add(l);},removeListener:(c,l)=>listeners.get(c)?.delete(l)};window.deliver=(c,s)=>{for(const l of listeners.get(c)??[])l({},s);};createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={createMessageMediaBridge(transport)} selection={${JSON.stringify(selection)}} messageType="voice"/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});script=compiled.outputFiles[0].text;
 browser=await chromium.launch({headless:true,channel:'chrome'});page=await browser.newPage();await page.exposeFunction('invoke',async(c,...args)=>{
  if(c==='media:release-preview'){released.push(await page.locator('audio[src]').count());releaseArrived.resolve();if(holdRelease)await releaseGate.promise;}
  return handlers.get(c)(...args);
 });await page.goto(`http://127.0.0.1:${port}/index.html`);ready=true;
 assert.equal(reads,0);await page.getByRole('button',{name:'媒体文件',exact:true}).click();await expect(page.getByRole('button',{name:'保存这条语音',exact:true})).toBeEnabled();assert.equal(reads,0);
 await page.getByRole('button',{name:'保存这条语音',exact:true}).click();await expect(page.getByText('语音已保存，暂不可播放',{exact:true})).toBeVisible();await expect(page.getByText('语音解码失败；可手动重试本地转换。',{exact:true})).toBeVisible();assert.equal(reads,1);
 await f.contacts.setReading(false);failDecode=false;await page.getByRole('button',{name:'刷新媒体状态',exact:true}).click();await expect(page.getByRole('button',{name:'保存这条语音',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'本地转为可播放文件',exact:true}).click();await expect(page.getByText('已保存完整结果',{exact:true})).toBeVisible();assert.equal(reads,1);
 const saved=await f.media.read(f.contact,message.id),paths=[];for(const file of saved.files){const ref=await f.storage.execute('media.file',{ownerId:f.owner,contactId:f.contact,messageId:message.id,fileId:file.fileId});paths.push(f.media.files.location(ref.address));}
 await page.getByRole('button',{name:'播放文件',exact:true}).click();const audio=page.locator('audio');await expect(audio).toHaveAttribute('src',/^blob:/);await expect.poll(()=>audio.evaluate(e=>e.readyState)).toBeGreaterThanOrEqual(2);assert.equal(await audio.evaluate(e=>e.duration),0.2);
 await audio.evaluate(async e=>{await e.play();await new Promise((resolve,reject)=>{e.onended=resolve;e.onerror=reject;});});
 holdRelease=true;await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await releaseArrived.promise;await expect(audio).toHaveCount(0);assert.deepEqual(released,[0]);
 let pending;await expect.poll(async()=>{pending=(await f.media.deletion.list({ownerId:f.owner})).find(o=>o.scope.kind==='media_result_clear');return pending?.state;}).toBe('cleaning');assert.notEqual(pending.state,'completed');for(const p of paths)assert.equal((await lstat(p)).isFile(),true);
 releaseGate.resolve();await expect(page.getByText('媒体已清除，聊天占位保留',{exact:true})).toBeVisible();for(const p of paths)await assert.rejects(lstat(p),{code:'ENOENT'});
 assert.equal((await f.media.deletion.status(pending)).state,'completed');assert.equal((await f.history.read(f.contact)).messages.length,4);assert.equal(reads,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
