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
