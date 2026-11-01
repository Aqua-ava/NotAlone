import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fixture} from './media-support.mjs';
import {resourcePort,png} from './visual-media-support.mjs';
import {OriginalImageMediaAdapter} from '../src/media/visual/original-image.ts';
import {SqliteHistoryHttp} from '../src/history/sqlite/http.ts';

test('新图片适配器按普通提取保存未知或缩略图质量的可查看文件',async t=>{
 const options={quality:{kind:'unknown',proof:null}};
 const adapter=new OriginalImageMediaAdapter(resourcePort(options));
 assert.equal(adapter.supports('image','extract'),true);
 assert.equal(adapter.supports('image','original_upgrade'),false);
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 for(const {quality,imageQuality} of [
  {quality:{kind:'unknown',proof:null},imageQuality:'unknown'},
  {quality:{kind:'thumbnail',proof:null},imageQuality:'thumbnail'},
  {quality:{kind:'original',proof:null},imageQuality:'unknown'},
 ]){
  options.quality=quality;
  const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
  assert.equal(saved.files.length,1);
  assert.equal(saved.files[0].imageQuality,imageQuality);
  assert.equal(saved.files[0].viewable,true);
  assert.equal(saved.latestAttempt.outcome,'full');
  assert.equal(saved.capabilities.originalUpgrade,false);
  const preview=await f.media.openPreview(f.contact,image.id,saved.files[0].fileId);
  assert.deepEqual(Buffer.from(preview.dataBase64,'base64'),png);
  await f.media.releasePreview(preview.sessionId);
 }
 const video=f.messages.find(m=>m.kind==='video');assert.equal((await f.media.read(f.contact,video.id)).capabilities.extract,false);
});

test('原图经实际解码保存，预览读取副本并保留来源',async t=>{
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort({quality:{kind:'original',proof:'synthetic-original'}}))),image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.files[0].imageQuality,'original');assert.equal(saved.latestAttempt.outcome,'full');
 const preview=await f.media.openPreview(f.contact,image.id,saved.files[0].fileId);assert.deepEqual(Buffer.from(preview.dataBase64,'base64'),png);
 await f.media.releasePreview(preview.sessionId);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('聊天专用HTTP把unknown质量的已保存图片投影为available文件',async t=>{
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort({quality:{kind:'unknown',proof:null}})));
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

test('缺少原图质量证明时仍保存有效文件并准确降为unknown',async t=>{
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort({quality:{kind:'original',proof:null}})));
 const image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.files[0].imageQuality,'unknown');assert.equal(saved.latestAttempt.outcome,'full');
});


test('原图保存和清除通过同条消息更新通知聊天占位',async t=>{
 const updates=[];
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort({quality:{kind:'original',proof:'synthetic-original'}})),{onMediaChanged:(contactId,messageId)=>updates.push({contactId,messageId})});
 const image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.deepEqual(updates,[{contactId:f.contact,messageId:image.id}]);
 await f.media.clear(f.contact,image.id,randomUUID());
 assert.deepEqual(updates,[{contactId:f.contact,messageId:image.id},{contactId:f.contact,messageId:image.id}]);
});
