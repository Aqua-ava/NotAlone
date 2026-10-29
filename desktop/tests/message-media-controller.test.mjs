import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageMediaController } from '../src/main/media/controller.ts';
const contactId='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002';
const selection={contactId,messageId,scopeRevision:1};
const snapshot=changes=>({contactId,messageId,kind:'image',state:'active',generation:'0',headRevision:'1',latestAttempt:null,files:[],capabilities:{extract:false,originalUpgrade:false,audioConversion:false,reason:'media_adapter_unavailable'},cleanup:null,...changes});
function fixture(request) {
 const calls=[],listeners=[];let current={selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]};
 const backend={getConnectionGeneration:()=>1,onStateChanged:listener=>{listeners.push(listener);return()=>{};},releaseUnhandedMediaPreviews:async()=>{},requestJson:async input=>{calls.push(input);return {generation:1,data:await request(input)};},
  openMediaPreview:async input=>({...await backend.requestJson({method:'POST',path:`/api/contacts/${input.contactId}/messages/${input.messageId}/media/files/${input.fileId}/preview`,body:{}}),connection:backend.captureMediaPreviewConnection()})};
 const contacts={getState:()=>current,onStateChanged:listener=>{listeners.push(listener);return()=>{};}};
 const controller=new MessageMediaController(backend,contacts);
 return {controller,backend,calls,changeContact(next){current=next;for(const listener of listeners)listener();}};
}
test('明确选定一条消息只读状态，未接线类型不触发提取',async()=>{
 const f=fixture(()=>snapshot());await f.controller.inspect(selection);
 assert.equal(f.controller.getState().snapshot.capabilities.extract,false);
 assert.deepEqual(f.calls.map(c=>[c.method,c.path]),[['GET',`/api/contacts/${contactId}/messages/${messageId}/media`]]);
 await assert.rejects(f.controller.extract({...selection,goal:'extract'}));assert.equal(f.calls.length,1);
 await assert.rejects(f.controller.inspect({...selection,contactId:'00000000-0000-4000-8000-000000000003'}));
});
test('读取失败撤下旧快照，切换联系人后的迟到结果不得重新展示',async()=>{
 let fail=false,resolveRead;
 const f=fixture(()=>{if(fail)throw new Error('source_unavailable');return snapshot();});await f.controller.inspect(selection);
 fail=true;await f.controller.inspect(selection);assert.equal(f.controller.getState().snapshot,null);
 assert.equal(f.controller.getState().phase,'failed');
 let entered;const ready=new Promise(resolve=>{entered=resolve;});
 const g=fixture(()=>new Promise(resolve=>{resolveRead=resolve;entered();}));const reading=g.controller.inspect(selection);await ready;
 g.changeContact({selectedContactId:null,scopeRevision:2,directoryPhase:'ready',contacts:[]});
 resolveRead(snapshot());await reading;assert.equal(g.controller.getState().snapshot,null);assert.equal(g.controller.getState().contactId,null);
});
test('结果未知只显式重查同一请求键，刷新不会重新执行',async()=>{
 let first=true;const f=fixture(input=>{if(input.method==='GET')return snapshot({capabilities:{extract:true,originalUpgrade:false,audioConversion:false,reason:null}});if(first){first=false;throw new Error('connection_lost');}return snapshot({latestAttempt:{attemptId:messageId,state:'failed',outcome:'no_result',errorCode:'media_copy_failed'}});});
 await f.controller.inspect(selection);await f.controller.extract({...selection,goal:'extract'});assert.equal(f.controller.getState().retryGoal,'extract');
 const original=f.calls[1].body.request_key;await f.controller.inspect(selection);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 await f.controller.retry(selection);assert.equal(f.calls[3].body.request_key,original);assert.equal(f.controller.getState().snapshot.latestAttempt.state,'failed');
});
test('进行中提取可以被明确清除，晚到结果不能恢复本地快照',async()=>{
 let resolveExtract;const f=fixture(input=>{if(input.method==='POST')return new Promise(resolve=>{resolveExtract=resolve;});return input.method==='DELETE'?snapshot({state:'cleared',cleanup:{operationId:messageId,state:'completed'}}):snapshot({capabilities:{extract:true,originalUpgrade:false,audioConversion:false,reason:null}});});
 await f.controller.inspect(selection);const extracting=f.controller.extract({...selection,goal:'extract'});assert.equal(f.controller.getState().busy,'extract');
 await f.controller.clear(selection);assert.equal(f.controller.getState().snapshot.state,'cleared');
 resolveExtract(snapshot({state:'active'}));await extracting;assert.equal(f.controller.getState().snapshot.state,'cleared');
 assert.match(f.calls.find(c=>c.method==='DELETE').idempotencyKey,/^[a-f0-9-]{36}$/);
});
test('预览失效先通知撤下，只有页面确认才释放原holder',async()=>{
 let releaseCount=0,revoked;const sessionId='00000000-0000-4000-8000-000000000005';
 const f=fixture(input=>input.method==='GET'?snapshot({files:[{fileId:messageId,role:'image_display',imageQuality:'thumbnail',format:'png',mimeType:'image/png',byteSize:'1',viewable:true,playable:false}]}):{sessionId,mimeType:'image/png',dataBase64:'AA=='});
 f.backend.captureMediaPreviewConnection=()=>({status:async()=> 'revoking',release:async()=>{releaseCount++;}});
 f.controller.onPreviewRevoking(id=>{revoked=id;});await f.controller.inspect(selection);await f.controller.openPreview({...selection,fileId:messageId});
 f.controller.invalidate();assert.equal(revoked,sessionId);assert.equal(releaseCount,0);assert.equal(f.controller.getState().snapshot,null);
 await f.controller.releasePreview(sessionId);assert.equal(releaseCount,1);
});
test('播放引用释放失败保留原确认，显式刷新重试同session而不提取',async()=>{
 const sessionId='00000000-0000-4000-8000-000000000005';let releaseCount=0;
 const f=fixture(input=>input.method==='GET'?snapshot({files:[{fileId:messageId,role:'image_display',imageQuality:'thumbnail',format:'png',mimeType:'image/png',byteSize:'1',viewable:true,playable:false}]}):{sessionId,mimeType:'image/png',dataBase64:'AA=='});
 f.backend.captureMediaPreviewConnection=()=>({status:async()=> 'active',release:async()=>{if(++releaseCount===1)throw new Error('synthetic_disconnect');}});
 await f.controller.inspect(selection);await f.controller.openPreview({...selection,fileId:messageId});
 await assert.rejects(f.controller.releasePreview(sessionId));assert.equal(releaseCount,1);
 await f.controller.inspect(selection);assert.equal(releaseCount,2);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('关闭协调先撤下预览并等待页面确认，不用close回调冒充释放',async()=>{
 const sessionId='00000000-0000-4000-8000-000000000005';let releaseCount=0,revoked=false;
 const f=fixture(input=>input.method==='GET'?snapshot({files:[{fileId:messageId,role:'image_display',imageQuality:'thumbnail',format:'png',mimeType:'image/png',byteSize:'1',viewable:true,playable:false}]}):{sessionId,mimeType:'image/png',dataBase64:'AA=='});
 f.backend.captureMediaPreviewConnection=()=>({status:async()=> 'active',release:async()=>{releaseCount++;}});
 f.controller.onPreviewRevoking(()=>{revoked=true;});await f.controller.inspect(selection);await f.controller.openPreview({...selection,fileId:messageId});
 let settled=false;const closing=f.controller.prepareClosing().then(()=>{settled=true;});await Promise.resolve();assert.equal(revoked,true);assert.equal(releaseCount,0);assert.equal(settled,false);
 await assert.rejects(f.controller.inspect(selection));await f.controller.releasePreview(sessionId);await closing;assert.equal(releaseCount,1);assert.equal(settled,true);
});
