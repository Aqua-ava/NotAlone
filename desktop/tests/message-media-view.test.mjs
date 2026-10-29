import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('单消息媒体页只在明确操作后提取，失效撤下文件与播放副本',{timeout:20000},async t=>{
 const compiled=await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{MessageMediaPanel}from'./src/renderer/MessageMediaPanel';
 const listeners=new Set(),previewListeners=new Set();let state={revision:0,contactId:'00000000-0000-4000-8000-000000000001',scopeRevision:1,messageId:'00000000-0000-4000-8000-000000000002',phase:'ready',snapshot:null,busy:null,retryGoal:null,error:null};
 const publish=()=>{for(const listener of listeners)listener(structuredClone(state));};
 const snapshot={contactId:state.contactId,messageId:state.messageId,kind:'image',state:'available',generation:'0',headRevision:'0',latestAttempt:null,files:[],capabilities:{extract:true,originalUpgrade:false,audioConversion:false,reason:null},cleanup:null};
 window.calls=[];window.releaseCount=0;window.failRead=false;window.currentSession='00000000-0000-4000-8000-000000000005';
 const bridge={getState:async()=>structuredClone(state),onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},onPreviewRevoking:listener=>{previewListeners.add(listener);return()=>previewListeners.delete(listener);},
 inspect:async()=>{window.calls.push('inspect');state={...state,revision:state.revision+1,phase:window.failRead?'failed':'ready',snapshot:window.failRead?null:structuredClone(snapshot),error:window.failRead?'媒体资料暂不可用，请重新读取。':null};publish();},
 extract:async request=>{window.calls.push(request.goal);snapshot.state='active';snapshot.latestAttempt={attemptId:'00000000-0000-4000-8000-000000000003',state:'completed',outcome:'limited',errorCode:null};snapshot.files=[{fileId:'00000000-0000-4000-8000-000000000004',role:'image_display',imageQuality:'thumbnail',format:'png',mimeType:'image/png',byteSize:'1',viewable:true,playable:false}];state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();},
 openPreview:async()=>{if(window.revokeBeforeDelivery)window.revokePreview();return {sessionId:window.currentSession,mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='};},releasePreview:async()=>{window.releaseCount++;window.releasedSrc=document.querySelector('img')?.getAttribute('src')??null;},retry:async()=>{},clear:async()=>{}};
 window.setSpaceInsufficient=()=>{snapshot.latestAttempt={...snapshot.latestAttempt,state:'failed',outcome:'no_result',errorCode:'media_space_insufficient'};state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();};
 window.setCapabilitiesReason=reason=>{snapshot.capabilities.reason=reason;state={...state,revision:state.revision+1,snapshot:structuredClone(snapshot)};publish();};
 window.revokePreview=()=>{for(const listener of previewListeners)listener(window.currentSession);};
 createRoot(document.getElementById('root')).render(<MessageMediaPanel bridge={bridge} selection={{contactId:state.contactId,messageId:state.messageId,scopeRevision:1}} messageType="image"/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,loader:{'.css':'empty'},logLevel:'silent'});
 const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const page=await browser.newPage();
 await page.route('http://127.0.0.1/media-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/media-test');await page.addScriptTag({content:compiled.outputFiles[0].text});
 assert.deepEqual(await page.evaluate(()=>window.calls),[]);
 await page.getByRole('button',{name:'媒体文件',exact:true}).click();
 await expect(page.getByRole('button',{name:'保存这条图片',exact:true})).toBeEnabled();
 assert.deepEqual(await page.evaluate(()=>window.calls),['inspect']);
 await page.getByRole('button',{name:'保存这条图片',exact:true}).click();await expect(page.getByText('缩略图，原图未取得',{exact:true})).toBeVisible();
 await expect(page.getByText('已保存有限结果',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看文件',exact:true}).click();await expect(page.getByRole('img',{name:'本条消息的已存图片'})).toHaveAttribute('src',/^blob:/);
 await page.evaluate(()=>window.revokePreview());await expect(page.getByRole('img')).toHaveCount(0);assert.equal(await page.evaluate(()=>window.releaseCount),1);assert.equal(await page.evaluate(()=>window.releasedSrc),null);
 await page.evaluate(()=>{window.currentSession='00000000-0000-4000-8000-000000000006';window.revokeBeforeDelivery=true;});await page.getByRole('button',{name:'查看文件',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.releaseCount)).toBe(2);await expect(page.getByRole('img')).toHaveCount(0);
 await page.evaluate(()=>window.setSpaceInsufficient());await expect(page.getByText('本次空间不足，已停止新增写入。请清理本机空间；先前合法保存的媒体仍保留。',{exact:true})).toBeVisible();
 await expect(page.getByText('以下是先前合法保存的文件，本次操作未发布新结果。',{exact:true})).toBeVisible();await expect(page.getByText('缩略图，原图未取得',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setCapabilitiesReason('read_not_authorized'));await expect(page.getByText('读取总开关已关闭或当前读取资格已失效；已存文件仍可查看，本地语音转换按资格开放。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setCapabilitiesReason('media_cleanup_pending'));await expect(page.getByText('媒体清理尚未完成，请继续核对原清理操作。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.setCapabilitiesReason('media_already_running'));await expect(page.getByText('这条媒体正在处理，请刷新查看当前操作。',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.failRead=true);await page.getByRole('button',{name:'刷新媒体状态',exact:true}).click();
 await expect(page.getByText('缩略图，原图未取得',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('媒体资料暂不可用');
});
