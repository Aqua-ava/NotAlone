import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageMediaController } from '../src/main/media/controller.ts';
const contactId='00000000-0000-4000-8000-000000000001',messageId='00000000-0000-4000-8000-000000000002';
const selection={contactId,messageId,scopeRevision:1};
const fileId='00000000-0000-4000-8000-000000000031',sessionId='00000000-0000-4000-8000-000000000005';
function fixture(connection) {
 const listeners=[];let current={selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]};
 let next=0;
 const backend={getConnectionGeneration:()=>1,onStateChanged:listener=>{listeners.push(listener);return()=>{};},releaseUnhandedMediaPreviews:async()=>{},
  captureMediaPreviewConnection:()=>connection,
  openMediaPreview:async input=>({generation:1,data:{sessionId:sessionId.slice(0,-1)+String(++next),mimeType:'image/png',dataBase64:'iVBORw0KGgo='},connection})};
 const contacts={getState:()=>current,onStateChanged:listener=>{listeners.push(listener);return()=>{};}};
 return {controller:new MessageMediaController(backend,contacts),backend,changeContact(value){current=value;for(const listener of listeners)listener();}};
}
const open=(f,id=messageId)=>f.controller.openHistoryImagePreview({...selection,messageId:id,fileId,mimeType:'image/png'});
test('聊天图片可并行预览，联系人变更时共同撤下',async()=>{
 const revoked=[],f=fixture({status:async()=>'active',release:async()=>{}});
 f.controller.onPreviewRevoking(id=>revoked.push(id));
 const a=await open(f),b=await open(f,'00000000-0000-4000-8000-000000000022');
 assert.equal(revoked.length,0);
 f.changeContact({selectedContactId:null,scopeRevision:2,directoryPhase:'ready',contacts:[]});
 assert.deepEqual(new Set(revoked),new Set([a.sessionId,b.sessionId]));
 await f.controller.releasePreview(a.sessionId);await f.controller.releasePreview(b.sessionId);
});
test('失效时尚未完成的预览会在返回页面前释放',async()=>{
 let releaseCount=0,resolveOpen;const pending=new Promise(resolve=>{resolveOpen=resolve;});
 const f=fixture({status:async()=>'active',release:async()=>{releaseCount++;}});
 f.backend.openMediaPreview=async()=>({generation:1,data:await pending,connection:{status:async()=>'active',release:async()=>{releaseCount++;}}});
 const opening=open(f);f.controller.invalidate();
 resolveOpen({sessionId,mimeType:'image/png',dataBase64:'iVBORw0KGgo='});
 await assert.rejects(opening,/范围已变化/);
 assert.equal(releaseCount,1);
});
test('预览失效先通知撤下，只有页面确认才释放原holder',async()=>{
 let releaseCount=0,revoked;
 const f=fixture({status:async()=>'revoking',release:async()=>{releaseCount++;}});
 f.controller.onPreviewRevoking(id=>{revoked=id;});const preview=await open(f);
 f.controller.invalidate();assert.equal(revoked,preview.sessionId);assert.equal(releaseCount,0);
 await f.controller.releasePreview(preview.sessionId);assert.equal(releaseCount,1);
});
test('播放引用释放失败保留原确认，排空时重试同session',async()=>{
 let releaseCount=0;
 const f=fixture({status:async()=>'active',release:async()=>{if(++releaseCount===1)throw new Error('synthetic_disconnect');}});
 const preview=await open(f);
 await assert.rejects(f.controller.releasePreview(preview.sessionId));assert.equal(releaseCount,1);
 await f.controller.invalidateAndDrain();assert.equal(releaseCount,2);
});
test('关闭协调先撤下预览并等待页面确认，不用close回调冒充释放',async()=>{
 let releaseCount=0,revoked=false;
 const f=fixture({status:async()=>'active',release:async()=>{releaseCount++;}});
 f.controller.onPreviewRevoking(()=>{revoked=true;});const preview=await open(f);
 let settled=false;const closing=f.controller.prepareClosing().then(()=>{settled=true;});await Promise.resolve();assert.equal(revoked,true);assert.equal(releaseCount,0);assert.equal(settled,false);
 await assert.rejects(open(f));await f.controller.releasePreview(preview.sessionId);await closing;assert.equal(releaseCount,1);assert.equal(settled,true);
});
