import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundled=await build({stdin:{contents:"export { installMessageMediaBridge } from './src/main/media/bridge';export { createMessageMediaBridge } from './src/preload/media';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {installMessageMediaBridge,createMessageMediaBridge}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const contactId='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002',selection={contactId,messageId,scopeRevision:1};
test('聊天图片只开放带联系人范围的只读预览命令并拒绝非图片格式',async()=>{
 const handlers=new Map(),sessionId='00000000-0000-4000-8000-000000000021',fileId='00000000-0000-4000-8000-000000000022';let calls=[];
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},releaseUnhandedMediaPreviews:async()=>{},
  openMediaPreview:async input=>{calls.push(input);return {generation:1,data:{sessionId,mimeType:'image/png',dataBase64:'iVBORw0KGgo='},connection:{status:async()=>'active',release:async()=>{}}};}};
 const contacts={getState:()=>({selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]}),onStateChanged:()=>()=>{}};
 installMessageMediaBridge({handle:(channel,handler)=>handlers.set(channel,handler),publish:()=>{}},backend,contacts);
 const bridge=createMessageMediaBridge({invoke:(channel,...args)=>handlers.get(channel)(...args),on:()=>{},removeListener:()=>{}});
 const preview=await bridge.openHistoryImagePreview({...selection,fileId,mimeType:'image/png'});
 assert.equal(preview.sessionId,sessionId);assert.deepEqual(calls,[{contactId,messageId,fileId,connectionGeneration:1}]);
 await assert.rejects(async()=>bridge.openHistoryImagePreview({...selection,fileId,mimeType:'image/svg+xml'}));
 await assert.rejects(async()=>bridge.openHistoryImagePreview({...selection,fileId,mimeType:'image/png',ownerId:'other'}));
 assert.equal(calls.length,1);
});
test('预览桥拒绝批量和任意字段，释放入口只接受会话编号',async()=>{
 const handlers=new Map(),sessionId='00000000-0000-4000-8000-000000000021',fileId='00000000-0000-4000-8000-000000000022';let calls=0;
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},releaseUnhandedMediaPreviews:async()=>{},
  openMediaPreview:async()=>{calls++;return {generation:1,data:{sessionId,mimeType:'image/png',dataBase64:'iVBORw0KGgo='},connection:{status:async()=>'active',release:async()=>{}}};}};
 const contacts={getState:()=>({selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]}),onStateChanged:()=>()=>{}};
 installMessageMediaBridge({handle:(channel,handler,role)=>{assert.deepEqual(role,['manager','helper']);handlers.set(channel,handler);},publish:()=>{}},backend,contacts);
 const bridge=createMessageMediaBridge({invoke:(channel,...args)=>handlers.get(channel)(...args),on:()=>{},removeListener:()=>{}});
 const valid={...selection,fileId,mimeType:'image/png'};
 for(const invalid of [[valid],{...valid,sourceId:messageId},{...valid,path:'/etc/passwd'},{...valid,messageId:'../message'},{...valid,scopeRevision:1.5}])await assert.rejects(async()=>bridge.openHistoryImagePreview(invalid));
 await assert.rejects(async()=>bridge.openHistoryImagePreview(valid,valid));await assert.rejects(async()=>bridge.releasePreview('../session'));
 assert.equal(calls,0);
});
