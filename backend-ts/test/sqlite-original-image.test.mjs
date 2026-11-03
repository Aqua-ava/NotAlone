import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
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

test('微信图片分类依据经过视觉适配器完整保存，聊天投影只公开类别',async t=>{
 const digest=createHash('sha256').update(png).digest('hex');
 const evidence={protocol:'wechat-image-quality-v1',quality:'thumbnail',sourceVariant:'thumbnail',resourceInfoId:'9',
  resources:[{resourceId:'10',resourceTypeRaw:65537}],sourceSha256:digest,contentSha256:digest,originalProofDigest:null};
 const f=await fixture(t,new OriginalImageMediaAdapter(resourcePort({quality:{kind:'thumbnail',proof:null,evidence}})));
 const image=f.messages.find(m=>m.kind==='image');
 const saved=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(saved.files[0].imageQuality,'thumbnail');
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{const row=db.prepare('SELECT image_quality_evidence FROM media_file WHERE id=?').get(saved.files[0].fileId);
  assert.deepEqual(JSON.parse(row.image_quality_evidence),evidence);
 }finally{db.close();}
 const projected=(await f.history.imageMedia(f.contact,[image.id])).get(image.id);
 assert.equal(projected.imageQuality,'thumbnail');
 assert.equal(JSON.stringify(projected).includes('resourceInfoId'),false);
});

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
 assert.deepEqual(projected.image_media,{state:'available',file_id:saved.files[0].fileId,mime_type:'image/png',image_quality:'unknown',image_variant:'unknown'});
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
