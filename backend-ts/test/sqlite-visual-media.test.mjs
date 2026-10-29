import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './media-support.mjs';
import {resourcePort,png,datV4} from './visual-media-support.mjs';
import {VisualMediaAdapter} from '../src/media/visual/adapter.ts';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
test.before(()=>{execFileSync('bash',[fileURLToPath(new URL('../../native/media-validation/build.sh',import.meta.url))],{stdio:'pipe'});});

test('正常媒体服务经图片类型适配器保存可实际解码的独立缩略图',async t=>{
 let closed=0;const f=await fixture(t,new VisualMediaAdapter(resourcePort({closed:()=>closed++})));
 const image=f.messages.find(m=>m.kind==='image');
 const value=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(value.latestAttempt.outcome,'limited');assert.equal(value.files[0].imageQuality,'thumbnail');
 assert.equal(value.files[0].viewable,true);assert.equal(value.files[0].format,'png');assert.equal(closed,1);
 const preview=await f.media.openPreview(f.contact,image.id,value.files[0].fileId);
 assert.deepEqual(Buffer.from(preview.dataBase64,'base64'),png);await f.media.releasePreview(preview.sessionId);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('原图补提只接受可靠原图证据，失败或未知质量不替换合法结果',async t=>{
 const options={quality:{kind:'original',proof:'synthetic-original-v1'}};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 const first=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 assert.equal(first.latestAttempt.outcome,'full');
 options.quality={kind:'unknown',proof:null};
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'original_upgrade'}),{code:'media_original_unavailable'});
 const current=await f.media.read(f.contact,image.id);
 assert.equal(current.files[0].fileId,first.files[0].fileId);assert.equal(current.latestAttempt.state,'failed');
});
test('V2正确padding但实际图片不匹配时明确需要密钥，已有图片保留',async t=>{
 const key=Buffer.from('synthetic-key17!'),options={data:png};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 const first=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 const broken=Buffer.from(png);broken.fill(0,16);
 options.data=datV4(broken,{version:2,key});options.envelope='wechat_dat';options.withImageKey=async consume=>consume({aesKey:key});
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'needs_image_key'});
 assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,first.files[0].fileId);
});
test('V3和V4图片实际解码成功，缺密钥或未知封装失败不会发布暂存文件',async t=>{
 const key=Buffer.from('synthetic-key17!'),options={data:png.map(v=>v^0x8a),envelope:'wechat_dat'};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 for(const data of [options.data,datV4(png)]){
  options.data=data;const value=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});assert.equal(value.files[0].viewable,true);
 }
 options.data=datV4(png,{version:2,key});
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'needs_image_key'});
 options.withImageKey=async consume=>consume({aesKey:key});
 const value=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});assert.equal(value.files[0].viewable,true);
 options.data=Buffer.from('wxgf-unsupported');
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'unsupported'});
 assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,value.files[0].fileId);
 assert.equal((await readdir(join(f.root,'managed/media'))).length,1);
});
test('读取前拒绝错误账号或代次及无完整快照证明，不消费资源字节',async t=>{
 const options={authority:{account_id:'other-account'},afterChunk:()=>assert.fail('不应消费字节')};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 for(const authority of [{account_id:'other-account'},{contact_id:'other-contact'},{source_generation:'old'},{selection_generation:'0'},{read_epoch:'0'}]){
  options.authority=authority;
  await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_association_unverified'});
 }
 options.authority={};options.complete=false;
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_resource_incomplete'});
 options.complete=true;options.expectedBytes=32*1024*1024+1;
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_resource_too_large'});
 assert.deepEqual((await f.media.read(f.contact,image.id)).files,[]);
});
test('复制完整性与图片质量独立，缺质量证据不能宣称原图',async t=>{
 const options={quality:{kind:'unknown',proof:null}};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 const value=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});assert.equal(value.latestAttempt.outcome,'quality_unknown');assert.equal(value.files[0].viewable,true);
 options.quality={kind:'original',proof:null};
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_quality_unverified'});
 options.quality={kind:'unknown',proof:null};options.expectedSha256='0'.repeat(64);
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_resource_incomplete'});
 delete options.expectedSha256;options.expectedBytes=png.length+1;
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),{code:'media_resource_incomplete'});
 assert.equal((await f.media.read(f.contact,image.id)).files[0].fileId,value.files[0].fileId);
});
test('来源删除等待真实类型资源读者结算，旧在途图片不能复活',async t=>{
 let started,aborted,releaseClose,delay=false;
 const ready=new Promise(resolve=>{started=resolve;}),didAbort=new Promise(resolve=>{aborted=resolve;}),closing=new Promise(resolve=>{releaseClose=resolve;});
 const options={afterChunk:async context=>{if(delay){started();await new Promise(resolve=>context.signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));}},onClose:async()=>{if(delay)await closing;}};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 delay=true;const running=f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'}),rejected=assert.rejects(running,{code:'media_interrupted'});await ready;
 const op=await f.media.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contact,sourceId:image.sourceRecordIds[0]}});
 const deleting=f.media.deletion.advance({ownerId:f.owner,operationId:op.operationId});
 await didAbort;assert.notEqual((await f.media.deletion.status({ownerId:f.owner,operationId:op.operationId})).state,'completed');
 releaseClose();const result=await deleting;await rejected;assert.equal(result.state,'completed');
 assert.equal((await readdir(join(f.root,'managed/media'))).length,0);
 assert.equal((await f.history.read(f.contact)).messages.some(m=>m.id===image.id),false);
 await assert.rejects(f.media.read(f.contact,image.id),{code:'media_message_not_found'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('图片分段读取关闭开关后拒绝新发布，旧合法副本及同键回执保持',async t=>{
 let opens=0;const options={closed:()=>opens++};
 const f=await fixture(t,new VisualMediaAdapter(resourcePort(options))),image=f.messages.find(m=>m.kind==='image');
 const first=await f.media.extract(f.contact,image.id,{requestKey:randomUUID(),goal:'extract'});
 options.afterChunk=()=>f.contacts.setReading(false);const requestKey=randomUUID();
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey,goal:'extract'}),{code:'read_not_authorized'});
 const value=await f.media.read(f.contact,image.id);assert.equal(value.files[0].fileId,first.files[0].fileId);
 assert.equal(opens,2);const repeated=await f.media.extract(f.contact,image.id,{requestKey,goal:'extract'});assert.equal(repeated.requestedAttempt.state,'failed');assert.equal(opens,2);
 assert.equal((await readdir(join(f.root,'managed/media'))).length,1);
});
