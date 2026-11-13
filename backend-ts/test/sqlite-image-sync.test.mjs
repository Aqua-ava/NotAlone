import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './media-support.mjs';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {SqliteImageSyncCoordinator} from '../src/media/sqlite/image-sync.ts';

const bytes=Buffer.from('合成标准图文件');
/** 合成适配器只表达“已保存的标准图／高清图”；缩略图由真实资源端口拒绝，这里用 media_thumbnail_only 失败模拟。 */
function imageAdapter(onRead=()=>{},variant=()=> 'main',contentOf=()=>bytes){
 return {version:'synthetic-image-v1',supports:(kind,goal)=>kind==='image'&&goal==='extract',async execute(context){
  onRead();await context.checkpoint();
  if(variant()==='thumbnail')throw new StorageFailure('media_thumbnail_only');
  const content=contentOf();
  await context.save({role:'image_display',expectedBytes:content.length,expectedSha256:createHash('sha256').update(content).digest('hex'),
   bytes:(async function*(){yield content;})(),validate:async path=>{assert.deepEqual(await readFile(path),content);return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false};}});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-image-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image'}};
 }};
}

test('缺副本失败只自动尝试一次，不按时间重试；重复唤醒与重启也不再读图',async t=>{
 let reads=0;const adapter=imageAdapter();adapter.execute=async()=>{reads++;throw new StorageFailure('media_local_file_missing');};
 const f=await fixture(t,adapter);t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 for(const delay of [60_000,300_000,1_800_000,21_600_000,86_400_000]){t.mock.timers.tick(delay);sync.wake();await sync.waitForIdle();}
 assert.equal(reads,1,'已有结果的图片不再按时间排队');
 await sync.close();
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();t.mock.timers.tick(86_400_000);next.wake();await next.waitForIdle();assert.equal(reads,1,'重启也不重试');
});

test('打开聊天时对未保存的图片各再试一次，同一运行内不重复；取得图片后保存',async t=>{
 let reads=0,missing=true;const adapter=imageAdapter(),extract=adapter.execute;
 adapter.execute=async context=>{reads++;if(missing)throw new StorageFailure('media_local_file_missing');return extract(context);};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 sync.retryViewed(f.contact,[image.id]);await sync.waitForIdle();assert.equal(reads,2,'看到时再试一次');
 sync.retryViewed(f.contact,[image.id]);await sync.waitForIdle();assert.equal(reads,2,'同一运行内不重复');
 await sync.close();missing=false;t.mock.timers.tick(60_000);
 const restarted=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>restarted.close());
 restarted.wake();await restarted.waitForIdle();assert.equal(reads,2,'重启后不自动读图');
 restarted.retryViewed(f.contact,[image.id]);await restarted.waitForIdle();assert.equal(reads,3,'重启后再次打开聊天才试');
 assert.equal((await f.media.read(f.contact,image.id)).files.length,1);
 restarted.retryViewed(f.contact,[image.id]);await restarted.waitForIdle();assert.equal(reads,3,'已保存的图片不再读');
});

test('确定性失败同样只自动尝试一次',async t=>{
 let reads=0;const adapter=imageAdapter();adapter.execute=async()=>{reads++;throw new StorageFailure('media_association_failed');};
 const f=await fixture(t,adapter);t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 assert.equal(reads,1);
 for(let day=0;day<3;day++){t.mock.timers.tick(86_400_000);sync.wake();await sync.waitForIdle();}
 assert.equal(reads,1);
});

test('停读取、清除或联系人停止后，打开聊天不会重试',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++,()=> 'thumbnail')),image=f.messages.find(m=>m.kind==='image');t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 await sync.stop();sync.retryViewed(f.contact,[image.id]);await sync.waitForIdle();assert.equal(reads,1,'已停止的协调器忽略查看');
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 await f.media.clear(f.contact,image.id,'clear-before-view');t.mock.timers.tick(60_000);
 next.retryViewed(f.contact,[image.id]);await next.waitForIdle();assert.equal(reads,1,'已清除的图片不恢复');
 await next.stop(f.contact);t.mock.timers.tick(60_000);next.retryViewed(f.contact,[image.id]);await next.waitForIdle();assert.equal(reads,1,'已停止的联系人不重试');
});

test('存量图片超过一页时处理全部消息，不因前页退避漏掉后页',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++)),page=f.channel.page;
 f.channel.page=async()=>{const old=await page();return {...old,records:[...old.records,...Array.from({length:130},(_,i)=>({...old.records[0],localId:String(i+10)}))]};};
 await f.history.synchronize(f.contact);
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 assert.equal(reads,131);sync.wake();await sync.waitForIdle();assert.equal(reads,131);
});

test('全部授权联系人未保存的图片自动取得，已保存的重启后不重读',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++)),images=[];
 for(const binding of f.saved){
  if(binding.contact_id!==f.contact)await f.history.synchronize(binding.contact_id);
  images.push({contact:binding.contact_id,id:(await f.history.read(binding.contact_id)).messages.find(m=>m.kind==='image').id});
 }
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,images.length);
 for(const image of images){const state=await f.media.read(image.contact,image.id);assert.equal(state.files.length,1);assert.equal(state.latestAttempt.outcome,'full');}
 await sync.close();const restarted=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>restarted.close());
 restarted.wake();await restarted.waitForIdle();assert.equal(reads,images.length);
});

test('仅有缩略图时不保存任何文件，不按时间重试，打开聊天时再试，取得标准图后保存',async t=>{
 let variant='thumbnail',reads=0;const f=await fixture(t,imageAdapter(()=>reads++,()=>variant)),image=f.messages.find(m=>m.kind==='image');
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 assert.equal(sync.status().checked,1);assert.equal(sync.status().failed,0);assert.equal(sync.status().last_failure_code,null);
 const thumbnailOnly=await f.media.read(f.contact,image.id);
 assert.deepEqual(thumbnailOnly.files,[]);assert.equal(thumbnailOnly.latestAttempt.state,'failed');assert.equal(thumbnailOnly.latestAttempt.errorCode,'media_thumbnail_only');
 assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
 assert.equal((await f.history.imageMedia(f.contact,[image.id])).get(image.id).state,'thumbnail_only');
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 t.mock.timers.tick(86_400_000);await sync.waitForIdle();sync.wake();await sync.waitForIdle();assert.equal(reads,1,'不按时间重试');
 sync.retryViewed(f.contact,[image.id]);await sync.waitForIdle();assert.equal(reads,2,'打开聊天时再试，仍只有缩略图');
 variant='main';t.mock.timers.tick(60_000);
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.retryViewed(f.contact,[image.id]);await next.waitForIdle();assert.equal(reads,3);
 const saved=await f.media.read(f.contact,image.id);
 assert.equal(saved.files.length,1);assert.equal(saved.latestAttempt.outcome,'full');assert.equal(saved.latestAttempt.errorCode,null);
 const projected=(await f.history.imageMedia(f.contact,[image.id])).get(image.id);
 assert.deepEqual(projected,{state:'available',fileId:saved.files[0].fileId,mimeType:'image/png'});
 t.mock.timers.tick(86_400_000);await next.waitForIdle();next.wake();await next.waitForIdle();assert.equal(reads,3);
 assert.equal((await readdir(join(f.root,'managed','media'))).length,1);
});

test('仅缩略图的结果跨协调器重建保持，重启后不自动再读',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++,()=> 'thumbnail'));t.mock.timers.enable({apis:['setTimeout','Date']});
 const first=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>first.close());
 first.wake();await first.waitForIdle();assert.equal(reads,1);await first.close();
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();t.mock.timers.tick(86_400_000);next.wake();await next.waitForIdle();assert.equal(reads,1);
});

test('关闭读取和退出会停止补查，重新开启后只做尚未试过的图片',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++,()=> 'thumbnail'));t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 await f.contacts.setReading(false);await sync.stop();t.mock.timers.tick(120_000);await sync.waitForIdle();assert.equal(reads,1);
 await f.contacts.setReading(true);sync.wake();await sync.waitForIdle();assert.equal(reads,1,'已有结果的图片不因重新开启而重读');
 const image=f.messages.find(m=>m.kind==='image');await f.media.clear(f.contact,image.id,'clear-thumbnail-only');
 t.mock.timers.tick(1_800_000);await sync.waitForIdle();sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
 await sync.close();t.mock.timers.tick(120_000);assert.equal(reads,1);
});

test('自动取图在来源准备期间遇到清除时，仅缩略图和缺副本均不恢复',{timeout:15000},async t=>{
 for(const variant of ['thumbnail','missing'])await t.test(variant,async t=>{
  let blocked=false,reads=0,mode=variant;const started=Promise.withResolvers(),release=Promise.withResolvers();
  const adapter=imageAdapter(()=>reads++,()=>mode==='thumbnail'?'thumbnail':'main'),execute=adapter.execute;
  adapter.execute=context=>{if(mode==='missing'){reads++;throw new StorageFailure('media_local_file_missing');}return execute(context);};
  const f=await fixture(t,adapter,{ensureSourceReady:async()=>{if(blocked){started.resolve();await release.promise;}}}),image=f.messages.find(m=>m.kind==='image');
  await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:'race-initial-image',goal:'extract'}),{code:variant==='missing'?'media_local_file_missing':'media_thumbnail_only'});
  mode='saved';
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()+60_000});
  const before=reads;blocked=true;const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await started.promise;
  try{await f.media.clear(f.contact,image.id,'clear-during-source-preparation');}finally{release.resolve();}await sync.waitForIdle();
  assert.equal(reads,before);const state=await f.media.read(f.contact,image.id);assert.equal(state.state,'cleared');assert.deepEqual(state.files,[]);
  sync.wake();await sync.waitForIdle();assert.equal(reads,before);
 });
});

test('来源准备失败按联系人持久退避，重启不反复核验，恢复后自动处理所有图片',{timeout:15000},async t=>{
 let prepares=0,unavailable=true,reads=0;const f=await fixture(t,imageAdapter(()=>reads++),{ensureSourceReady:async()=>{prepares++;if(unavailable)throw new StorageFailure('history_support_unverified');}});
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
 let unavailable=true,firstImage,reads=0;const adapter=imageAdapter(),execute=adapter.execute;
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

test('来源准备失败按联系人退避，恢复后首次读图；图片失败之后不再按时间重试',async t=>{
 let unavailable=true,missing=true,reads=0;const adapter=imageAdapter(),execute=adapter.execute;
 adapter.execute=async context=>{reads++;if(missing)throw new StorageFailure('media_local_file_missing');return execute(context);};
 const f=await fixture(t,adapter,{ensureSourceReady:async()=>{if(unavailable)throw new StorageFailure('history_support_unverified');}}),image=f.messages.find(m=>m.kind==='image');
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();assert.equal(reads,0);
 unavailable=false;t.mock.timers.tick(60_000);await sync.waitForIdle();assert.equal(reads,1);await sync.close();
 const restarted=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>restarted.close());restarted.wake();await restarted.waitForIdle();assert.equal(reads,1);
 missing=false;t.mock.timers.tick(86_400_000);await restarted.waitForIdle();assert.equal(reads,1,'图片失败后不按时间重试');
 restarted.retryViewed(f.contact,[image.id]);await restarted.waitForIdle();assert.equal(reads,2);assert.equal((await f.media.read(f.contact,image.id)).files.length,1);
});

test('来源准备抛普通错误也停止该联系人本批，不回显私密错误正文',async t=>{
 let prepares=0;const f=await fixture(t,imageAdapter(),{ensureSourceReady:async()=>{prepares++;throw new Error('synthetic-private-source-detail');}});
 const page=f.channel.page;f.channel.page=async()=>{const old=await page();return {...old,records:[...old.records,{...old.records[0],localId:'10'}]};};await f.history.synchronize(f.contact);
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());sync.wake();await sync.waitForIdle();
 assert.equal(prepares,1);assert.equal(sync.status().last_failure_code,'media_execution_failed');sync.wake();await sync.waitForIdle();assert.equal(prepares,1);
});

test('自动图片同步以普通提取保存文件，重复唤醒和清除后不重取',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++));
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),saved=await f.media.read(f.contact,image.id);
 assert.equal(reads,1);assert.equal(saved.latestAttempt.outcome,'full');
 sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,1);
 await f.media.clear(f.contact,image.id,'clear-unknown-image');sync.wake(f.contact);await sync.waitForIdle();
 assert.equal(reads,1);assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
});

test('已授权图片随同步保存图片，重复唤醒复用副本且不依赖记忆任务',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++));
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),saved=await f.media.read(f.contact,image.id);
 assert.equal(saved.files.length,1);assert.equal(reads,1);
 sync.wake(f.contact);await sync.waitForIdle();
 assert.equal(reads,1);assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,saved.files[0].fileId);
 assert.equal((await f.history.read(f.contact)).messages.length,4);
});

test('历史页接受后自动唤醒图片保存，无需调用协调器唤醒入口',async t=>{
 let sync,reads=0;
 const f=await fixture(t,imageAdapter(()=>reads++),{onAcceptedPage:contactId=>sync?.wake(contactId)});
 sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 await f.history.synchronize(f.contact);await sync.waitForIdle();
 const image=f.messages.find(m=>m.kind==='image'),saved=await f.media.read(f.contact,image.id);
 assert.equal(reads,1);
});

test('取图失败只保存失败记录，后续同步不反复取图',async t=>{
 let reads=0;const adapter=imageAdapter();adapter.execute=async()=>{reads++;throw new StorageFailure('media_original_unavailable');};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const missing=await f.media.read(f.contact,image.id);
 assert.deepEqual(missing.files,[]);assert.equal(missing.latestAttempt.errorCode,'media_original_unavailable');
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 assert.equal((await f.history.read(f.contact)).messages.find(m=>m.id===image.id).kind,'image');
 assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
});

test('关闭读取不取图，开启后保存且清除图片后普通同步不恢复',async t=>{
 let reads=0;const f=await fixture(t,imageAdapter(()=>reads++)),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 await f.contacts.setReading(false);sync.wake();await sync.waitForIdle();assert.equal(reads,0);
 await f.contacts.setReading(true);sync.wake();await sync.waitForIdle();assert.equal(reads,1);
 const cleared=await f.media.clear(f.contact,image.id,'clear-image-sync');assert.equal(cleared.state,'cleared');
 sync.wake();await sync.waitForIdle();assert.equal(reads,1);assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
 const next=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>next.close());
 next.wake();await next.waitForIdle();assert.equal(reads,1);
});

test('停读取消正在读取的图片并排空，旧消息唤醒不能重新派发',async t=>{
 const started=Promise.withResolvers();let reads=0;const adapter=imageAdapter();
 adapter.execute=async context=>{reads++;started.resolve();await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));await context.checkpoint();throw new Error('取消后不能到达');};
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake(f.contact);await started.promise;await f.contacts.setReading(false);await sync.stop();
 sync.wake(f.contact);await sync.waitForIdle();assert.equal(reads,1);
 const result=await f.media.read(f.contact,image.id);assert.deepEqual(result.files,[]);assert.equal(result.latestAttempt.state,'interrupted');
});
