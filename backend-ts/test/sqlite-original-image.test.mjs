import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './media-support.mjs';
import {resourcePort,png} from './visual-media-support.mjs';
import {OriginalImageMediaAdapter} from '../src/media/visual/original-image.ts';

test('同步图片适配器在读取字节前拒绝缩略图及未知质量，不开放视频',async t=>{
 const options={afterChunk:()=>assert.fail('非原图不能读取字节')};
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 for(const quality of [{kind:'thumbnail',proof:'synthetic-thumbnail'},{kind:'unknown',proof:null}]){
  options.quality=quality;
  await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_original_unavailable'});
 }
 assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
 assert.equal((await readdir(join(f.root,'managed/media'))).length,0);
 const video=f.messages.find(m=>m.kind==='video');assert.equal((await f.media.read(f.contact,video.id)).capabilities.extract,false);
});

test('原图经实际解码保存，预览读取副本并保留来源',async t=>{
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort({quality:{kind:'original',proof:'synthetic-original'}}))),image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.files[0].imageQuality,'original');assert.equal(saved.latestAttempt.outcome,'full');
 const preview=await f.media.openPreview(f.contact,image.id,saved.files[0].fileId);assert.deepEqual(Buffer.from(preview.dataBase64,'base64'),png);
 await f.media.releasePreview(preview.sessionId);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
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
