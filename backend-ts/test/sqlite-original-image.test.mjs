import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {fixture} from './media-support.mjs';
import {resourcePort,png} from './visual-media-support.mjs';
import {OriginalImageMediaAdapter} from '../src/media/visual/original-image.ts';
import {SqliteHistoryHttp} from '../src/history/sqlite/http.ts';

test('手动取图先核验来源，失败时保留已有文件且不创建提取尝试',async t=>{
 let rejectSource=false,checks=0;
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort()),{ensureSourceReady:async()=>{
  checks++;if(rejectSource)throw Object.assign(new Error('synthetic source blocked'),{code:'history_source_not_available'});
 }});
 const image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 rejectSource=true;
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'history_source_not_available'});
 assert.equal(checks,2);
 const after=await f.media.read(f.contact,image.id);
 assert.deepEqual(after.files,saved.files);assert.equal(after.latestAttempt.attemptId,saved.latestAttempt.attemptId);
});

test('重启后手动复核已存图片，在预览引用校验前重建来源守卫',async t=>{
 let ready=true;
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort()),{ensureSourceReady:async()=>{ready=true;}});
 const image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 ready=false;
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=(action,input)=>{
  if((action==='media.read'||action==='media.file')&&!ready)throw Object.assign(new Error('synthetic lost guard'),{code:'history_source_not_available'});
  return execute(action,input);
 };
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.latestAttempt.state,'completed');assert.equal(saved.files.length,1);
});

test('资源端口仅有缩略图时不保存任何文件，聊天投影为仅缩略图，取得标准图后保存',async t=>{
 const options={thumbnailOnly:true};let closed=0;options.closed=()=>closed++;
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort(options)));
 const image=f.messages.find(m=>m.kind==='image');
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_thumbnail_only'});
 const state=await f.media.read(f.contact,image.id);
 assert.deepEqual(state.files,[]);assert.equal(state.latestAttempt.state,'failed');assert.equal(state.latestAttempt.errorCode,'media_thumbnail_only');assert.equal(closed,1);
 assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
 assert.deepEqual((await f.history.imageMedia(f.contact,[image.id])).get(image.id),{state:'thumbnail_only',fileId:null,mimeType:null,errorCode:'media_thumbnail_only'});
 options.thumbnailOnly=false;
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.files.length,1);assert.equal(saved.files[0].viewable,true);assert.equal(saved.latestAttempt.outcome,'full');
 assert.deepEqual((await f.history.imageMedia(f.contact,[image.id])).get(image.id),{state:'available',fileId:saved.files[0].fileId,mimeType:'image/png'});
});

test('图片适配器只支持普通提取，保存的标准图可实际预览，图片行不写分类列',async t=>{
 const adapter=new OriginalImageMediaAdapter(resourcePort());
 assert.equal(adapter.supports('image','extract'),true);
 assert.equal(adapter.supports('image','original_upgrade'),false);
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.files.length,1);assert.equal(saved.files[0].viewable,true);assert.equal(saved.latestAttempt.outcome,'full');
 assert.equal('imageQuality' in saved.files[0],false);assert.equal('originalUpgrade' in saved.capabilities,false);
 const preview=await f.media.openPreview(f.contact,image.id,saved.files[0].fileId);
 assert.deepEqual(Buffer.from(preview.dataBase64,'base64'),png);
 await f.media.releasePreview(preview.sessionId);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{assert.deepEqual({...db.prepare('SELECT image_quality,quality_proof,image_quality_evidence FROM media_file WHERE id=?').get(saved.files[0].fileId)},{image_quality:'unknown',quality_proof:null,image_quality_evidence:null});}finally{db.close();}
 const video=f.messages.find(m=>m.kind==='video');assert.equal((await f.media.read(f.contact,video.id)).capabilities.extract,false);
});

test('聊天专用HTTP把已保存图片投影为available文件，不带版本标签',async t=>{
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort()));
 const image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 const http=new SqliteHistoryHttp(f.history);
 const req=Object.assign(new EventEmitter(),{method:'GET',url:`/api/contacts/${f.contact}/history-messages?limit=20`});
 let status,body;const res={writeHead:code=>{status=code;},end:value=>{body=JSON.parse(value);}};
 assert.equal(await http.handle(req,res),true);assert.equal(status,200);
 const projected=body.messages.find(item=>item.message_id===image.id);
 assert.deepEqual(projected.image_media,{state:'available',file_id:saved.files[0].fileId,mime_type:'image/png'});
 assert.equal(projected.message_type,'image');assert.equal(projected.text,null);assert.equal(projected.media_placeholder,'[图片]');
});

test('图片保存和清除通过同条消息更新通知聊天占位',async t=>{
 const updates=[];
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort()),{onMediaChanged:(contactId,messageId)=>updates.push({contactId,messageId})});
 const image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.deepEqual(updates,[{contactId:f.contact,messageId:image.id}]);
 await f.media.clear(f.contact,image.id,randomUUID());
 assert.deepEqual(updates,[{contactId:f.contact,messageId:image.id},{contactId:f.contact,messageId:image.id}]);
});
