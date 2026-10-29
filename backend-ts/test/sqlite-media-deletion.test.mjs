import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,open,readFile,rename,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
const owner='00000000-0000-4000-8000-000000000001';
async function fixture(t,kind='image'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-media-delete-16-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/media/deletion-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>[{externalKey:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'}]};
 const contacts=new SqliteContactService(storage,owner,metadata);await contacts.initialize();
 const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);const saved=(await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})))).bindings[0];
 const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
 const target={protocol:'private-history-v1',descriptor:'fixed-synthetic-target',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-1'}],sourceGeneration:'source-1'};
 const history=new SqliteHistoryService(storage,contacts,{inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),target:async()=>target,page:async(_s,_t,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[{partition:'shard-a',table:'table-1',localId:'1',serverId:'0',sender:'contact',kind,text:null,originalType:'3',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null}],completedPartitions:['shard-a'],exhausted:true})});
 await history.synchronize(saved.contact_id);const message=(await history.read(saved.contact_id)).messages[0];
 await storage.execute('fixture.mediaHead',{ownerId:owner,contactId:saved.contact_id,messageId:message.id});
 const holders=new ActiveHolders(),files=new ManagedFiles(root),deletion=new DeletionService(storage,holders,files);
 return {storage,contacts,history,message,saved,deletion,holders,files,root};
}
test('单独清除只推进媒体代次，读取授权与消息占位保持，原请求沿同删除操作完成',async t=>{
 const f=await fixture(t);const before=await f.contacts.eligibility(f.saved.contact_id);
 const input={ownerId:owner,requestKey:'clear-1',scope:{kind:'media_result_clear',contactId:f.saved.contact_id,messageId:f.message.id}};
 const op=await f.deletion.plan(input);assert.equal(op.acceptedGeneration,1n);
 assert.equal((await f.deletion.plan(input)).operationId,op.operationId);
 const done=await f.deletion.advance(op);assert.equal(done.state,'completed');
 assert.deepEqual(await f.contacts.eligibility(f.saved.contact_id),before);
 assert.equal((await f.history.read(f.saved.contact_id)).messages[0].id,f.message.id);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

async function start(f,key='extract-1',goal='extract'){
 const scope={ownerId:owner,contactId:f.saved.contact_id,messageId:f.message.id};
 const result=await f.storage.execute('media.begin',{...scope,requestKey:key,goal,token:goal==='audio_conversion'?null:await f.contacts.eligibility(scope.contactId),adapterVersion:'synthetic-v1'});
 const handle={...scope,attemptId:result.attemptId,leaseToken:result.leaseToken};await f.storage.execute('media.check',handle);return {...handle,recordId:result.recordId};
}
async function file(f,attempt,role='image_display',parentFileId){
 const reserved=await f.storage.execute('media.allocate',{...attempt,role,parentFileId});
 f.files.prepareArea('media');const location=join(f.root,'managed/media',reserved.locator);
 const fd=await open(location,'wx',0o600);const address=f.files.capture('media',reserved.locator);
 await f.storage.execute('media.identify',{...attempt,...reserved,address});
 // 合成类型校验结果仅用于生命周期；不认证图片/视频/语音格式支持。
 const bytes=Buffer.from('synthetic media bytes');await fd.writeFile(bytes);await fd.sync();await fd.close();
 await f.storage.execute('media.validated',{...attempt,fileId:reserved.fileId,byteSize:bytes.length,digest:createHash('sha256').update(bytes).digest('hex'),validation:{format:'synthetic',mimeType:role==='image_display'?'image/x-synthetic':'audio/x-synthetic',containerValid:true,viewable:role==='image_display',playable:role==='audio_playback',imageQuality:role==='image_display'?'thumbnail':'not_applicable',qualityProof:null}});
 return {...reserved,address,location};
}
async function publish(f,attempt){return f.storage.execute('media.publish',{...attempt,association:attempt.recordId?{protocol:'media-association-v1',profileId:'synthetic-v1',recordId:attempt.recordId,messageId:f.message.id,resourceIdentity:'synthetic-resource-1'}:null});}
const clear=f=>({ownerId:owner,requestKey:'clear-1',scope:{kind:'media_result_clear',contactId:f.saved.contact_id,messageId:f.message.id}});
test('已保存副本单独清除先排空预览引用，撤下当前结果并拒绝原提取请求',async t=>{
 const f=await fixture(t),attempt=await start(f),stored=await file(f,attempt);await publish(f,attempt);
 let closed=false;f.holders.register({key:`mediaFile:${stored.fileId}`,ownerId:owner,contactId:f.saved.contact_id,generation:0n,async close(){closed=true;}});
 const op=await f.deletion.plan(clear(f));
 assert.equal((await f.storage.execute('media.read',attempt)).files.length,0);
 const done=await f.deletion.advance(op);assert.equal(done.state,'completed');assert.equal(closed,true);
 await assert.rejects(readFile(stored.location),{code:'ENOENT'});
 const view=await f.storage.execute('media.read',attempt);assert.equal(view.state,'cleared');assert.deepEqual(view.files,[]);
 await assert.rejects(start(f),{code:'media_request_revoked'});
 assert.equal((await f.history.read(f.saved.contact_id)).messages.length,1);
});
test('在途副本清除拒绝旧租约发布，文件身份替换保持blocked而不误删',async t=>{
 const f=await fixture(t),attempt=await start(f),stored=await file(f,attempt);
 const op=await f.deletion.plan(clear(f));
 await assert.rejects(publish(f,attempt),{code:'media_execution_stale'});
 await rename(stored.location,stored.location+'.held');await writeFile(stored.location,'unknown replacement',{mode:0o600});
 const blocked=await f.deletion.advance(op);assert.equal(blocked.state,'blocked');assert.equal(await readFile(stored.location,'utf8'),'unknown replacement');
 await rm(stored.location);await rename(stored.location+'.held',stored.location);
 assert.equal((await f.deletion.advance(op)).state,'completed');
 await assert.rejects(readFile(stored.location),{code:'ENOENT'});
});
test('本次失败的临时件沿替换清理计划清除，失败尝试仍可见且旧请求不重执行',async t=>{
 const f=await fixture(t),attempt=await start(f),stored=await file(f,attempt);
 await f.storage.execute('media.fail',{...attempt,code:'synthetic_validation_failed'});
 const view=await f.storage.execute('media.read',attempt);assert.equal(view.latestAttempt.state,'failed');assert.ok(view.cleanup);
 const done=await f.deletion.advance({ownerId:owner,operationId:view.cleanup.operationId});assert.equal(done.state,'completed');
 await assert.rejects(readFile(stored.location),{code:'ENOENT'});
 const after=await f.storage.execute('media.read',attempt);assert.equal(after.latestAttempt.state,'failed');assert.equal(after.latestAttempt.errorCode,'synthetic_validation_failed');
 const reused=await f.storage.execute('media.begin',{...attempt,requestKey:'extract-1',goal:'extract',token:await f.contacts.eligibility(f.saved.contact_id),adapterVersion:'synthetic-v1'});
 assert.equal(reused.reused,true);assert.equal(reused.attemptId,attempt.attemptId);
});
test('删除实际来源闭包包括SILK与后续本地转换，清掉证明及引用且不恢复旧请求',async t=>{
 const f=await fixture(t,'voice'),sourceAttempt=await start(f,'voice-save'),source=await file(f,sourceAttempt,'audio_source');
 await publish(f,sourceAttempt);await f.contacts.setReading(false);
 const converted=await start(f,'voice-convert','audio_conversion'),playback=await file(f,converted,'audio_playback',source.fileId);await publish(f,converted);
 const before=await f.storage.execute('media.read',converted);assert.equal(before.files.length,2);
 const op=await f.deletion.plan({ownerId:owner,requestKey:'delete-source',scope:{kind:'source',contactId:f.saved.contact_id,sourceId:f.message.sourceRecordIds[0]}});
 assert.equal(op.targets.filter(t=>t.target?.kind==='file'&&t.target.domain==='media').length,2);
 const done=await f.deletion.advance(op);assert.equal(done.state,'completed');
 await assert.rejects(readFile(source.location),{code:'ENOENT'});await assert.rejects(readFile(playback.location),{code:'ENOENT'});
 assert.deepEqual((await f.history.read(f.saved.contact_id)).messages,[]);
 assert.equal(await f.storage.execute('deletion.requestAllowed',{ownerId:owner,namespace:'media.extract',key:'voice-save'}),false);
 assert.equal(await f.storage.execute('deletion.requestAllowed',{ownerId:owner,namespace:'media.extract',key:'voice-convert'}),false);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('清除中的晚到文件身份沿原操作扩展计划，清字节且不留孤件',async t=>{
 const f=await fixture(t),attempt=await start(f),reserved=await f.storage.execute('media.allocate',{...attempt,role:'image_display'});
 const op=await f.deletion.plan(clear(f));assert.equal((await f.deletion.advance(op)).state,'blocked');
 f.files.prepareArea('media');const location=join(f.root,'managed/media',reserved.locator),fd=await open(location,'wx',0o600);
 const address=f.files.capture('media',reserved.locator);await f.storage.execute('media.identify',{...attempt,...reserved,address});await fd.writeFile('late synthetic bytes');await fd.sync();await fd.close();
 const done=await f.deletion.advance(op);assert.equal(done.state,'completed');assert.ok(done.planRevision>op.planRevision);
 await assert.rejects(readFile(location),{code:'ENOENT'});
 await assert.rejects(publish(f,attempt),{code:'media_attempt_not_found'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('新结果发布的旧件清理不碰新current，来源先清完后原替换操作仍可复核收尾',async t=>{
 const f=await fixture(t),first=await start(f,'first'),old=await file(f,first);await publish(f,first);
 const second=await start(f,'second'),fresh=await file(f,second);const view=await publish(f,second);
 assert.equal(view.files[0].fileId,fresh.fileId);assert.ok(view.cleanup);
 const oldCleanup={ownerId:owner,operationId:view.cleanup.operationId};
 const source=await f.deletion.plan({ownerId:owner,requestKey:'delete-source',scope:{kind:'source',contactId:f.saved.contact_id,sourceId:f.message.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance(source)).state,'completed');
 assert.equal((await f.deletion.advance(oldCleanup)).state,'completed');
 await assert.rejects(readFile(old.location),{code:'ENOENT'});await assert.rejects(readFile(fresh.location),{code:'ENOENT'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('联系人及账号删除同计划覆盖媒体三实体，不残留文件且外部原件保持',async t=>{
 for(const kind of ['contact','account']){
  const f=await fixture(t),attempt=await start(f),stored=await file(f,attempt);await publish(f,attempt);
  const original=join(f.root,'external-original.dat');await writeFile(original,'synthetic external original',{mode:0o600});
  const scope=kind==='account'?{kind}:{kind,contactId:f.saved.contact_id};
  const op=await f.deletion.plan({ownerId:owner,requestKey:`delete-${kind}`,scope});const done=await f.deletion.advance(op);
  assert.equal(done.state,'completed');assert.ok(done.checks.filter(c=>c.domain==='media').every(c=>c.result.result!=='blocked'));
  await assert.rejects(readFile(stored.location),{code:'ENOENT'});assert.equal(await readFile(original,'utf8'),'synthetic external original');
  await assert.rejects(f.storage.execute('media.read',attempt),{code:'media_message_not_found'});
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }
});
test('错误owner或contact的媒体清除不会修改原消息代次或文件',async t=>{
 const f=await fixture(t),attempt=await start(f),stored=await file(f,attempt);await publish(f,attempt);
 const before=await f.contacts.eligibility(f.saved.contact_id);
 for(const input of [{...clear(f),ownerId:'other-owner'},{...clear(f),scope:{...clear(f).scope,contactId:'other-contact'}}])await assert.rejects(f.deletion.plan(input),{code:'media_not_found'});
 const view=await f.storage.execute('media.read',attempt);assert.equal(view.generation,'0');assert.equal(view.files[0].fileId,stored.fileId);
 assert.deepEqual(await f.contacts.eligibility(f.saved.contact_id),before);assert.equal(await readFile(stored.location,'utf8'),'synthetic media bytes');
});
