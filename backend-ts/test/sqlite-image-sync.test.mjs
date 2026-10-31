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
 return {version:'synthetic-original-v1',supports:(kind,goal)=>kind==='image'&&goal==='original_upgrade',async execute(context){
  onRead();await context.checkpoint();
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),
   bytes:(async function*(){yield bytes;})(),validate:async path=>{assert.deepEqual(await readFile(path),bytes);return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false,imageQuality:'original',qualityProof:'synthetic-original-proof'};}});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-original-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-original'}};
 }};
}

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

test('同步适配器返回缩略图也不能发布为原图，临时文件收尾清理',async t=>{
 const adapter=originalAdapter();const original=adapter.execute;
 adapter.execute=context=>original({...context,save:input=>context.save({...input,validate:async path=>({...await input.validate(path),imageQuality:'thumbnail',qualityProof:'synthetic-thumbnail-proof'})})});
 const f=await fixture(t,adapter),image=f.messages.find(m=>m.kind==='image');
 const sync=new SqliteImageSyncCoordinator(f.storage,f.contacts,f.media);t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 const result=await f.media.read(f.contact,image.id);assert.deepEqual(result.files,[]);
 assert.equal(result.latestAttempt.errorCode,'media_original_unavailable');
 assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
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
