import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {ContactMetadataLifetime} from '../src/storage/sqlite/deletion/contact-metadata.ts';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {normalizeContactAvatar} from '../src/contacts/sqlite/avatar.ts';
import {ContactAvatarSynchronizer} from '../src/contacts/sqlite/avatar-sync.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const owner='00000000-0000-4000-8000-000000000001';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
const localImage=async(color='#527b8c')=>({mimeType:'image/jpeg',dataBase64:(await sharp({create:{width:150,height:120,channels:3,background:color}}).jpeg().toBuffer()).toString('base64')});
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-avatar-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 const calls=[],image=await localImage();
 const metadata={account:async()=>evidence,sessions:async()=>['friend-a','friend-b'].map(externalKey=>({externalKey,displayName:'同名',kind:'private',identityAssurance:'verified'})),
  avatar:async(_account,key)=>{calls.push(key);return image;}};
 const service=new SqliteContactService(storage,owner,metadata);
 t.after(async()=>{await service.close();await storage.close();await rm(root,{recursive:true,force:true});});
 await service.initialize();const candidate=await service.detectAccount();await service.confirmAccount(candidate.candidate_token);
 const snapshot=await service.candidates(true);
 await service.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));
 await service.setReading(true);
 return {root,service,storage,metadata,calls,image,directory:await service.directory()};
}

test('头像仅读本地缓存，首次同步按稳定联系人保存，停读及来源离线仍可显示',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw new Error('头像禁止网络');});
 const {service,storage,metadata,calls,directory}=await fixture(t);
 const binding=directory.bindings[0];
 assert.equal(await service.avatar(binding.contact_id),null);assert.deepEqual(calls,[]);
 assert.equal(await service.syncAvatar(binding.contact_id),true);
 const cached=await service.avatar(binding.contact_id);assert.equal(cached.mime_type,'image/png');
 assert.deepEqual(calls,[binding.conversation_locator]);
 const revision=await service.avatarRevision();assert.equal(revision,'1');
 assert.match((await service.directory()).contacts.find(row=>row.contact_id===binding.contact_id).avatar_revision,/^[a-f0-9]{64}$/);
 assert.equal(await service.syncAvatar(binding.contact_id),true);assert.equal(await service.avatarRevision(),revision);
 await service.setReading(false);metadata.account=async()=>{throw new Error('合成本地微信离线');};
 metadata.avatar=async()=>{throw new Error('页面不得读取微信来源');};
 assert.deepEqual(await service.avatar(binding.contact_id),cached);assert.equal(await service.syncAvatar(binding.contact_id),false);
 const foreign=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000002',metadata);t.after(()=>foreign.close());
 assert.equal(await foreign.avatar(binding.contact_id),null);
});

test('持久头像重启后直接读取，不重新认证微信或触发下载',async t=>{
 const {root,service,storage,directory}=await fixture(t);const id=directory.contacts[0].contact_id;
 await service.syncAvatar(id);const expected=await service.avatar(id);await service.close();await storage.close();
 const reopened=await SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId:storage.status.databaseId,role:'test'});
 const fresh=new SqliteContactService(reopened,owner,{account:async()=>{throw new Error('不得读取微信账号');},sessions:async()=>{throw new Error('不得读取微信名单');},avatar:async()=>{throw new Error('不得读取微信头像');}});
 t.after(async()=>{await fresh.close();await reopened.close();});
 assert.deepEqual(await fresh.avatar(id),expected);
});

test('头像本地读只做定向查询，来源同步继续复验完整令牌',async t=>{
 const {service,storage,directory}=await fixture(t),execute=storage.execute.bind(storage),actions=[];
 storage.execute=async(name,input)=>{actions.push(name);if(name==='identity.directory')throw new Error('头像不得触发全目录统计');return execute(name,input);};
 const binding=directory.bindings[0];assert.equal(await service.syncAvatar(binding.contact_id),true);
 actions.length=0;assert.ok(await service.avatar(binding.contact_id));assert.deepEqual(actions,['identity.avatarRead']);
 const token=await service.eligibility(binding.contact_id);
 for(const key of ['account_id','conversation_id','binding_id','grant_id','selection_generation','data_generation','scope_revision']){
  await assert.rejects(storage.execute('identity.avatarScope',{ownerId:owner,token:{...token,[key]:key.endsWith('_id')?'00000000-0000-4000-8000-000000000099':'999'}}),{code:'read_eligibility_stale'});
 }
});

test('来源变代不读头像，撤销或停读拒绝迟到同步且保留已保存头像',async t=>{
 const {service,metadata,calls,directory,image}=await fixture(t),binding=directory.bindings[0];
 metadata.account=async()=>({...evidence,sourceGeneration:'source-other'});
 assert.equal(await service.syncAvatar(binding.contact_id),false);assert.deepEqual(calls,[]);
 metadata.account=async()=>evidence;await service.syncAvatar(binding.contact_id);const cached=await service.avatar(binding.contact_id);
 let release,started,signal;const ready=new Promise(resolve=>{started=resolve;});
 metadata.avatar=async(_account,_key,currentSignal)=>{signal=currentSignal;started();return new Promise(resolve=>{release=resolve;});};
 const pending=service.syncAvatar(binding.contact_id);await ready;
 await service.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);assert.equal(signal.aborted,true);release(image);
 assert.equal(await pending,false);assert.deepEqual(await service.avatar(binding.contact_id),cached);
});

test('关闭服务取消本地头像同步，并等待真实读取结算',async t=>{
 const {service,metadata,directory}=await fixture(t);let started,release,signal;const ready=new Promise(resolve=>{started=resolve;});
 metadata.avatar=async(_account,_key,currentSignal)=>{signal=currentSignal;started();return new Promise(resolve=>{release=resolve;});};
 const pending=service.syncAvatar(directory.contacts[0].contact_id);await ready;
 let closed=false;const closing=service.close().then(()=>{closed=true;});assert.equal(signal.aborted,true);assert.equal(closed,false);release(null);
 await closing;assert.equal(await pending,false);
});

test('联系人删除清理持久头像，兄弟联系人仍可显示',async t=>{
 const {service,storage,root,directory}=await fixture(t);for(const row of directory.contacts)await service.syncAvatar(row.contact_id);
 const [first,second]=directory.contacts;const deletion=new DeletionService(storage,new ActiveHolders(),new ManagedFiles(root));
 const operation=await deletion.plan({ownerId:owner,requestKey:'delete-avatar-contact',scope:{kind:'contact',contactId:first.contact_id}});
 assert.equal(await service.avatar(first.contact_id),null);const completed=await deletion.advance({ownerId:owner,operationId:operation.operationId});assert.equal(completed.state,'completed');
 assert.equal(await service.avatar(first.contact_id),null);assert.ok(await service.avatar(second.contact_id));
});

test('头像规范化只接收有限的本地位图，无网络获取入口',async()=>{
 const input=await localImage(),signal=new AbortController().signal;
 const result=await normalizeContactAvatar(input,signal);const info=await sharp(Buffer.from(result.base64,'base64')).metadata();
 assert.equal(info.format,'png');assert.equal(info.width,96);assert.equal(info.height,96);assert.equal(info.exif,undefined);
 for(const bad of [{mimeType:'image/svg+xml',dataBase64:'PHN2Zy8+'},{...input,dataBase64:Buffer.alloc(262145).toString('base64')},{...input,dataBase64:'AQID'},{...input,dataBase64:input.dataBase64+'\n'}])assert.equal(await normalizeContactAvatar(bad,signal),null);
});

test('头像随同步唤醒并行补齐，失败隔离并复用后续历史周期重试',async()=>{
 let now=0,fail=true;const calls=[];
 const bindings=['a','b'].map(contact_id=>({contact_id,binding_id:contact_id,grant_id:contact_id,selection_generation:'1',status:'active'}));
 let settle;const finished=()=>new Promise(resolve=>{settle=resolve;});let waiting=finished();
 const sync=new ContactAvatarSynchronizer({syncDirectory:async()=>({read_enabled:true,bindings}),syncAvatar:async id=>{calls.push(id);if(calls.length%2===0)settle();return !fail;}},()=>now);
 try{
  sync.wake();await waiting;await new Promise(resolve=>setImmediate(resolve));await sync.stop();assert.deepEqual(calls.sort(),['a','b']);
  sync.wake();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
  now=60_000;fail=false;waiting=finished();sync.wake();await waiting;await new Promise(resolve=>setImmediate(resolve));await sync.stop();assert.equal(calls.length,4);
 }finally{await sync.close();}
});


test('已有54版数据库原地升级，联系人保留且新增头像表可用',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-avatar-upgrade-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const modulePath=join(root,'previous-registry.mjs');
 const registryUrl=new URL('../src/storage/sqlite/registry.ts',import.meta.url).href;
 await writeFile(modulePath,`import {registry as current} from ${JSON.stringify(registryUrl)};export const registry={...current,migrations:current.migrations.slice(0,54)};`);
 const previous=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:pathToFileURL(modulePath).href});
 const oldContacts=new SqliteContactService(previous,owner,{account:async()=>evidence,sessions:async()=>[{externalKey:'upgrade-friend',displayName:'升级前合成联系人',kind:'private',identityAssurance:'verified'}]});
 await oldContacts.initialize();const candidate=await oldContacts.detectAccount();await oldContacts.confirmAccount(candidate.candidate_token);const snapshot=await oldContacts.candidates(true);
 await oldContacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));
 const savedContacts=(await oldContacts.directory()).contacts,databaseId=previous.status.databaseId;assert.equal(savedContacts.length,1);
 assert.equal(previous.status.schemaVersion,54);await oldContacts.close();await previous.close();
 const upgraded=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});
 t.after(()=>upgraded.close());assert.equal(upgraded.status.schemaVersion,55);
 const contacts=new SqliteContactService(upgraded,owner,{});t.after(()=>contacts.close());
 assert.equal(await contacts.avatarRevision(),'0');assert.deepEqual((await contacts.directory()).contacts,savedContacts);
 assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('正式联系人确认入口立即同步新头像，状态修订通知已打开目录',{timeout:2500},async t=>{
 const f=await fixture(t),holders=new ActiveHolders();
 const lifetime=new ContactMetadataLifetime(f.storage,owner,holders,()=>f.metadata);await lifetime.initialize();lifetime.setReadStart(()=>{});
 const server=createServer(async(req,res)=>{try{if(!await lifetime.handle(req,res)){res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await lifetime.close();await new Promise(resolve=>server.close(resolve));});
 f.metadata.sessions=async()=>['friend-a','friend-b','friend-c'].map(externalKey=>({externalKey,displayName:'同名',kind:'private',identityAssurance:'verified'}));
 let addedId,committed;const saved=new Promise(resolve=>{committed=resolve;});const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input)=>{const result=await execute(name,input);if(name==='identity.confirm')addedId=result.bindings.find(binding=>binding.conversation_locator==='friend-c').contact_id;if(name==='identity.avatarSave'&&input.token.contact_id===addedId)committed();return result;};
 const origin=`http://127.0.0.1:${server.address().port}`;
 const snapshot=await(await fetch(origin+'/api/sync/cli-sessions',{headers:{'x-notalone-metadata-consent':'selected-list'}})).json();
 const row=snapshot.sessions.find(item=>item.username==='friend-c');
 const response=await fetch(origin+'/api/sync/cli-bindings/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({snapshot_token:snapshot.snapshot_token,history_authorized:true,selections:[{locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation}]})});
 assert.equal(response.status,200);
 await saved;assert.ok(f.calls.includes('friend-c'));assert.ok(await f.service.avatar(addedId));
 const status=await(await fetch(origin+'/api/sync/status')).json();assert.ok(BigInt(status.contact_avatar_revision)>0n);
});
