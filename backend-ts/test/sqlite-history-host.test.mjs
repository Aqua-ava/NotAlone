import test from 'node:test';
import assert from 'node:assert/strict';
import {readSqliteCapabilities} from '../src/sqlite-capabilities.ts';

test('SQLite能力按contacts、可选skills、可选history读取，拒绝重排与额外字段',()=>{
 const root='/tmp/notalone-synthetic-root';
 assert.deepEqual(readSqliteCapabilities(['contacts','history'],undefined,root),{capabilities:['contacts','history']});
 assert.deepEqual(readSqliteCapabilities(['contacts','skills','history'],root+'/skill-packages',root),{capabilities:['contacts','skills','history'],skillPackageRoot:root+'/skill-packages'});
 for(const capabilities of [['history'],['contacts','history','skills'],['contacts','history','history'],['contacts','skills','unknown'],['contacts','skills,history']])assert.equal(readSqliteCapabilities(capabilities,root+'/skill-packages',root),undefined);
 assert.equal(readSqliteCapabilities(['contacts','history'],root+'/skill-packages',root),undefined);
});

import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('Skill根允许位于App数据目录外，仍拒绝受管区与无效路径',()=>{
 const userData=path.join(tmpdir(),'notalone-synthetic-app');
 const skillPackageRoot=path.join(tmpdir(),'notalone-synthetic-repository','reply-skills');
 const capabilities=['contacts','skills'];
 assert.deepEqual(readSqliteCapabilities(capabilities,skillPackageRoot,userData),{capabilities,skillPackageRoot});
 for(const root of [userData,path.join(userData,'managed'),path.join(userData,'managed','skills'),'relative/skills',path.join(userData,'skills')+'/../other']){
  assert.equal(readSqliteCapabilities(capabilities,root,userData),undefined);
 }
});

import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {launchDsh} from '../src/launch.ts';
import {waitForHostReady} from './host-readiness-support.mjs';
const owner='00000000-0000-4000-8000-000000000063';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
const createMetadata=()=>({account:async()=>evidence,sessions:async()=>['a','b','c'].map(name=>({externalKey:`friend-${name}`,displayName:`合成${name}`,kind:'private',identityAssurance:'verified'}))});
function createChannel(options={}){
 return {inspect:async scope=>({protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'source-1',serverAliasSemantics:'unverified'}),
 target:async()=>({protocol:'private-history-v1',descriptor:'synthetic-target',partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source-1'}),
  page:async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,completedPartitions:['p'],exhausted:true,records:[['1','text','合成历史'],['2','voice',null]].map(([localId,kind,text])=>({partition:'p',table:'t',localId,serverId:'0',sender:'contact',kind,text,originalType:kind==='text'?'1':'34',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,status:'0',stateAssurance:'verified'}))})};
}
async function seed(t,options={}){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-history-host-')));let storage,contacts,history;
  t.after(async()=>{
   const failures=[];
   for(const close of [()=>history?.close(),()=>contacts?.close(),()=>storage?.close()])try{await close();}catch(error){failures.push(error);}
   if(failures.length)throw new AggregateError(failures,'history seed resource close failed; preserve synthetic root for diagnosis');
   await rm(root,{recursive:true,force:true});
  });
  storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});const databaseId=storage.status.databaseId;
  contacts=new SqliteContactService(storage,owner,createMetadata());await contacts.initialize();const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})));
 const bindings=(await contacts.directory()).bindings;
  history=new SqliteHistoryService(storage,contacts,createChannel(options));for(const binding of bindings)await history.synchronize(binding.contact_id);
 const source=(await history.read(bindings[0].contact_id)).messages.find(message=>message.kind==='text').sourceRecordIds[0];
  await history.close();history=undefined;await contacts.close();contacts=undefined;await storage.close();storage=undefined;return {root,databaseId,bindings,source};
}
async function startHost(t,f,environment={}){
 const infoPath=path.join(f.root,'managed/sqlite-backend.info');
 const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:new URL('../../',import.meta.url).pathname,envFilePath:path.join(f.root,'unused.env'),infoPath,businessHome:f.root,environment,sqlite:{userData:f.root,expectedDatabaseId:f.databaseId,role:'test',capabilities:['contacts','history']}},()=>true);t.after(()=>host.terminate());
 const info=await waitForHostReady(host,infoPath);
 const request=async(route,method='GET',body,headers={})=>{const response=await fetch(`http://${info.address}`+route,{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
 return {host,request};
}
test('正式前台观察HTTP保留账号范围失效原因，不误报为观察传输失败',async t=>{
 const f=await seed(t);
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:f.databaseId,role:'test'});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({...evidence,externalKey:'changed-synthetic-account'}),sessions:async()=>[]});
 try{await contacts.detectAccount();}finally{await contacts.close();await storage.close();}
 const {host,request}=await startHost(t,f,{NOTALONE_SYNC_PROBE:process.execPath});
 try{
  const result=await request('/api/sync/foreground/observe','POST',{});
  assert.equal(result.status,503);
  assert.deepEqual(result.body,{error:'foreground_scope_unavailable'});
  const confirmation=await request('/api/sync/foreground/confirm','POST',{contact_id:f.bindings[0].contact_id,observation_id:'00000000-0000-4000-8000-000000000001'});
  assert.equal(confirmation.status,503);assert.deepEqual(confirmation.body,{error:'sqlite_capability_unavailable'});
  const injected=await request('/api/sync/foreground/confirm','POST',{contact_id:f.bindings[0].contact_id,observation_id:'00000000-0000-4000-8000-000000000001',recognized_name:'页面不得提供名称事实'});
  assert.equal(injected.status,503);assert.deepEqual(injected.body,{error:'sqlite_capability_unavailable'});
 }finally{await request('/api/runtime/shutdown','POST',{});assert.equal(await host.waitForExit(15000),true);}
});
test('正式DSH重开读取非空历史及消息分页，真实未认证渠道保持明确拒绝',async t=>{
 const f=await seed(t);
 for(let attempt=0;attempt<2;attempt++){
  const {host,request}=await startHost(t,f);const runtime=await request('/api/runtime/status');assert.deepEqual(runtime.body.capabilities,['contacts','history']);assert.equal(runtime.body.ownership.wechatHistory,'typescript');
  const contact=f.bindings[0].contact_id;const first=await request(`/api/contacts/${contact}/history-messages?limit=1`);assert.equal(first.status,200);assert.equal(first.body.messages.length,1);assert.ok(first.body.next_cursor);assert.equal(first.body.messages[0].text,null);
  const second=await request(`/api/contacts/${contact}/history-messages?limit=1&before=${first.body.next_cursor}`);assert.equal(second.body.messages[0].text,'合成历史');
  const sync=await request('/api/sync/status');assert.equal(sync.status,200);assert.equal(sync.body.body_available,false);assert.equal(sync.body.cli_history_coverages.length,3);assert.ok(sync.body.cli_history_coverages.every(row=>row.phase==='complete'));
  const denied=await request(`/api/contacts/${contact}/history/sync`,'POST',{});assert.equal(denied.status,503);assert.equal(denied.body.error,'history_support_unverified');
  assert.equal((await request('/api/runtime/shutdown','POST',{})).body.state,'stopped');assert.equal(await host.waitForExit(15000),true);
 }
});

test('正式宿主来源、联系人、账号删除均经过history闭包，元数据重开不抓旧服务',async t=>{
 const f=await seed(t);const {host,request}=await startHost(t,f);const [a,b,c]=f.bindings;
 const source=await request(`/api/contacts/${a.contact_id}/sources/${f.source}`,'DELETE',{});assert.equal(source.status,202);assert.ok(source.body.operation_id);
 assert.equal((await request(`/api/deletions/${source.body.operation_id}`)).body.state,'completed');
 const remaining=await request(`/api/contacts/${a.contact_id}/history-messages`);assert.equal(remaining.status,200);assert.equal(remaining.body.messages.length,1);assert.ok(remaining.body.messages.every(message=>!message.source_record_ids.includes(f.source)));
 const contact=await request(`/api/contacts/${b.contact_id}`,'DELETE',{confirmed:true,confirm_contact_id:b.contact_id});assert.equal(contact.status,202);assert.equal((await request(`/api/deletions/${contact.body.operation_id}`)).body.state,'completed');
 assert.equal((await request(`/api/contacts/${b.contact_id}/history-messages`)).status,404);
 const afterReopen=await request(`/api/contacts/${c.contact_id}/history/sync`,'POST',{});assert.equal(afterReopen.status,503);assert.equal(afterReopen.body.error,'history_support_unverified');
 const account=await request('/api/account','DELETE',{confirmed:true,confirm_scope:'account'},{'idempotency-key':'synthetic-history-account'});assert.equal(account.status,202);assert.equal((await request(`/api/deletions/${account.body.operation_id}`)).body.state,'completed');
 assert.equal((await request(`/api/contacts/${c.contact_id}/history-messages`)).status,404);
 await request('/api/runtime/shutdown','POST',{});assert.equal(await host.waitForExit(15000),true);
});

import {ContactMetadataLifetime} from '../src/storage/sqlite/deletion/contact-metadata.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {createServer} from 'node:http';

test('inspect和target尚无goal的渠道读者也由共享holder排空，未释放不得完成删除',async t=>{
 for(const stage of ['inspect','target'])await t.test(stage,async t=>{
  const f=await seed(t);const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:f.databaseId,role:'test'});const holders=new ActiveHolders();
  const contacts=new ContactMetadataLifetime(storage,owner,holders,createMetadata);await contacts.initialize();
  let began;const started=new Promise(resolve=>{began=resolve;});let release;const physicalClose=new Promise(resolve=>{release=resolve;});let pendingRead;let closed=0;
  const channel=createChannel();const inspect=channel.inspect;const target=channel.target;
  channel[stage]=async(...args)=>{began();return new Promise(resolve=>{pendingRead=()=>resolve(stage==='inspect'?inspect(...args):target(...args));});};
  channel.close=async()=>{await physicalClose;closed++;pendingRead?.();};
  const history=new SqliteHistoryService(storage,contacts,channel,holders);const deletion=new DeletionService(storage,holders,new ManagedFiles(f.root),{drainTimeoutMs:20});
  const run=history.synchronize(f.bindings[0].contact_id);run.catch(()=>{});await started;
  try{
   const plan=await deletion.plan({ownerId:owner,requestKey:`early-reader-${stage}`,scope:{kind:'source',contactId:f.bindings[0].contact_id,sourceId:f.source}});
   assert.ok(plan.targets.some(item=>item.target?.holderKeys.some(key=>key.startsWith('history:read_'))));
   assert.equal((await deletion.advance(plan)).state,'blocked');assert.equal(closed,0);
   release();await assert.rejects(run,{code:'history_interrupted'});assert.equal(closed,1);
   assert.equal((await deletion.advance(plan)).state,'completed');
  }finally{release();await run.catch(()=>{});await history.close();await contacts.close();await storage.close();}
 });
});

test('现有撤销与总开关HTTP在持久撤资格后等待对应渠道退出，保留其他读者',async t=>{
 const f=await seed(t);const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:f.databaseId,role:'test'});const holders=new ActiveHolders();
 const contacts=new ContactMetadataLifetime(storage,owner,holders,createMetadata);await contacts.initialize();const pending=new Map();const started=new Map();const closed=[];
 const history=new SqliteHistoryService(storage,contacts,()=>{let scope;return {inspect:async current=>{scope=current;started.get(current.token.contact_id)?.();return new Promise(resolve=>pending.set(current.token.contact_id,()=>resolve(createChannel().inspect(current))));},target:createChannel().target,page:createChannel().page,close:async()=>{if(scope){closed.push(scope.token.contact_id);pending.get(scope.token.contact_id)?.();}}};},holders);
 contacts.setReadStop(contactId=>history.stop(contactId));
 const server=createServer(async(req,res)=>{if(!await contacts.handle(req,res))res.writeHead(404).end();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 const [a,b]=f.bindings;const reads=[];
 try{
  for(const binding of [a,b]){let began;const ready=new Promise(resolve=>{began=resolve;});started.set(binding.contact_id,began);const run=history.synchronize(binding.contact_id);run.catch(()=>{});reads.push(run);await ready;}
  assert.equal((await request('/api/sync/cli-bindings/revoke',{contact_id:a.contact_id,binding_id:a.binding_id,expected_selection_generation:a.selection_generation})).status,200);await assert.rejects(reads[0],{code:'history_interrupted'});assert.deepEqual(closed,[a.contact_id]);
  assert.equal((await request('/api/sync/disable',{})).status,200);await assert.rejects(reads[1],{code:'history_interrupted'});assert.deepEqual(closed,[a.contact_id,b.contact_id]);
  await assert.rejects(history.synchronize(b.contact_id),{code:'read_not_authorized'});
 }finally{await history.close();await Promise.allSettled(reads);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await contacts.close();await storage.close();}
});

test('宿主增量协调器随读取开关/退出启停，真实渠道未提供增量能力时可见拒绝且不写入',async t=>{
 const f=await seed(t,{tailHandoff:true});
 const {host,request}=await startHost(t,f);const contact=f.bindings[0].contact_id;
 // 真实适配器未认证且没有增量尾部能力：交接检查点存在也不得读取或声称已同步。
 const status=await request('/api/sync/status');assert.equal(status.status,200);
 const row=status.body.cli_history_coverages.find(item=>item.contact_id===contact);
 assert.ok(row);assert.equal(row.phase,'complete','历史覆盖本身仍显示已完成');
 assert.ok(['blocked','incomplete','unavailable'].includes(row.incremental_phase),'增量不得伪报已同步');
 assert.ok(['history_tail_unsupported','history_support_unverified','history_incremental_unavailable'].includes(row.incremental_failure_code));
 assert.deepEqual((await request(`/api/contacts/${contact}/history-messages`)).body.messages.filter(message=>message.text!==null).map(message=>message.text),['合成历史']);
 // 关闭总开关：停止协调器，保留资料与选择。
 const disabled=await request('/api/sync/disable','POST',{});assert.equal(disabled.status,200);assert.equal(disabled.body.sync_enabled,false);
 const after=await request('/api/sync/status');assert.equal(after.body.sync_enabled,false);
 assert.equal((await request(`/api/contacts/${contact}/history-messages`)).body.messages.filter(message=>message.text!==null).length,1);
 await request('/api/runtime/shutdown','POST',{});assert.equal(await host.waitForExit(15000),true);
});
