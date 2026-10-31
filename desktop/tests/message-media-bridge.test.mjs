import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundled=await build({stdin:{contents:"export { installMessageMediaBridge } from './src/main/media/bridge';export { createMessageMediaBridge } from './src/preload/media';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {installMessageMediaBridge,createMessageMediaBridge}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const contactId='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002',selection={contactId,messageId,scopeRevision:1};
test('具名桌面桥拒绝批量和任意字段，只向已选联系人单消息路由传递业务请求',async()=>{
 const handlers=new Map(),calls=[],events=new Map();
 const backend={releaseUnhandedMediaPreviews:async()=>{},getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},requestJson:async input=>{calls.push(input);return {generation:1,data:{contactId,messageId,kind:'voice',state:'available',generation:'0',headRevision:'0',latestAttempt:null,files:[],capabilities:{extract:false,originalUpgrade:false,audioConversion:false,reason:'media_adapter_unavailable'},cleanup:null}};}};
 const contacts={getState:()=>({selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]}),onStateChanged:()=>()=>{}};
 installMessageMediaBridge({handle:(channel,handler,role)=>{assert.deepEqual(role,['manager','helper']);handlers.set(channel,handler);},publish:(channel,state)=>events.get(channel)?.({},state)},backend,contacts);
 const transport={invoke:async(channel,...args)=>handlers.get(channel)(...args),on:(channel,listener)=>events.set(channel,listener),removeListener:channel=>events.delete(channel)};
 const bridge=createMessageMediaBridge(transport);await bridge.inspect(selection);assert.equal((await bridge.getState()).snapshot.kind,'voice');
 assert.equal(calls[0].path,`/api/contacts/${contactId}/messages/${messageId}/media`);
 for(const invalid of [[selection],{...selection,ownerId:'other'},{...selection,sourceId:messageId},{...selection,path:'/etc/passwd'},{...selection,messageId:'../message'},{...selection,scopeRevision:1.5}])await assert.rejects(bridge.inspect(invalid));
 await assert.rejects(bridge.inspect(selection,selection));await assert.rejects(bridge.extract({...selection,goal:'batch'}));await assert.rejects(bridge.releasePreview('../session'));
 assert.equal(calls.length,1);
});

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
