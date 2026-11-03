import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './media-support.mjs';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {SqliteImageSyncCoordinator} from '../src/media/sqlite/image-sync.ts';

const bytes=Buffer.from('合成原图文件');
function originalAdapter(onRead=()=>{}){
 return {version:'synthetic-original-v1',supports:(kind,goal)=>kind==='image'&&(goal==='extract'||goal==='original_upgrade'),async execute(context){
  onRead();await context.checkpoint();
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),
   bytes:(async function*(){yield bytes;})(),validate:async path=>{assert.deepEqual(await readFile(path),bytes);return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:'original',qualityProof:'synthetic-original-proof'};}});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-original-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-original'}};
 }};
}

function unknownQualityAdapter(onRead=()=>{}){
 return {version:'synthetic-current-image-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',async execute(context){
  onRead();await context.checkpoint();
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),
   bytes:(async function*(){yield bytes;})(),validate:async path=>{assert.deepEqual(await readFile(path),bytes);return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:'unknown',qualityProof:null};}});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-current-image-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-current-image'}};
 }};
}

function resourceVariantAdapter(variant,onRead=()=>{}){
 return {version:'synthetic-resource-variant-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',async execute(context){
  onRead();await context.checkpoint();const sourceVariant=variant(),quality=sourceVariant==='thumbnail'?'thumbnail':'unknown';
  const content=Buffer.from(sourceVariant==='thumbnail'?'合成缩略图':'合成主图'),digest=createHash('sha256').update(content).digest('hex');
  await context.save({role:'image_display',expectedBytes:content.length,expectedSha256:digest,bytes:(async function*(){yield content;})(),
   validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:quality,qualityProof:null,
    imageQualityEvidence:{protocol:'wechat-image-quality-v1',quality,sourceVariant,resourceInfoId:'10',resources:[{resourceId:'20',resourceTypeRaw:262145}],sourceSha256:digest,contentSha256:digest,originalProofDigest:null}})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-resource-variant-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-resource'}};
 }};
}

test('已保存缩略图在后续自动复查取得主图后更新，主图不继续轮询',async t=>{
 let variant='thumbnail',reads=0;const f=await fixture(t,resourceVariantAdapter(()=>variant,()=>reads++));
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),thumbnail=await f.media.read(f.contact,image.id);
 assert.equal(thumbnail.files[0].imageQuality,'thumbnail');assert.equal(reads,1);
 variant='main';t.mock.timers.tick(60_000);await sync.waitForIdle();
 const main=await f.media.read(f.contact,image.id);
 assert.equal(reads,2);assert.equal(main.files[0].imageQuality,'unknown');assert.notEqual(main.files[0].fileId,thumbnail.files[0].fileId);
 t.mock.timers.tick(60_000);await sync.waitForIdle();assert.equal(reads,2);
});

test('复查仍是缩略图或读取失败时保留原副本，同一时间窗不重复读取',async t=>{
 let reads=0,failed=false;const adapter=resourceVariantAdapter(()=> 'thumbnail',()=>reads++),execute=adapter.execute;
 adapter.execute=async context=>{if(failed){reads++;throw new StorageFailure('media_local_file_missing');}return execute(context);};
 const f=await fixture(t,adapter);t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();const image=f.messages.find(m=>m.kind==='image');
 const saved=(await f.media.read(f.contact,image.id)).files[0];
 t.mock.timers.tick(60_000);await sync.waitForIdle();assert.equal(reads,2);
 assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,saved.fileId);
 sync.wake();await sync.waitForIdle();assert.equal(reads,2);
 failed=true;t.mock.timers.tick(60_000);await sync.waitForIdle();
 const failure=await f.media.read(f.contact,image.id);assert.equal(reads,3);assert.equal(failure.latestAttempt.state,'failed');assert.equal(failure.files[0].fileId,saved.fileId);
 sync.wake();await sync.waitForIdle();assert.equal(reads,3);
 assert.equal((await readdir(join(f.root,'managed','media'))).length,1);
});

test('协调器重建后复用同一时间窗回执，下一时间窗仍会复查缩略图',async t=>{
 let reads=0;const f=await fixture(t,resourceVariantAdapter(()=> 'thumbnail',()=>reads++));t.mock.timers.enable({apis:['setTimeout','Date']});
 const first=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>first.close());
 first.wake();await first.waitForIdle();t.mock.timers.tick(60_000);await first.waitForIdle();assert.equal(reads,2);await first.close();
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();assert.equal(reads,2);
 t.mock.timers.tick(60_000);await next.waitForIdle();assert.equal(reads,3);
});

test('关闭读取和退出会停止缩略图复查，清除后不自动恢复',async t=>{
 let reads=0;const f=await fixture(t,resourceVariantAdapter(()=> 'thumbnail',()=>reads++));t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 await f.contacts.setReading(false);await sync.stop();t.mock.timers.tick(120_000);await sync.waitForIdle();assert.equal(reads,1);
 await f.contacts.setReading(true);sync.wake();await sync.waitForIdle();assert.equal(reads,2);
 const image=f.messages.find(m=>m.kind==='image');await f.media.clear(f.contact,image.id,'clear-refreshed-thumbnail');
 t.mock.timers.tick(120_000);await sync.waitForIdle();sync.wake();await sync.waitForIdle();assert.equal(reads,2);
 assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
 await sync.close();t.mock.timers.tick(120_000);assert.equal(reads,2);
});

test('自动图片同步以普通提取保存unknown文件，重复唤醒和清除后不重取',async t=>{
 let reads=0;const f=await fixture(t,unknownQualityAdapter(()=>reads++));
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),saved=await f.media.read(f.contact,image.id);
 assert.equal(reads,1);assert.equal(saved.latestAttempt.outcome,'full');assert.equal(saved.files[0].imageQuality,'unknown');
 sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,1);
 await f.media.clear(f.contact,image.id,'clear-unknown-image');sync.wake(f.contact);await sync.waitForIdle();
 assert.equal(reads,1);assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
});

test('v5自动同步为旧v3与v4失败补一轮，成功或清除后不重取',async t=>{
 let reads=0;const adapter=unknownQualityAdapter(()=>reads++),extract=adapter.execute;
 adapter.supports=(kind,goal)=>kind==='image'&&(goal==='extract'||goal==='original_upgrade');
 adapter.execute=async context=>{if(context.goal==='original_upgrade'){reads++;throw new StorageFailure('media_original_unavailable');}return extract(context);};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 for(const oldVersion of ['v3','v4']){
  await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:`image_sync_${oldVersion}_${image.id}_0`,goal:'original_upgrade'}),{code:'media_original_unavailable'});
 }
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const current=await f.media.read(f.contact,image.id);
 assert.equal(reads,3);assert.equal(current.files.length,1);assert.equal(current.files[0].imageQuality,'unknown');
 const newKey=`image_sync_v5_${image.id}_0`;
 const savedAttempt=await f.storage.execute('media.request',{ownerId:f.owner,contactId:f.contact,messageId:image.id,requestKey:newKey,goal:'extract'});
 assert.equal(savedAttempt.state,'completed');
 sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,3);
 await f.media.clear(f.contact,image.id,'clear-v5-image');sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,3);
});

test('已授权图片随同步保存原图，重复唤醒复用副本且不依赖记忆任务',async t=>{
 let reads=0;const f=await fixture(t,originalAdapter(()=>reads++));
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),saved=await f.media.read(f.contact,image.id);
 assert.equal(saved.files.length,1);assert.equal(saved.files[0].imageQuality,'original');assert.equal(reads,1);
 sync.wake(f.contact);await sync.waitForIdle();
 assert.equal(reads,1);assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,saved.files[0].fileId);
 assert.equal((await f.history.read(f.contact)).messages.length,4);
});

test('历史页接受后自动唤醒原图保存，无需调用协调器唤醒入口',async t=>{
 let sync,reads=0;
 const f=await fixture(t,originalAdapter(()=>reads++),{onAcceptedPage:contactId=>sync?.wake(contactId)});
 sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 await f.history.synchronize(f.contact);await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),saved=await f.media.read(f.contact,image.id);
 assert.equal(reads,1);assert.equal(saved.files[0].imageQuality,'original');
});

test('原图不可取得只保存失败记录，后续同步不反复取图',async t=>{
 let reads=0;const adapter=originalAdapter();adapter.execute=async()=>{reads++;throw new StorageFailure('media_original_unavailable');};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const missing=await f.media.read(f.contact,image.id);
 assert.deepEqual(missing.files,[]);assert.equal(missing.latestAttempt.errorCode,'media_original_unavailable');
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 assert.equal((await f.history.read(f.contact)).messages.find(m=>m.id===image.id).kind,'image');
 assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
});

test('解码修复后旧版误判可重试一次，后续唤醒仍去重且清除不恢复',async t=>{
 let reads=0,legacy=true;const adapter=originalAdapter(),execute=adapter.execute;
 adapter.execute=async context=>{reads++;if(legacy)throw new StorageFailure('media_original_unavailable');return execute(context);};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:`image_sync_${image.id}_0`,goal:'original_upgrade'}).catch(error=>{assert.equal(error.code,'media_original_unavailable');});
 assert.equal((await f.media.read(f.contact,image.id)).latestAttempt.errorCode,'media_original_unavailable');
 legacy=false;const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal((await f.media.read(f.contact,image.id)).files.length,1);assert.equal(reads,2);
 sync.wake();await sync.waitForIdle();assert.equal(reads,2);
 await f.media.clear(f.contact,image.id,'clear-after-decoding-fix');sync.wake();await sync.waitForIdle();assert.equal(reads,2);
});

test('同步适配器返回缩略图也保存为可查看文件并保留质量标记',async t=>{
 let reads=0;
 const adapter=originalAdapter();const original=adapter.execute;
 adapter.execute=context=>{reads++;return original({...context,save:input=>context.save({...input,validate:async path=>({...await input.validate(path),imageQuality:'thumbnail',qualityProof:'synthetic-thumbnail-proof'})})});};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const result=await f.media.read(f.contact,image.id);assert.equal(result.files.length,1);
 assert.equal(result.files[0].imageQuality,'thumbnail');assert.equal(result.latestAttempt.outcome,'full');
 sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,1);
});

test('关闭读取不取图，开启后保存且清除图片后普通同步不恢复',async t=>{
 let reads=0;const f=await fixture(t,originalAdapter(()=>reads++)),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 await f.contacts.setReading(false);sync.wake();await sync.waitForIdle();assert.equal(reads,0);
 await f.contacts.setReading(true);sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 const cleared=await f.media.clear(f.contact,image.id,'clear-image-sync');assert.equal(cleared.state,'cleared');
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();assert.equal(reads,1);
});

test('停读取消正在读取的原图并排空，旧消息唤醒不能重新派发',async t=>{
 const started=Promise.withResolvers();let reads=0;const adapter=originalAdapter();
 adapter.execute=async context=>{reads++;started.resolve();await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));await context.checkpoint();throw new Error('取消后不能到达');};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake(f.contact);await started.promise;await f.contacts.setReading(false);await sync.stop();
 sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,1);
 const result=await f.media.read(f.contact,image.id);assert.deepEqual(result.files,[]);assert.equal(result.latestAttempt.state,'interrupted');
});
