import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {randomBytes,createCipheriv} from 'node:crypto';
import {readFile,lstat,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {fixture} from '../../backend-ts/test/media-support.mjs';
import {png,resourcePort} from '../../backend-ts/test/visual-media-support.mjs';
import {VisualMediaAdapter} from '../../backend-ts/src/media/visual/adapter.ts';
import {SqliteContactHttp} from '../../backend-ts/src/contacts/sqlite/http.ts';
import {SqliteMediaHttp} from '../../backend-ts/src/media/sqlite/http.ts';
import {authorizeSqliteRequest} from '../../backend-ts/src/sqlite-host-plugin.ts';
test.before(async()=>{await promisify(execFile)('bash',[fileURLToPath(new URL('../../native/media-validation/build.sh',import.meta.url))],{timeout:20000,maxBuffer:64*1024});});

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function visualPage(t,kind,options){
 let opens=0;const port=resourcePort(options),cleanups=[];
 const adapter=new VisualMediaAdapter({open:context=>{opens++;return port.open(context);}});
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)},adapter);
 const message=f.messages.find(item=>item.kind===kind);
 let browser,page,server,media,ready=false,script='',dispatch=Promise.resolve(),holdRelease=false;
 const released=deferred(),release=deferred(),releaseEvidence=[],publicationFailures=[],calls=[];
 t.after(async()=>{
  release.resolve();const failures=[];
  for(const cleanup of [()=>media?.dispose(),()=>browser?.close(),async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}},...cleanups.reverse()]){
   try{await cleanup();}catch(error){failures.push(error);}
  }
  if(failures.length)throw new AggregateError(failures,'图片视频页面合成资源清理失败');
 });
 const bundle=await build({stdin:{contents:`
 export {BackendHost} from './src/main/backend/host';
 export {RuntimeClient} from './src/main/backend/runtime-client';
 export {installContactSessionBridge} from './src/main/contacts/bridge';
 export {installMessageMediaBridge} from './src/main/media/bridge';
 export {pageRoleAllowed} from './src/main/page-commands';
 `,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {BackendHost,RuntimeClient,installContactSessionBridge,installMessageMediaBridge,pageRoleAllowed}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
 const html=await readFile('src/renderer/index.html','utf8');
 const csp=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
 const token=randomBytes(32).toString('base64url'),contactsHttp=new SqliteContactHttp(f.contacts),mediaHttp=new SqliteMediaHttp(f.media);
 server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/visual-page'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}).end(`<meta http-equiv="Content-Security-Policy" content="${csp}"><div id="root"></div><script src="/visual.js"></script>`);return;}
  if(req.method==='GET'&&req.url==='/visual.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(script);return;}
  if(!authorizeSqliteRequest(req,token)){res.writeHead(401,{'Content-Type':'application/json'}).end('{"error":"unauthorized"}');return;}
  calls.push({method:req.method,path:req.url});
  try{if(!await mediaHttp.handle(req,res)&&!await contactsHttp.handle(req,res))res.writeHead(404).end();}
  catch{res.writeHead(500,{'Content-Type':'application/json'}).end('{"error":"visual_test_transport_failed"}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const number=server.address().port,backend=new BackendHost(f.root);backend.state={phase:'connected'};backend.generation=1;
 // 仅固定隔离HTTP目标；认证、类型处理、受管文件和删除均走正式入口。
 backend.target=new RuntimeClient({address:`127.0.0.1:${number}`,port:number,token,pid:process.pid});
 const handlers=new Map(),commands={handle(channel,handler,role){handlers.set(channel,{handler,role});},publish(channel,state){
  if(ready)dispatch=dispatch.then(()=>page.evaluate(({channel,state})=>window.deliver(channel,state),{channel,state})).catch(()=>publicationFailures.push(channel));
 }};
 const contacts=installContactSessionBridge(commands,backend);await contacts.refreshContacts();
 contacts.selectContact({contactId:f.contact,scopeRevision:contacts.getState().scopeRevision});
 media=installMessageMediaBridge(commands,backend,contacts);
 const selection={contactId:f.contact,messageId:message.id,scopeRevision:contacts.getState().scopeRevision};
 const browserBundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {MessageMediaPanel} from './src/renderer/MessageMediaPanel';
 import {createMessageMediaBridge} from './src/preload/media';
 const listeners=new Map(),transport={invoke:(channel,...args)=>window.invoke(channel,...args),on:(channel,listener)=>{let set=listeners.get(channel);if(!set)listeners.set(channel,set=new Set());set.add(listener);},removeListener:(channel,listener)=>listeners.get(channel)?.delete(listener)};
 window.deliver=(channel,state)=>{for(const listener of listeners.get(channel)??[])listener({},state);};
 createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={createMessageMediaBridge(transport)} selection={${JSON.stringify(selection)}} messageType="${kind}"/>);
 window.visualReady=true;
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 script=browserBundle.outputFiles[0].text;
 browser=await chromium.launch({headless:true,channel:'chrome'});page=await browser.newPage();
 await page.exposeFunction('invoke',async(channel,...args)=>{
  const command=handlers.get(channel);assert.ok(command);assert.equal(pageRoleAllowed('helper',command.role),true);
  if(channel==='media:release-preview'){
   releaseEvidence.push(await page.evaluate(()=>({imageSources:document.querySelectorAll('img[src]').length,videoSources:document.querySelectorAll('video[src]').length,videoPaused:document.querySelector('video')?.paused??true})));
   released.resolve();if(holdRelease)await release.promise;
  }
  return command.handler(...args);
 });
 await page.goto(`http://127.0.0.1:${number}/visual-page`);await page.waitForFunction(()=>window.visualReady===true);ready=true;
 assert.equal(opens,0);await page.getByRole('button',{name:'媒体文件',exact:true}).click();
 await expect(page.getByRole('button',{name:`保存这条${kind==='image'?'图片':'视频'}`,exact:true})).toBeEnabled();assert.equal(opens,0);
 return {f,message,page,calls,releaseEvidence,publicationFailures,released,release,hold:()=>{holdRelease=true;},opens:()=>opens};
}
function missingKeyDat(){
 const cipher=createCipheriv('aes-128-ecb',Buffer.from('synthetic-key17!'),null);
 const aes=Buffer.concat([cipher.update(png.subarray(0,16)),cipher.final()]);
 const header=Buffer.from([7,8,86,50,8,7,16,0,0,0,0,0,0,0,0]);
 return Buffer.concat([header,aes,png.subarray(16)]);
}

test('真实图片类型经HTTP和具名桥显示缩略图、补原图及失败，撤下预览后才完成清除',{timeout:25000},async t=>{
 const options={data:png,quality:{kind:'thumbnail',proof:'synthetic-thumbnail-v1'}};
 const h=await visualPage(t,'image',options),{page,f,message}=h;
 await page.getByRole('button',{name:'保存这条图片',exact:true}).click();
 await expect(page.getByText('缩略图，原图未取得',{exact:true})).toBeVisible();
 const thumbnail=await f.media.read(f.contact,message.id);assert.equal(thumbnail.latestAttempt.outcome,'limited');
 options.quality={kind:'original',proof:'synthetic-original-v1'};
 await page.getByRole('button',{name:'补提原图',exact:true}).click();await expect(page.getByText('原图',{exact:true})).toBeVisible();
 const original=await f.media.read(f.contact,message.id);assert.equal(original.latestAttempt.outcome,'full');assert.notEqual(original.files[0].fileId,thumbnail.files[0].fileId);
 options.data=missingKeyDat();options.envelope='wechat_dat';
 await page.getByRole('button',{name:'补提原图',exact:true}).click();await expect(page.getByRole('alert')).toContainText('媒体操作结果尚未确认');
 await page.getByRole('button',{name:'刷新媒体状态',exact:true}).click();
 await expect(page.getByText('缺少当前账号已核验的图片密钥，或密钥不匹配；本次未取得图片。',{exact:true})).toBeVisible();
 const failed=await f.media.read(f.contact,message.id);assert.equal(failed.latestAttempt.errorCode,'needs_image_key');assert.equal(failed.files[0].fileId,original.files[0].fileId);assert.equal(h.opens(),3);
 await page.getByRole('button',{name:'查看文件',exact:true}).click();
 const image=page.getByRole('img',{name:'本条消息的已存图片'});await expect.poll(()=>image.evaluate(element=>({width:element.naturalWidth,height:element.naturalHeight}))).toEqual({width:1,height:1});
 const current=await f.storage.execute('media.file',{ownerId:f.owner,contactId:f.contact,messageId:message.id,fileId:original.files[0].fileId}),location=f.media.files.location(current.address);
 h.hold();await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await h.released.promise;
 await expect(image).toHaveCount(0);assert.deepEqual(h.releaseEvidence,[{imageSources:0,videoSources:0,videoPaused:true}]);
 let receipt;await expect.poll(async()=>{receipt=(await f.media.deletion.list({ownerId:f.owner})).find(op=>op.scope.kind==='media_result_clear');return receipt?.state;}).toBe('cleaning');
 assert.equal((await lstat(location)).isFile(),true);h.release.resolve();await expect(page.getByText('媒体已清除，聊天占位保留',{exact:true})).toBeVisible();
 assert.equal((await f.media.deletion.status({ownerId:f.owner,operationId:receipt.operationId})).state,'completed');await assert.rejects(lstat(location),{code:'ENOENT'});
 assert.ok((await f.history.read(f.contact)).messages.some(item=>item.id===message.id));
 options.data=png;options.envelope='plain';options.quality={kind:'unknown',proof:null};
 await page.getByRole('button',{name:'保存这条图片',exact:true}).click();await expect(page.getByText('图片质量未核验',{exact:true})).toBeVisible();
 assert.equal((await f.media.read(f.contact,message.id)).latestAttempt.outcome,'quality_unknown');
 await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await expect(page.getByText('媒体已清除，聊天占位保留',{exact:true})).toBeVisible();
 assert.equal(h.opens(),4);assert.deepEqual(h.publicationFailures,[]);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实视频类型经正常页面播放H264与AAC，拒绝未知编码及截断并撤下活动播放器',{timeout:35000},async t=>{
 const sourceRoot=await mkdtemp(join(tmpdir(),'notalone-visual-page-'));
 t.after(()=>rm(sourceRoot,{recursive:true,force:true}));
 // 显式测试准备，仅生成合成资料；产品运行时不编译、下载或写入外部原件。
 await promisify(execFile)('bash',[fileURLToPath(new URL('../../native/media-validation/build-fixtures.sh',import.meta.url)),sourceRoot],{timeout:20000,maxBuffer:64*1024});
 const video=await readFile(join(sourceRoot,'h264-aac.mp4')),hevc=await readFile(join(sourceRoot,'hevc.mp4'));
 const options={data:video,quality:{kind:'unknown',proof:null}},h=await visualPage(t,'video',options),{page,f,message}=h;
 await page.getByRole('button',{name:'保存这条视频',exact:true}).click();await expect(page.getByText('已保存完整结果',{exact:true})).toBeVisible();
 const saved=await f.media.read(f.contact,message.id);assert.equal(saved.files[0].playable,true);assert.equal(saved.files[0].format,'mp4');
 options.data=hevc;
 await page.getByRole('button',{name:'保存这条视频',exact:true}).click();await expect(page.getByRole('alert')).toContainText('媒体操作结果尚未确认');
 await page.getByRole('button',{name:'刷新媒体状态',exact:true}).click();await expect(page.getByText('此媒体格式或编码尚未支持，本次未保存新结果。',{exact:true})).toBeVisible();
 assert.equal((await f.media.read(f.contact,message.id)).files[0].fileId,saved.files[0].fileId);
 options.data=video.subarray(0,video.length-8);
 await page.getByRole('button',{name:'保存这条视频',exact:true}).click();await expect(page.getByRole('alert')).toContainText('媒体操作结果尚未确认');
 await page.getByRole('button',{name:'刷新媒体状态',exact:true}).click();await expect(page.getByText('视频容器不完整或无法完整解码，本次未保存新结果。',{exact:true})).toBeVisible();
 assert.equal((await f.media.read(f.contact,message.id)).files[0].fileId,saved.files[0].fileId);assert.equal(h.opens(),3);
 await page.getByRole('button',{name:'播放文件',exact:true}).click();const player=page.locator('video');
 await expect(player).toHaveAttribute('src',/^blob:/);
 await expect.poll(()=>player.evaluate(element=>({width:element.videoWidth,height:element.videoHeight,duration:element.duration}))).toEqual({width:16,height:16,duration:2});
 await player.evaluate(async element=>{element.muted=true;await element.play();});
 await expect.poll(()=>player.evaluate(element=>!element.paused&&element.currentTime>0),{timeout:3000}).toBe(true);
 const current=await f.storage.execute('media.file',{ownerId:f.owner,contactId:f.contact,messageId:message.id,fileId:saved.files[0].fileId}),location=f.media.files.location(current.address);
 assert.deepEqual(await readFile(location),video);
 h.hold();await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await h.released.promise;
 await expect(player).toHaveCount(0);assert.deepEqual(h.releaseEvidence,[{imageSources:0,videoSources:0,videoPaused:true}]);
 let receipt;await expect.poll(async()=>{receipt=(await f.media.deletion.list({ownerId:f.owner})).find(op=>op.scope.kind==='media_result_clear');return receipt?.state;}).toBe('cleaning');
 assert.equal((await lstat(location)).isFile(),true);h.release.resolve();await expect(page.getByText('媒体已清除，聊天占位保留',{exact:true})).toBeVisible();
 assert.equal((await f.media.deletion.status({ownerId:f.owner,operationId:receipt.operationId})).state,'completed');await assert.rejects(lstat(location),{code:'ENOENT'});
 assert.ok((await f.history.read(f.contact)).messages.some(item=>item.id===message.id));
 // 外部合成原件仍在，媒体清理没有修改它。
 assert.deepEqual(await readFile(join(sourceRoot,'h264-aac.mp4')),video);
 assert.equal(h.opens(),3);assert.deepEqual(h.publicationFailures,[]);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
