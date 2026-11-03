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

function resourceVariantAdapter(variant,onRead=()=>{},contentOf=sourceVariant=>Buffer.from(sourceVariant==='thumbnail'?'合成缩略图':'合成主图')){
 return {version:'synthetic-resource-variant-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',async execute(context){
  onRead();await context.checkpoint();const sourceVariant=variant(),quality=sourceVariant==='thumbnail'?'thumbnail':'unknown';
  const content=contentOf(sourceVariant),digest=createHash('sha256').update(content).digest('hex');
  await context.save({role:'image_display',expectedBytes:content.length,expectedSha256:digest,bytes:(async function*(){yield content;})(),
   validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:quality,qualityProof:null,
    imageQualityEvidence:{protocol:'wechat-image-quality-v1',quality,sourceVariant,resourceInfoId:'10',resources:[{resourceId:'20',resourceTypeRaw:262145}],sourceSha256:digest,contentSha256:digest,originalProofDigest:null}})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-resource-variant-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-resource'}};
 }};
}

test('全部授权联系人旧未知图片自动补查来源，取得主图后重启不重读',async t=>{
 let reads=0,known=false;const old=unknownQualityAdapter(()=>reads++),main=resourceVariantAdapter(()=> 'main',()=>reads++);
 const adapter={...old,execute:context=>(known?main:old).execute(context)};
 const f=await fixture(t,adapter),images=[];
 for(const binding of f.saved){
  if(binding.contact_id!==f.contact)await f.history.synchronize(binding.contact_id);
  const image=(await f.history.read(binding.contact_id)).messages.find(m=>m.kind==='image');
  await f.media.extract(binding.contact_id,image.id,{requestKey:`old-image-${image.id}`,goal:'extract'});
  images.push({contact:binding.contact_id,id:image.id});
 }
 assert.equal(reads,2);known=true;
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,4);
 for(const image of images)assert.equal((await f.media.read(image.contact,image.id)).files[0].imageQuality,'unknown');
 await sync.close();const restarted=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>restarted.close());
 restarted.wake();await restarted.waitForIdle();assert.equal(reads,4);
});

test('缺副本失败会持久退避并自动恢复，重复唤醒与重启不绕过等待',async t=>{
 let reads=0,missing=true;const adapter=resourceVariantAdapter(()=> 'main'),extract=adapter.execute;
 adapter.execute=async context=>{reads++;if(missing)throw new StorageFailure('media_local_file_missing');return extract(context);};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 t.mock.timers.tick(60_000);await sync.waitForIdle();assert.equal(reads,2);await sync.close();
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();assert.equal(reads,2);
 t.mock.timers.tick(299_999);await next.waitForIdle();assert.equal(reads,2);
 missing=false;t.mock.timers.tick(60_001);await next.waitForIdle();assert.equal(reads,3);
 assert.equal((await f.media.read(f.contact,image.id)).files.length,1);
 t.mock.timers.tick(86_400_000);await next.waitForIdle();assert.equal(reads,3);
});

test('连续失败逐级退避到每天重试，未到期唤醒不读图片',async t=>{
 let reads=0;const adapter=unknownQualityAdapter();adapter.execute=async()=>{reads++;throw new StorageFailure('media_local_file_missing');};
 const f=await fixture(t,adapter);t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 for(const delay of [60_000,300_000,1_800_000,21_600_000,86_400_000,86_400_000]){
  const before=reads;t.mock.timers.tick(delay-1);await sync.waitForIdle();sync.wake();await sync.waitForIdle();assert.equal(reads,before);
  t.mock.timers.tick(1);sync.wake();await sync.waitForIdle();assert.equal(reads,before+1);
 }
});

test('存量图片超过一页时处理全部消息，不因前页退避漏掉后页',async t=>{
 let reads=0;const f=await fixture(t,resourceVariantAdapter(()=> 'main',()=>reads++)),page=f.channel.page;
 f.channel.page=async()=>{const old=await page();return {...old,records:[...old.records,...Array.from({length:130},(_,i)=>({...old.records[0],localId:String(i+10)}))]};};
 await f.history.synchronize(f.contact);
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 assert.equal(reads,131);sync.wake();await sync.waitForIdle();assert.equal(reads,131);
});

test('自动取图在来源准备期间遇到清除时，旧未知、缩略图和缺副本均不恢复',{timeout:15000},async t=>{
 for(const variant of ['unknown','thumbnail','missing'])await t.test(variant,async t=>{
  let blocked=false,reads=0;const started=Promise.withResolvers(),release=Promise.withResolvers();
  const adapter=variant==='thumbnail'?resourceVariantAdapter(()=> 'thumbnail',()=>reads++):unknownQualityAdapter(()=>reads++);
  let initialMissing=variant==='missing';const execute=adapter.execute;adapter.execute=context=>{if(initialMissing){reads++;throw new StorageFailure('media_local_file_missing');}return execute(context);};
  const f=await fixture(t,adapter,{ensureSourceReady:async()=>{if(blocked){started.resolve();await release.promise;}}}),image=f.messages.find(m=>m.kind==='image');
  if(variant==='missing')await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:'race-legacy-image',goal:'extract'}),{code:'media_local_file_missing'});
  else await f.media.extract(f.contact,image.id,{requestKey:'race-legacy-image',goal:'extract'});
  initialMissing=false;
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()+60_000});
  const before=reads;blocked=true;const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await started.promise;
  try{await f.media.clear(f.contact,image.id,'clear-during-source-preparation');}finally{release.resolve();}await sync.waitForIdle();
  assert.equal(reads,before);const state=await f.media.read(f.contact,image.id);assert.equal(state.state,'cleared');assert.deepEqual(state.files,[]);
  sync.wake();await sync.waitForIdle();assert.equal(reads,before);
 });
});

test('来源准备失败按联系人持久退避，重启不反复核验，恢复后自动处理所有图片',{timeout:15000},async t=>{
 let prepares=0,unavailable=true,reads=0;const f=await fixture(t,resourceVariantAdapter(()=> 'main',()=>reads++),{ensureSourceReady:async()=>{prepares++;if(unavailable)throw new StorageFailure('history_support_unverified');}});
 const page=f.channel.page;f.channel.page=async()=>{const old=await page();return {...old,records:[...old.records,{...old.records[0],localId:'10'}]};};await f.history.synchronize(f.contact);
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();assert.equal(prepares,1);assert.equal(reads,0);
 sync.wake();await sync.waitForIdle();assert.equal(prepares,1);await sync.close();
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());next.wake();await next.waitForIdle();assert.equal(prepares,1);
 t.mock.timers.tick(60_000);await next.waitForIdle();assert.equal(prepares,2);assert.equal(next.status().last_failure_code,'history_support_unverified');
 unavailable=false;t.mock.timers.tick(300_000);await next.waitForIdle();assert.equal(reads,2);assert.equal(prepares,4);
 next.wake();await next.waitForIdle();assert.equal(prepares,4);
});

test('来源恢复后首张图片内容失败也解除联系人准备退避，其余图片立即自动处理',async t=>{
 let unavailable=true,firstImage,reads=0;const adapter=resourceVariantAdapter(()=> 'main'),execute=adapter.execute;
 adapter.execute=async context=>{reads++;if(context.messageId===firstImage)throw new StorageFailure('media_local_file_missing');return execute(context);};
 const f=await fixture(t,adapter,{ensureSourceReady:async()=>{if(unavailable)throw new StorageFailure('history_support_unverified');}});
 const page=f.channel.page;f.channel.page=async()=>{const old=await page();return {...old,records:[...old.records,{...old.records[0],localId:'10'}]};};await f.history.synchronize(f.contact);
 const images=(await f.history.read(f.contact)).messages.filter(m=>m.kind==='image');firstImage=f.messages.find(m=>m.kind==='image').id;
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();assert.equal(reads,0);
 unavailable=false;
 await assert.rejects(f.media.extract(f.contact,firstImage,{requestKey:`image_reconcile_v1_${firstImage}_0_${Math.floor(Date.now()/60_000)}`,goal:'extract'}),{code:'media_local_file_missing'});
 sync.wake();await sync.waitForIdle();
 assert.equal((await f.media.read(f.contact,images.find(m=>m.id!==firstImage).id)).files.length,1);assert.equal(reads,2);
});

test('来源准备回执不叠加单图失败退避，恢复后的图片失败按首轮一分钟自动重试',async t=>{
 let unavailable=true,missing=true,reads=0;const adapter=resourceVariantAdapter(()=> 'main'),execute=adapter.execute;
 adapter.execute=async context=>{reads++;if(missing)throw new StorageFailure('media_local_file_missing');return execute(context);};
 const f=await fixture(t,adapter,{ensureSourceReady:async()=>{if(unavailable)throw new StorageFailure('history_support_unverified');}}),image=f.messages.find(m=>m.kind==='image');
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();assert.equal(reads,0);
 unavailable=false;t.mock.timers.tick(60_000);await sync.waitForIdle();assert.equal(reads,1);await sync.close();
 const restarted=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>restarted.close());restarted.wake();await restarted.waitForIdle();assert.equal(reads,1);
 missing=false;t.mock.timers.tick(60_000);await restarted.waitForIdle();assert.equal(reads,2);assert.equal((await f.media.read(f.contact,image.id)).files.length,1);
});

test('来源准备抛普通错误也停止该联系人本批，不回显私密错误正文',async t=>{
 let prepares=0;const f=await fixture(t,unknownQualityAdapter(),{ensureSourceReady:async()=>{prepares++;throw new Error('synthetic-private-source-detail');}});
 const page=f.channel.page;f.channel.page=async()=>{const old=await page();return {...old,records:[...old.records,{...old.records[0],localId:'10'}]};};await f.history.synchronize(f.contact);
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 assert.equal(prepares,1);assert.equal(sync.status().last_failure_code,'media_execution_failed');sync.wake();await sync.waitForIdle();assert.equal(prepares,1);
});

test('旧未知图片补查无依据或失败保持原副本，清除后重启不恢复',async t=>{
 let reads=0,failed=false;const adapter=unknownQualityAdapter(()=>reads++),extract=adapter.execute;
 adapter.execute=async context=>{if(failed){reads++;throw new StorageFailure('media_local_file_missing');}return extract(context);};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:'legacy-unknown',goal:'extract'});const old=(await f.media.read(f.contact,image.id)).files[0];
 t.mock.timers.enable({apis:['setTimeout','Date']});const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,2);assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,old.fileId);
 failed=true;t.mock.timers.tick(60_000);await sync.waitForIdle();assert.equal(reads,3);
 assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,old.fileId);
 await f.media.clear(f.contact,image.id,'clear-reconcile-unknown');await sync.close();
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();t.mock.timers.tick(86_400_000);await next.waitForIdle();assert.equal(reads,3);
});

test('旧未知图片不会被不同内容缩略图替换，同内容缩略图可补分类',async t=>{
 let reads=0,thumbnail=false,same=false;const old=unknownQualityAdapter(()=>reads++),thumb=resourceVariantAdapter(()=> 'thumbnail',()=>reads++,()=>same?bytes:Buffer.from('不同内容缩略图'));
 const adapter={...old,execute:context=>(thumbnail?thumb:old).execute(context)};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:'legacy-thumbnail-unknown',goal:'extract'});const oldFile=(await f.media.read(f.contact,image.id)).files[0];
 t.mock.timers.enable({apis:['setTimeout','Date']});thumbnail=true;
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,oldFile.fileId);
 same=true;t.mock.timers.tick(60_000);await sync.waitForIdle();const classified=(await f.media.read(f.contact,image.id)).files[0];
 assert.equal(classified.imageQuality,'thumbnail');assert.notEqual(classified.fileId,oldFile.fileId);assert.equal(reads,3);
});

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
