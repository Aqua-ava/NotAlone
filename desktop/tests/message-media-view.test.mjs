import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import {readFile} from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

test('已同步的原图可查看，失效时撤下文件与播放副本',{timeout:20000},async t=>{
 const compiled=await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{MessageMediaPanel}from'./src/renderer/MessageMediaPanel';
 const listeners=new Set(),previewListeners=new Set();let state={revision:0,contactId:'00000000-0000-4000-8000-000000000001',scopeRevision:1,messageId:'00000000-0000-4000-8000-000000000002',phase:'ready',snapshot:null,busy:null,retryGoal:null,error:null};
 const publish=()=>{for(const listener of listeners)listener(structuredClone(state));};
 const snapshot={contactId:state.contactId,messageId:state.messageId,kind:'image',state:'available',generation:'0',headRevision:'0',latestAttempt:{attemptId:'00000000-0000-4000-8000-000000000003',state:'completed',outcome:'full',errorCode:null},files:[{fileId:'00000000-0000-4000-8000-000000000004',role:'image_display',imageQuality:'original',format:'png',mimeType:'image/png',byteSize:'1',viewable:true,playable:false}],capabilities:{extract:false,originalUpgrade:false,audioConversion:false,reason:null},cleanup:null};
 window.calls=[];window.releaseCount=0;window.failRead=false;window.currentSession='00000000-0000-4000-8000-000000000005';
 const bridge={getState:async()=>structuredClone(state),onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},onPreviewRevoking:listener=>{previewListeners.add(listener);return()=>previewListeners.delete(listener);},
 inspect:async()=>{window.calls.push('inspect');state={...state,revision:state.revision+1,phase:window.failRead?'failed':'ready',snapshot:window.failRead?null:structuredClone(snapshot),error:window.failRead?'媒体资料暂不可用，请重新读取。':null};publish();},
 extract:async request=>{window.calls.push(request.goal);},
 openPreview:async()=>{if(window.revokeBeforeDelivery)window.revokePreview();return {sessionId:window.currentSession,mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='};},releasePreview:async()=>{window.releaseCount++;window.releasedSrc=document.querySelector('img')?.getAttribute('src')??null;},retry:async()=>{},clear:async()=>{}};
 window.setSpaceInsufficient=()=>{snapshot.latestAttempt={...snapshot.latestAttempt,state:'failed',outcome:'no_result',errorCode:'media_space_insufficient'};state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();};
 window.setCapabilitiesReason=reason=>{snapshot.capabilities.reason=reason;state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();};
 window.revokePreview=()=>{for(const listener of previewListeners)listener(window.currentSession);};
 createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={bridge} selection={{contactId:state.contactId,messageId:state.messageId,scopeRevision:1}} messageType="image"/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,loader:{'.css':'empty'},logLevel:'silent'});
 const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
 const html=await readFile('src/renderer/index.html','utf8');const policy=/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
 await page.route('http://127.0.0.1/media-script.js',route=>route.fulfill({contentType:'application/javascript',body:compiled.outputFiles[0].text}));
 await page.route('http://127.0.0.1/media-test',route=>route.fulfill({contentType:'text/html',body:`<meta http-equiv="Content-Security-Policy" content="${policy}"><div id="root"></div><script src="/media-script.js"></script>`}));await page.goto('http://127.0.0.1/media-test');
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await page.getByRole('button',{name:'媒体文件',exact:true}).click();
 await expect(page.getByText('原图已保存',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'保存这条图片',exact:true})).toHaveCount(0);
 assert.deepEqual(await page.evaluate(()=>window.calls),['inspect']);
 await expect(page.getByText('原图',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看文件',exact:true}).click();await expect(page.getByRole('img',{name:'本条消息的已存图片'})).toHaveAttribute('src',/^blob:/);await expect.poll(()=>page.getByRole('img').evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true);
 await page.evaluate(()=>window.revokePreview());await expect(page.getByRole('img')).toHaveCount(0);assert.equal(await page.evaluate(()=>window.releaseCount),1);assert.equal(await page.evaluate(()=>window.releasedSrc),null);
 await page.evaluate(()=>{window.currentSession='00000000-0000-4000-8000-000000000006';window.revokeBeforeDelivery=true;});await page.getByRole('button',{name:'查看文件',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.releaseCount)).toBe(2);await expect(page.getByRole('img')).toHaveCount(0);
 await page.evaluate(()=>window.setSpaceInsufficient());await expect(page.getByText('本次空间不足，已停止新增写入。请清理本机空间；先前合法保存的媒体仍保留。',{exact:true})).toBeVisible();
 await expect(page.getByText('以下是先前合法保存的文件，本次操作未发布新结果。',{exact:true})).toBeVisible();await expect(page.getByText('原图',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setCapabilitiesReason('read_not_authorized'));await expect(page.getByText('读取总开关已关闭或当前读取资格已失效；已存文件仍可查看或清除。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setCapabilitiesReason('media_cleanup_pending'));await expect(page.getByText('媒体清理尚未完成，请继续核对原清理操作。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setCapabilitiesReason('media_already_running'));await expect(page.getByText('这条媒体正在处理，请刷新查看当前操作。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.failRead=true);await page.getByRole('button',{name:'刷新媒体状态',exact:true}).click();
 await expect(page.getByText('原图',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('媒体资料暂不可用');
});

test('图片状态区分原图已保存、原图未取得和已清除',{timeout:15000},async t=>{
 const compiled=await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{MessageMediaPanel}from'./src/renderer/MessageMediaPanel';
 const listeners=new Set(),selection={contactId:'00000000-0000-4000-8000-000000000001',messageId:'00000000-0000-4000-8000-000000000002',scopeRevision:1};
 let snapshot={...selection,kind:'image',state:'available',generation:'0',headRevision:'1',latestAttempt:{attemptId:'00000000-0000-4000-8000-000000000003',state:'failed',outcome:'no_result',errorCode:'media_original_unavailable'},files:[{fileId:'00000000-0000-4000-8000-000000000004',role:'image_display',imageQuality:'thumbnail',format:'png',mimeType:'image/png',byteSize:'1',viewable:true,playable:false}],capabilities:{extract:true,originalUpgrade:true,audioConversion:false,reason:null},cleanup:null};
 let state={...selection,revision:0,phase:'ready',busy:null,retryGoal:null,error:null,snapshot};const publish=()=>{for(const listener of listeners)listener(structuredClone(state));};
 window.calls=[];window.setError=errorCode=>{snapshot.latestAttempt={...snapshot.latestAttempt,errorCode};state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();};const bridge={getState:async()=>structuredClone(state),onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},onPreviewRevoking:()=>()=>{},
 inspect:async()=>{state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();},extract:async request=>{window.calls.push(request.goal);snapshot={...snapshot,state:'available',headRevision:'2',latestAttempt:{attemptId:'00000000-0000-4000-8000-000000000005',state:'completed',outcome:'full',errorCode:null},files:[{fileId:'00000000-0000-4000-8000-000000000006',role:'image_display',imageQuality:'original',format:'png',mimeType:'image/png',byteSize:'2',viewable:true,playable:false}]};state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();},retry:async()=>{},clear:async()=>{snapshot={...snapshot,state:'cleared',files:[]};state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();},openPreview:async()=>{throw new Error('not used');},releasePreview:async()=>{}};
 createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={bridge} selection={selection} messageType="image"/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
 const html=await readFile('src/renderer/index.html','utf8'),policy=/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];await page.route('http://127.0.0.1/image-status.js',route=>route.fulfill({contentType:'application/javascript',body:compiled.outputFiles[0].text}));await page.route('http://127.0.0.1/image-status',route=>route.fulfill({contentType:'text/html',body:`<meta http-equiv="Content-Security-Policy" content="${policy}"><div id="root"></div><script src="/image-status.js"></script>`}));await page.goto('http://127.0.0.1/image-status');
 await page.getByRole('button',{name:'媒体文件',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'原图未取得'})).toContainText('消息记录已保留');await expect(page.getByRole('status').filter({hasText:'原图未取得'})).not.toContainText('同步失败');await expect(page.getByText('已存缩略图（非原图）',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'保存这条图片',exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.setError('needs_image_key'));await expect(page.getByText('缺少当前账号已核验的图片密钥，或密钥不匹配；原图未取得，消息记录仍保留。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setError('media_quality_unverified'));await expect(page.getByText('图片质量无法核验，未保存该文件；消息记录仍保留。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setError('media_association_unverified'));await expect(page.getByText('消息与资源尚未唯一核验，未读取图片；消息记录仍保留。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'重新获取原图',exact:true}).click();await expect(page.getByText('原图已保存',{exact:true})).toBeVisible();await expect(page.getByText('原图',{exact:true})).toBeVisible();assert.deepEqual(await page.evaluate(()=>window.calls),['original_upgrade']);
 await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await expect(page.getByText('已清除',{exact:false})).toBeVisible();
});

test('语音本轮暂缓，旧capability与重试状态不恢复新处理入口，已有资料可查看和清除',{timeout:15000},async t=>{
 const compiled=await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{MessageMediaPanel}from'./src/renderer/MessageMediaPanel';
 const listeners=new Set();const selection={contactId:'00000000-0000-4000-8000-000000000001',messageId:'00000000-0000-4000-8000-000000000002',scopeRevision:1};
 let state={...selection,revision:0,phase:'ready',busy:null,retryGoal:'audio_conversion',error:null,snapshot:{...selection,kind:'voice',state:'available',latestAttempt:{state:'completed',outcome:'limited',errorCode:'voice_decode_failed'},files:[{fileId:'00000000-0000-4000-8000-000000000003',role:'audio_source',format:'silk',byteSize:'30',viewable:false,playable:false}],capabilities:{extract:true,audioConversion:true,originalUpgrade:true,reason:'read_not_authorized'},cleanup:null}};
 window.calls=[];const bridge={getState:async()=>structuredClone(state),onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},onPreviewRevoking:()=>()=>{},inspect:async()=>{},extract:async()=>{window.calls.push('extract');},retry:async()=>{window.calls.push('retry');},clear:async()=>{window.calls.push('clear');state={...state,revision:state.revision+1,retryGoal:null,snapshot:{...state.snapshot,state:'cleared',files:[]}};for(const listener of listeners)listener(structuredClone(state));}};
 createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={bridge} selection={selection} messageType="voice"/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
 const html=await readFile('src/renderer/index.html','utf8'),policy=/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
 await page.route('http://127.0.0.1/media-deferred.js',route=>route.fulfill({contentType:'application/javascript',body:compiled.outputFiles[0].text}));
 await page.route('http://127.0.0.1/media-deferred',route=>route.fulfill({contentType:'text/html',body:`<meta http-equiv="Content-Security-Policy" content="${policy}"><div id="root"></div><script src="/media-deferred.js"></script>`}));await page.goto('http://127.0.0.1/media-deferred');
 await page.getByRole('button',{name:'媒体文件',exact:true}).click();
 await expect(page.getByText('语音保存与格式转换本轮暂缓；已存资料仍可查看或清除。',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'保存这条语音',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'本地转为可播放文件',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'重查同次媒体操作',exact:true})).toHaveCount(0);
 await expect(page.getByText('原始语音文件',{exact:true})).toBeVisible();assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await expect(page.getByText(/本地语音转换按资格开放|可手动重试/)).toHaveCount(0);
 await page.getByRole('button',{name:'清除这条媒体',exact:true}).click();await expect(page.getByText('媒体已清除，聊天占位保留',{exact:true})).toBeVisible();assert.deepEqual(await page.evaluate(()=>window.calls),['clear']);
});
