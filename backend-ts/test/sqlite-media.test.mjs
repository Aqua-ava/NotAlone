import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteMediaService} from '../src/media/sqlite/service.ts';
import {fixture} from './media-support.mjs';
test('只接受单条已核验媒体消息，未安装类型明确不可执行且跨联系人拒绝',async t=>{
 const f=await fixture(t);const image=f.messages.find(m=>m.kind==='image');
 const value=await f.media.read(f.contact,image.id);assert.equal(value.state,'available');assert.deepEqual(value.files,[]);assert.equal(value.capabilities.extract,false);
 await assert.rejects(f.media.extract(f.contact,image.id,{requestKey:'one',goal:'extract'}),{code:'media_adapter_unavailable'});
 await assert.rejects(f.media.read(f.saved[1].contact_id,image.id),{code:'media_message_not_found'});
 await assert.rejects(f.media.read(f.contact,f.messages.find(m=>m.kind==='text').id),{code:'media_kind_unsupported'});
});

const imageBytes=Buffer.from('synthetic-image-payload');
function imageAdapter(options={}){return {version:'synthetic-media-v1',supports:(kind,goal)=>kind==='image'&&goal!=='audio_conversion',execute:async context=>{
 const {createHash}=await import('node:crypto');
 await context.save({role:'image_display',expectedBytes:imageBytes.length,expectedSha256:createHash('sha256').update(imageBytes).digest('hex'),bytes:(async function*(){yield imageBytes;})(),validate:async localPath=>{const {readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(localPath),imageBytes);return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false};}});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-media-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-resource-one'}};
 }};}
test('重开媒体时跳过来源已失效的副本，仍拒绝预览且其他联系人可用',async t=>{
 const f=await fixture(t,imageAdapter()),other=f.saved[1].contact_id;
 const m=f.messages.find(m=>m.kind==='image');
 const stale=await f.media.extract(f.contact,m.id,{requestKey:'source-before-quarantine',goal:'extract'});
 await f.history.synchronize(other);const otherMessage=(await f.history.read(other)).messages.find(m=>m.kind==='image');
 const good=await f.media.extract(other,otherMessage.id,{requestKey:'source-still-valid',goal:'extract'});
 const page=f.channel.page;
 f.channel.page=async(scope,...args)=>scope.token.contact_id===f.contact?{
  target:f.target.descriptor,cursorIn:null,cursorOut:null,completedPartitions:['a'],exhausted:true,
  records:[{partition:'a',table:'one',localId:'1',serverId:'0',sender:'unknown',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'unverified'}],
 }:page(scope,...args);
 await f.history.synchronize(f.contact);
 await assert.rejects(f.media.openPreview(f.contact,m.id,stale.files[0].fileId),{code:'history_source_not_available'});
 const reopened=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.history,userData:f.root,adapters:[imageAdapter()]});
 t.after(()=>reopened.close());await reopened.initialize();
 await assert.rejects(reopened.openPreview(f.contact,m.id,stale.files[0].fileId),{code:'history_source_not_available'});
 assert.deepEqual((await reopened.read(other,otherMessage.id)).files,good.files);
});

test('明确单消息保存真实独立文件、可查看状态、幂等及清除保留占位',async t=>{
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');
 const value=await f.media.extract(f.contact,m.id,{requestKey:'save-one',goal:'extract'});assert.equal(value.latestAttempt.state,'completed');assert.equal(value.latestAttempt.outcome,'full');assert.equal(value.files.length,1);
 const repeated=await f.media.extract(f.contact,m.id,{requestKey:'save-one',goal:'extract'});assert.equal(repeated.latestAttempt.attemptId,value.latestAttempt.attemptId);assert.equal(repeated.files[0].fileId,value.files[0].fileId);
 const {readdir}=await import('node:fs/promises');assert.equal((await readdir(join(f.root,'managed','media'))).length,1);
 const cleared=await f.media.clear(f.contact,m.id,'clear-one');assert.equal(cleared.state,'cleared');assert.deepEqual(cleared.files,[]);assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
 assert.equal((await f.history.read(f.contact)).messages.length,4);
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'save-one',goal:'extract'}),{code:'media_request_revoked'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('关闭读取后旧请求只返回原结果，重新选中不受旧尝试的读取代次误禁',async t=>{
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');const first=await f.media.extract(f.contact,m.id,{requestKey:'replay-read-off',goal:'extract'});
 await f.contacts.setReading(false);
 const repeated=await f.media.extract(f.contact,m.id,{requestKey:'replay-read-off',goal:'extract'});assert.equal(repeated.latestAttempt.attemptId,first.latestAttempt.attemptId);
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'new-read-off',goal:'extract'}),{code:'read_not_authorized'});
 assert.equal((await f.media.read(f.contact,m.id)).files.length,1);
 await f.contacts.setReading(true);assert.equal((await f.media.read(f.contact,m.id)).capabilities.extract,true);
});

test('读取关闭或取消勾选在分段读后拒绝发布，旧合法结果仍可查看',async t=>{
 const adapter=imageAdapter();const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');const first=await f.media.extract(f.contact,m.id,{requestKey:'initial',goal:'extract'});
 const base=adapter.execute;adapter.execute=async context=>{const result=await base(context);await f.contacts.setReading(false);return result;};
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'stop-before-publish',goal:'extract'}),{code:'read_not_authorized'});assert.equal((await f.media.read(f.contact,m.id)).files[0].fileId,first.files[0].fileId);
 await f.contacts.setReading(true);adapter.execute=async context=>{const result=await base(context);const b=(await f.contacts.directory()).bindings.find(b=>b.contact_id===f.contact);await f.contacts.revoke(f.contact,b.binding_id,b.selection_generation);return result;};
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'unselect-before-publish',goal:'extract'}),{code:'media_contact_not_selected'});
 const after=await f.media.read(f.contact,m.id);assert.equal(after.files[0].fileId,first.files[0].fileId);assert.equal(after.capabilities.extract,false);
});

test('清除等在途读收尾且旧回调不能恢复文件，只有新明确请求可重提',async t=>{
 let started;const ready=new Promise(resolve=>{started=resolve;});
 const adapter=imageAdapter();const original=adapter.execute;adapter.execute=async context=>{const result=await original(context);started();await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));return result;};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');
 const extracting=f.media.extract(f.contact,m.id,{requestKey:'inflight',goal:'extract'});const rejected=assert.rejects(extracting,{code:'media_interrupted'});await ready;
 const value=await f.media.clear(f.contact,m.id,'clear-inflight');await rejected;assert.equal(value.state,'cleared');assert.deepEqual(value.files,[]);
 const {readdir}=await import('node:fs/promises');assert.equal((await readdir(join(f.root,'managed','media'))).length,0);
 adapter.execute=original;const fresh=await f.media.extract(f.contact,m.id,{requestKey:'explicit-new',goal:'extract'});assert.equal(fresh.files.length,1);assert.equal(fresh.generation,'1');
});

test('认证HTTP只接受明确单消息及具名参数，不接受范围、路径或字节注入',async t=>{
 const {createServer}=await import('node:http');const {once}=await import('node:events');const {randomUUID}=await import('node:crypto');const {SqliteMediaHttp}=await import('../src/media/sqlite/http.ts');
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');const api=new SqliteMediaHttp(f.media);
 const server=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer synthetic-token'||req.headers.origin){res.writeHead(401);res.end();return;}if(!await api.handle(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.contact}/messages/${m.id}/media`;const headers={Authorization:'Bearer synthetic-token','Content-Type':'application/json'};
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{...headers,Origin:'https://example.invalid'}})).status,401);
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({request_key:randomUUID(),goal:'extract',path:'/tmp/external'})})).status,400);
 const result=await fetch(url,{method:'POST',headers,body:JSON.stringify({request_key:randomUUID(),goal:'extract'})});assert.equal(result.status,200);const value=await result.json();assert.equal(value.files.length,1);assert.equal(JSON.stringify(value).includes('managed_locator'),false);
 assert.equal((await fetch(url,{method:'DELETE',headers})).status,400);const cleared=await fetch(url,{method:'DELETE',headers:{...headers,'Idempotency-Key':randomUUID()}});assert.equal(cleared.status,200);assert.equal((await cleared.json()).state,'cleared');
});

test('活动预览等待实际撤下确认，未确认时不完成删除且旧内容不能再打开',async t=>{
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');const saved=await f.media.extract(f.contact,m.id,{requestKey:'preview-save',goal:'extract'});
 const preview=await f.media.openPreview(f.contact,m.id,saved.files[0].fileId);assert.deepEqual(Buffer.from(preview.dataBase64,'base64'),imageBytes);
 const deleting=f.media.clear(f.contact,m.id,'preview-clear');
 for(let attempt=0;attempt<100&&f.media.previewStatus(preview.sessionId).state!=='revoking';attempt++)await f.media.read(f.contact,m.id);
 assert.equal(f.media.previewStatus(preview.sessionId).state,'revoking');
 const operations=await f.media.deletion.list({ownerId:f.owner});const op=operations.find(o=>o.scope.kind==='media_result_clear');assert.ok(op);assert.notEqual(op.state,'completed');
 await assert.rejects(f.media.openPreview(f.contact,m.id,saved.files[0].fileId),{code:'media_file_not_found'});
 // 模拟页面已撤下blob及播放句柄后才调用确认端口。
 await f.media.releasePreview(preview.sessionId);const cleared=await deleting;assert.equal(cleared.state,'cleared');assert.equal((await f.media.deletion.status({ownerId:f.owner,operationId:op.operationId})).state,'completed');
});

test('宿主重新打开将未完成尝试标中断，GET和旧请求不自动新取资源',async t=>{
 const adapter=imageAdapter();let executions=0;const execute=adapter.execute;adapter.execute=async context=>{executions++;return execute(context);};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');const token=await f.contacts.eligibility(f.contact);
 const pending=await f.storage.execute('media.begin',{ownerId:f.owner,contactId:f.contact,messageId:m.id,requestKey:'crashed-pending',goal:'extract',token,adapterVersion:adapter.version});
 await f.media.close();await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:f.storage.status.databaseId,role:'test',registryModule:new URL('./fixtures/media/registry.mjs',import.meta.url).href});
 const contacts=new SqliteContactService(reopened,f.owner,{account:async()=>{throw new Error('不应读取');},sessions:async()=>[]});
 const media=new SqliteMediaService({storage:reopened,contacts,history:f.history,userData:f.root,adapters:[adapter]});t.after(async()=>{await media.close();await reopened.close();});await media.initialize();
 const result=await media.read(f.contact,m.id);assert.equal(result.latestAttempt.state,'interrupted');assert.equal(result.latestAttempt.attemptId,pending.attemptId);
 assert.equal((await media.extract(f.contact,m.id,{requestKey:'crashed-pending',goal:'extract'})).latestAttempt.state,'interrupted');assert.equal(executions,0);
});

test('不完整复制停止本次写入且无失败字节留存，不影响其他联系人的独立副本',async t=>{
 const adapter=imageAdapter();const f=await fixture(t,adapter);const a=f.messages.find(m=>m.kind==='image');await f.history.synchronize(f.saved[1].contact_id);const b=(await f.history.read(f.saved[1].contact_id)).messages.find(m=>m.kind==='image');
 const first=await f.media.extract(f.contact,a.id,{requestKey:'copy-a',goal:'extract'});const second=await f.media.extract(f.saved[1].contact_id,b.id,{requestKey:'copy-b',goal:'extract'});assert.notEqual(first.files[0].fileId,second.files[0].fileId);
 adapter.execute=async context=>{await context.save({role:'image_display',expectedBytes:10,expectedSha256:'a'.repeat(64),bytes:(async function*(){yield Buffer.from('short');})(),validate:async()=>{throw new Error('不应进入类型校验');}});return {association:null};};
 await assert.rejects(f.media.extract(f.contact,a.id,{requestKey:'truncated',goal:'extract'}),{code:'media_copy_incomplete'});
 assert.equal((await f.media.read(f.contact,a.id)).files[0].fileId,first.files[0].fileId);await f.media.clear(f.contact,a.id,'clear-a-only');
 assert.equal((await f.media.read(f.saved[1].contact_id,b.id)).files[0].fileId,second.files[0].fileId);
 const {readdir}=await import('node:fs/promises');assert.equal((await readdir(join(f.root,'managed','media'))).length,1);
});

test('语音原始件有限保存，本地重转在关闭读取时可执行且保留原始父件',async t=>{
 const {createHash}=await import('node:crypto');let reads=0,conversionSignal,enteredConversion,releaseConversion;const entered=new Promise(resolve=>{enteredConversion=resolve;});const gate=new Promise(resolve=>{releaseConversion=resolve;});
 const adapter={version:'synthetic-voice-v1',supports:kind=>kind==='voice',execute:async context=>{
  if(context.goal==='extract'){reads++;assert.ok(context.source);assert.ok(context.token);}else{assert.equal(context.source,null);assert.equal(context.token,null);assert.ok(context.input);conversionSignal=context.signal;enteredConversion();await Promise.race([gate,new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}))]);}
  const bytes=Buffer.from(context.goal==='extract'?'synthetic-silk':'synthetic-wav');
  await context.save({role:context.goal==='extract'?'audio_source':'audio_playback',...(context.input?{parentFileId:context.input.fileId}:{}),expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:context.goal==='extract'?'synthetic-silk':'synthetic-wav',mimeType:context.goal==='extract'?'audio/silk':'audio/wav',containerValid:true,viewable:false,playable:context.goal!=='extract'})});
  return {association:context.source?{protocol:'media-association-v1',profileId:'synthetic-voice-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-voice'}:null,...(context.goal==='extract'?{errorCode:'synthetic_conversion_unavailable'}:{})};
 }};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='voice');const first=await f.media.extract(f.contact,m.id,{requestKey:'silk',goal:'extract'});assert.equal(first.latestAttempt.outcome,'limited');assert.equal(first.files[0].playable,false);
 await f.contacts.setReading(false);assert.equal((await f.media.read(f.contact,m.id)).capabilities.audioConversion,true);
 const converting=f.media.extract(f.contact,m.id,{requestKey:'local-wav',goal:'audio_conversion'});await entered;await f.media.stop(undefined,'wechat');const interrupted=conversionSignal.aborted;releaseConversion();assert.equal(interrupted,false);const converted=await converting;assert.equal(converted.latestAttempt.outcome,'full');assert.equal(converted.files.length,2);assert.ok(converted.files.find(f=>f.role==='audio_playback').playable);assert.equal(converted.files.find(f=>f.role==='audio_source').fileId,first.files[0].fileId);assert.equal(reads,1);
 await f.media.clear(f.contact,m.id,'clear-silk-and-wav');assert.deepEqual((await f.media.read(f.contact,m.id)).files,[]);
});

test('转换器空间不足及类型验证后文件被改动均停止新增发布，保留合法旧件',async t=>{
 const adapter=imageAdapter();const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');const first=await f.media.extract(f.contact,m.id,{requestKey:'space-old',goal:'extract'});
 const {createHash}=await import('node:crypto');const {writeFile,readdir}=await import('node:fs/promises');let tamper=false;
 adapter.execute=async context=>{await context.save({role:'image_display',expectedBytes:imageBytes.length,expectedSha256:createHash('sha256').update(imageBytes).digest('hex'),bytes:(async function*(){yield imageBytes;})(),validate:async location=>{if(!tamper)throw Object.assign(new Error('合成转换器空间故障'),{code:'ENOSPC'});await writeFile(location,'tampered');return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false};}});return {association:null};};
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'space-failure',goal:'extract'}),{code:'media_space_insufficient'});assert.equal((await f.media.read(f.contact,m.id)).files[0].fileId,first.files[0].fileId);assert.equal((await readdir(join(f.root,'managed','media'))).length,1);
 tamper=true;await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'tampered-validation',goal:'extract'}),{code:'media_file_identity_changed'});assert.equal((await f.media.read(f.contact,m.id)).files[0].fileId,first.files[0].fileId);assert.equal((await readdir(join(f.root,'managed','media'))).length,1);
});

test('关闭服务排空尚未注册的预览启动，晚到字节不得暴露为active',async t=>{
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');const saved=await f.media.extract(f.contact,m.id,{requestKey:'close-preview',goal:'extract'});
 const opening=f.media.openPreview(f.contact,m.id,saved.files[0].fileId);const closing=f.media.close();let result,error;try{result=await opening;}catch(e){error=e;}
 if(result)await f.media.releasePreview(result.sessionId);await closing;
 assert.equal(error?.code,'media_closed');
});

test('超过App可撤销预览上限的资源在读取字节前拒绝，避免保存后误称可播放',async t=>{
 let read=false;const adapter={version:'synthetic-video-v1',supports:kind=>kind==='video',execute:async context=>{await context.save({role:'video_playback',expectedBytes:33*1024*1024,expectedSha256:'a'.repeat(64),bytes:(async function*(){read=true;yield Buffer.alloc(1);})(),validate:async()=>{throw new Error('不应校验');}});return {association:null};}};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='video');await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'too-large',goal:'extract'}),{code:'media_resource_too_large'});assert.equal(read,false);assert.deepEqual((await f.media.read(f.contact,m.id)).files,[]);
});

test('活动引用使用联系人资料代次而非媒体代次，较新合法预览不会被旧清空屏障误禁',async t=>{
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');const saved=await f.media.extract(f.contact,m.id,{requestKey:'holder-generation',goal:'extract'});
 const text=f.messages.find(m=>m.kind==='text');const op=await f.media.deletion.plan({ownerId:f.owner,requestKey:'delete-unrelated-source',scope:{kind:'source',contactId:f.contact,sourceId:text.sourceRecordIds[0]}});const result=await f.media.deletion.advance({ownerId:f.owner,operationId:op.operationId});assert.equal(result.state,'completed');
 assert.equal(op.acceptedGeneration,1n);assert.equal((await f.media.read(f.contact,m.id)).generation,'0');
 // 合成已排空的历史holder屏障；合法保留来源及当前资料代次来自正式删除入口。
 f.media.holders.fence({...op,scope:{kind:'contact_history',contactId:f.contact}},[]);
 const preview=await f.media.openPreview(f.contact,m.id,saved.files[0].fileId);assert.equal(f.media.previewStatus(preview.sessionId).state,'active');await f.media.releasePreview(preview.sessionId);
});

test('适配器遗漏await也须排空已启动文件探针，关闭不能提前释放在途句柄',async t=>{
 const {createHash}=await import('node:crypto');const {open}=await import('node:fs/promises');let started,continueRead,settled=false;const ready=new Promise(resolve=>{started=resolve;});const continueGate=new Promise(resolve=>{continueRead=resolve;});let background;
 const adapter={version:'synthetic-early-return-v1',supports:kind=>kind==='image',execute:async context=>{
  background=context.save({role:'image_display',expectedBytes:imageBytes.length,expectedSha256:createHash('sha256').update(imageBytes).digest('hex'),bytes:(async function*(){yield imageBytes;})(),validate:async location=>{const held=await open(location);started();try{await continueGate;await held.readFile();return {format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false};}finally{await held.close();settled=true;}}});void background.catch(()=>{});
  await ready;return {association:{protocol:'media-association-v1',profileId:'synthetic-media-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-early'}};
 }};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');const extracting=f.media.extract(f.contact,m.id,{requestKey:'unawaited-save',goal:'extract'});void extracting.catch(()=>{});await ready;for(let step=0;step<10;step++)await f.storage.check();
 let closed=false;const closing=f.media.close().then(()=>{closed=true;});for(let step=0;step<10;step++)await f.storage.check();const closedBeforeRelease=closed;continueRead();await background.catch(()=>{});await extracting.catch(()=>{});await closing;assert.equal(closedBeforeRelease,false);assert.equal(settled,true);
});

test('旧请求重送返回原尝试回执，不能把后来的失败解释为原操作结果',async t=>{
 const adapter=imageAdapter();const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');const first=await f.media.extract(f.contact,m.id,{requestKey:'original-operation',goal:'extract'});
 adapter.execute=async()=>{throw new Error('合成后一次失败');};await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'later-operation',goal:'extract'}));
 const replay=await f.media.extract(f.contact,m.id,{requestKey:'original-operation',goal:'extract'});assert.equal(replay.requestedAttempt.attemptId,first.latestAttempt.attemptId);assert.equal(replay.requestedAttempt.state,'completed');assert.equal(replay.latestAttempt.state,'failed');
});

test('启动时的已存副本核验不阻塞宿主初始化，完成后仍撤下缺失副本',async t=>{
 const {readdir,unlink}=await import('node:fs/promises');
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');await f.media.extract(f.contact,m.id,{requestKey:'startup-sweep',goal:'extract'});
 const names=await readdir(join(f.root,'managed','media'));await unlink(join(f.root,'managed','media',names[0]));
 const reopened=new SqliteMediaService({storage:f.storage,contacts:f.contacts,history:f.history,userData:f.root,adapters:[imageAdapter()]});t.after(()=>reopened.close());
 let release;const gate=new Promise(resolve=>{release=resolve;});const verify=reopened.files.verify.bind(reopened.files);
 reopened.files.verify=async(...args)=>{await gate;return verify(...args);};
 // 核验被挂起时 initialize 仍须完成；握手不再随媒体体积变慢。
 await reopened.initialize();
 let settled=false;void reopened.startupVerification.then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 release();await reopened.startupVerification;
 const view=await reopened.read(f.contact,m.id);assert.equal(view.state,'invalidated');assert.deepEqual(view.files,[]);
});

test('语音播放件不能脱离合法原始SILK父件单独发布',async t=>{
 const {createHash}=await import('node:crypto');const adapter={version:'synthetic-no-source-v1',supports:kind=>kind==='voice',execute:async context=>{const bytes=Buffer.from('synthetic-wav');await context.save({role:'audio_playback',expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic-wav',mimeType:'audio/wav',containerValid:true,viewable:false,playable:true})});return {association:{protocol:'media-association-v1',profileId:'synthetic-voice',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-wave'}};}};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='voice');await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'without-silk',goal:'extract'}),{code:'media_audio_source_required'});assert.deepEqual((await f.media.read(f.contact,m.id)).files,[]);
});

test('已发布文件缺失时查看撤下成功结果，明确新提取才恢复且无需自动读取',async t=>{
 const {readdir,unlink}=await import('node:fs/promises');let runs=0;const adapter=imageAdapter();const execute=adapter.execute;adapter.execute=async context=>{runs++;return execute(context);};
 const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='image');await f.media.extract(f.contact,m.id,{requestKey:'missing-original',goal:'extract'});
 const names=await readdir(join(f.root,'managed','media'));await unlink(join(f.root,'managed','media',names[0]));
 const unavailable=await f.media.read(f.contact,m.id);assert.equal(unavailable.state,'invalidated');assert.deepEqual(unavailable.files,[]);assert.equal(unavailable.latestAttempt.errorCode,'media_saved_file_unavailable');assert.equal(runs,1);
 const recovered=await f.media.extract(f.contact,m.id,{requestKey:'explicit-missing-retry',goal:'extract'});assert.equal(recovered.files.length,1);assert.equal(runs,2);
});

test('关闭服务等待提取资格启动结算，旧入口不得在关闭后建立新尝试',async t=>{
 const f=await fixture(t,imageAdapter());const m=f.messages.find(m=>m.kind==='image');let entered,proceed;const ready=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{proceed=resolve;});
 const service=new SqliteMediaService({storage:f.storage,contacts:{ownerId:f.owner,eligibility:async id=>{entered();await gate;return f.contacts.eligibility(id);}},history:f.history,userData:f.root,adapters:[imageAdapter()]});await service.initialize();t.after(()=>service.close());
 const extracting=service.extract(f.contact,m.id,{requestKey:'close-during-start',goal:'extract'});void extracting.catch(()=>{});await ready;let closed=false;const closing=service.close().then(()=>{closed=true;});for(let step=0;step<10;step++)await f.storage.check();const closedBeforeSettled=closed;proceed();await assert.rejects(extracting,{code:'media_closed'});await closing;assert.equal(closedBeforeSettled,false);assert.equal((await f.media.read(f.contact,m.id)).latestAttempt,null);
});
