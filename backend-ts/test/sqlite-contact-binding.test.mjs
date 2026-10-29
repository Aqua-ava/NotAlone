import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
const owner='00000000-0000-4000-8000-000000000001';
async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-contact-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',...options});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const channel={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[
 {externalKey:'friend-a',displayName:'同名',kind:'private',identityAssurance:'verified'}, {externalKey:'friend-b',displayName:'同名',kind:'private',identityAssurance:'verified'}]};
 const service=new SqliteContactService(storage,owner,channel);await service.initialize();
 return {storage,service,channel,root};
}
async function connect(service){const candidate=await service.detectAccount();await service.confirmAccount(candidate.candidate_token);}
test('空库不预选，同名渠道身份分别建立联系人，重复确认幂等',async t=>{
 const {service}=await fixture(t);
 assert.deepEqual((await service.directory()).contacts,[]);
 await connect(service);
 const snapshot=await service.candidates(true);assert.equal(snapshot.sessions.length,2);
 const choice={locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'};
 const first=await service.confirm(snapshot.snapshot_token,[choice]);
 assert.equal(first.bindings.length,1);
 const repeated=await service.confirm(snapshot.snapshot_token,[choice]);
 assert.equal(repeated.bindings[0].binding_id,first.bindings[0].binding_id);
 const next=await service.candidates(true);
 await service.confirm(next.snapshot_token,[{...choice,locator:'friend-b'}]);
 const contacts=(await service.directory()).contacts;
 assert.equal(contacts.length,2);assert.notEqual(contacts[0].contact_id,contacts[1].contact_id);
});
test('仅身份旧基线未安装历史表时目录合法返回零消息，不要求正文能力',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-identity-only-count-'))),module=join(root,'identity-only.mjs');
 await writeFile(module,`import {registry as production} from ${JSON.stringify(new URL('../src/storage/sqlite/registry.ts',import.meta.url).href)};export const registry={migrations:production.migrations.filter(m=>m.version<=3),actions:production.actions.filter(a=>a.name.startsWith('identity.'))};`);
 let storage,service;t.after(async()=>{await service?.close();await storage?.close();await rm(root,{recursive:true,force:true});});
 storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:pathToFileURL(module).href});assert.equal(storage.status.schemaVersion,3);
 service=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[{externalKey:'friend-a',displayName:'合成身份',kind:'private',identityAssurance:'verified'}]});
 await service.initialize();await connect(service);const snapshot=await service.candidates(true);await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'合成身份',expected_selection_generation:'0'}]);
 const directory=await service.directory();assert.equal(directory.contacts.length,1);assert.deepEqual(directory.contacts[0].data_status,{message_count:0,source_count:0});
});
test('取消立即拒绝旧结果，重选沿用绑定但新许可不复活旧令牌',async t=>{
 const {service}=await fixture(t);await connect(service);await service.setReading(true);
 const snapshot=await service.candidates(true);const choice={locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'};
 const saved=(await service.confirm(snapshot.snapshot_token,[choice])).bindings[0];
 const old=await service.eligibility(saved.contact_id);
 await service.revoke(saved.contact_id,saved.binding_id,saved.selection_generation);
 await assert.rejects(service.validate(old),{code:'read_not_authorized'});
 await assert.rejects(service.confirm(snapshot.snapshot_token,[choice]),{code:'selection_stale'});
 const next=await service.candidates(true);
 const row=next.sessions.find(r=>r.username==='friend-a');
 const fresh=(await service.confirm(next.snapshot_token,[{...choice,expected_selection_generation:row.selection_generation}])).bindings[0];
 assert.equal(fresh.binding_id,saved.binding_id);assert.notEqual(fresh.grant_id,saved.grant_id);
 await assert.rejects(service.validate(old),{code:'read_eligibility_stale'});
 assert.equal((await service.directory()).contacts.length,1);
});
test('换账号同名同定位符也不继承联系人和授权',async t=>{
 const {service,channel}=await fixture(t);await connect(service);
 let snapshot=await service.candidates(true);
 await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}]);
 const old=(await service.directory()).bindings[0];
 channel.account=async()=>({externalKey:'other-account',identityScheme:'wechat.account.v1',sourceGeneration:'other-source',assurance:'verified',supportProfile:'synthetic-metadata-v1'});
 await connect(service);snapshot=await service.candidates(true);
 assert.equal(snapshot.sessions[0].selection_generation,'0');
 const fresh=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings.find(b=>b.status==='active');
 assert.notEqual(fresh.contact_id,old.contact_id);assert.notEqual(fresh.binding_id,old.binding_id);
});
test('确认前改名需重新读回并确认，不能使用旧名单创建身份',async t=>{
 const {service,channel}=await fixture(t);await connect(service);const snapshot=await service.candidates(true);
 channel.sessions=async()=>[{externalKey:'friend-a',displayName:'新名称',kind:'private',identityAssurance:'verified'}];
 await assert.rejects(service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}]),{code:'selection_stale'});
 assert.deepEqual((await service.directory()).contacts,[]);
});
test('列表同意、跨owner隔离、手动确认和未认证渠道不会产生新读取资格',async t=>{
 const {service,storage,channel}=await fixture(t);
 await assert.rejects(service.candidates(false),{code:'metadata_consent_required'});
 channel.account=async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'unverified',supportProfile:'unverified-metadata-v1'});
 const candidate=await service.detectAccount();
 await assert.rejects(service.confirmAccount(candidate.candidate_token),{code:'metadata_identity_unverified'});
 assert.equal((await service.directory()).account,null);
 channel.account=async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'});
 await connect(service);const snapshot=await service.candidates(true);
 const saved=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];
 await service.revoke(saved.contact_id,saved.binding_id,saved.selection_generation);
 const confirmation=await service.manualConfirm(saved.contact_id,'request-context');
 assert.equal(await service.manualConfirm(saved.contact_id,'request-context'),confirmation);
 await assert.rejects(service.eligibility(saved.contact_id),{code:'read_not_authorized'});
 const other=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000002',channel);await other.initialize();
 assert.deepEqual((await other.directory()).contacts,[]);
 await assert.rejects(other.manualConfirm(saved.contact_id,'request-context'),{code:'identity_not_found'});
 await assert.rejects(other.revoke(saved.contact_id,saved.binding_id,'2'),{code:'identity_not_found'});
});
test('并发确认幂等，重开不扩大选择，开关代次使旧读取令牌永久失效',async t=>{
 const {service}=await fixture(t);await connect(service);await service.setReading(true);const snapshot=await service.candidates(true);
 const choice={locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'};
 const result=await Promise.all([service.confirm(snapshot.snapshot_token,[choice]),service.confirm(snapshot.snapshot_token,[choice])]);
 assert.equal(result[0].bindings[0].grant_id,result[1].bindings[0].grant_id);
 const saved=result[0].bindings[0];const token=await service.eligibility(saved.contact_id);
 await service.setReading(false);await service.setReading(true);
 await assert.rejects(service.validate(token),{code:'read_eligibility_stale'});
 assert.equal((await service.directory()).bindings.filter(b=>b.status==='active').length,1);
});
test('真实写事务复验迟到结果，清空屏障不被取消重选解除且复合FK拒绝串联系人',async t=>{
 const {service,storage}=await fixture(t,{registryModule:new URL('./fixtures/contacts/registry.mjs',import.meta.url).href});
 await connect(service);await service.setReading(true);let snapshot=await service.candidates(true);
 await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'},{locator:'friend-b',observed_display_name:'同名',expected_selection_generation:'0'}]);
 const [a,b]=(await service.directory()).bindings;const token=await service.eligibility(a.contact_id);
 await storage.execute('fixture.acceptResult',{token,id:'before'});
 await assert.rejects(storage.execute('fixture.tryGrant',{...token,id:'wrong-contact',contact_id:b.contact_id}));
 await assert.rejects(storage.execute('fixture.tryGrant',{...token,id:'wrong-owner',owner_id:'other-owner'}));
 await storage.execute('fixture.advanceBarrier',token);
 await assert.rejects(storage.execute('fixture.acceptResult',{token,id:'late'}),{code:'read_eligibility_stale'});
 await service.revoke(a.contact_id,a.binding_id,a.selection_generation);
 await assert.rejects(storage.execute('fixture.reopenGrant',token));
 snapshot=await service.candidates(true);const row=snapshot.sessions.find(r=>r.username===a.conversation_locator);
 await service.confirm(snapshot.snapshot_token,[{locator:a.conversation_locator,observed_display_name:'同名',expected_selection_generation:row.selection_generation}]);
 assert.equal((await storage.execute('fixture.readBarrier',token)).barrier_generation,1n);
 const fresh=await service.eligibility(a.contact_id);await storage.execute('fixture.acceptResult',{token:fresh,id:'new'});
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('低置信度、重复稳定身份和来源不连续均拒绝身份猜测',async t=>{
 const {service,channel}=await fixture(t);await connect(service);
 channel.sessions=async()=>[{externalKey:'friend-a',displayName:'同名',kind:'private',identityAssurance:'unverified'}];
 await assert.rejects(service.candidates(true),{code:'metadata_identity_unverified'});
 await connect(service);
 channel.sessions=async()=>[{externalKey:'friend-a',displayName:'同名',kind:'private',identityAssurance:'verified'},{externalKey:'friend-a',displayName:'另一名称',kind:'private',identityAssurance:'verified'}];
 await assert.rejects(service.candidates(true),{code:'metadata_identity_conflict'});
 channel.account=async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-2',assurance:'verified',supportProfile:'synthetic-metadata-v1'});
 await assert.rejects(service.candidates(true),{code:'account_identity_changed'});
 const candidate=await service.detectAccount();
 await assert.rejects(service.confirmAccount(candidate.candidate_token),{code:'identity_continuity_unverified'});
 assert.deepEqual((await service.directory()).contacts,[]);
});
import {createServer} from 'node:http';
import {SqliteContactHttp} from '../src/contacts/sqlite/http.ts';
import {authorizeSqliteRequest} from '../src/sqlite-host-plugin.ts';
test('认证HTTP按旧页面合同读回选择及撤销，缺同意/跨owner字段/跳过历史均拒绝',async t=>{
 const {service}=await fixture(t);const api=new SqliteContactHttp(service);const token='synthetic-bearer';
 const server=createServer(async(req,res)=>{
  if(!authorizeSqliteRequest(req,token)){res.writeHead(401).end();return;}
  if(!await api.handle(req,res))res.writeHead(404).end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=async(path,body,headers={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:response.status===401?null:await response.json()};};
 assert.equal((await request('/api/contacts',undefined,{Authorization:'wrong'})).status,401);
 assert.equal((await request('/api/contacts',undefined,{Origin:'http://localhost'})).status,401);
 assert.equal((await request('/api/sync/cli-sessions')).status,409);
 const candidate=(await request('/api/setup/wechat/detect',{})).body;
 assert.equal((await request('/api/setup/wechat/confirm',{candidate_token:candidate.candidate_token,confirmed:true,mode:'all_private',history_authorized:true})).status,400);
 assert.equal((await request('/api/setup/wechat/confirm',{candidate_token:candidate.candidate_token,confirmed:true,mode:'selected',history_authorized:false})).status,200);
 const snapshot=(await request('/api/sync/cli-sessions',undefined,{'X-NotAlone-Metadata-Consent':'selected-list'})).body;
 const body={snapshot_token:snapshot.snapshot_token,selections:[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}],history_authorized:true};
 assert.equal((await request('/api/sync/cli-bindings/confirm',{...body,owner_id:'other-owner'})).status,400);
 assert.equal((await request('/api/sync/cli-bindings/confirm',{...body,history_authorized:false})).status,400);
 assert.equal((await request('/api/sync/cli-bindings/confirm',body)).status,200);
 const binding=(await request('/api/sync/cli-bindings')).body.bindings[0];
 assert.equal((await request('/api/contacts')).body.contacts.length,1);
 assert.equal((await request('/api/sync/cli-bindings/revoke',{contact_id:binding.contact_id,binding_id:binding.binding_id,expected_selection_generation:binding.selection_generation})).status,200);
 const manual=await request(`/api/contacts/${binding.contact_id}/manual-confirmation`,{});assert.equal(manual.status,200);assert.equal(manual.body.confirmed,true);
 const directory=(await request('/api/sync/cli-bindings')).body;assert.equal(directory.bindings.length,0);assert.equal(directory.revoked_bindings[0].binding_id,binding.binding_id);
});
test('已授权会话出现低置信度证据时旧读取令牌立即失效',async t=>{
 const {service,channel}=await fixture(t);await connect(service);await service.setReading(true);const snapshot=await service.candidates(true);
 const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];const token=await service.eligibility(b.contact_id);
 channel.sessions=async()=>[{externalKey:'friend-a',displayName:'同名',kind:'private',identityAssurance:'unverified'}];
 await assert.rejects(service.candidates(true),{code:'metadata_identity_unverified'});
 await assert.rejects(service.validate(token),{code:'read_not_authorized'});
});
test('检测或确认时发现来源换代也须撤销旧资格，拒绝结果不能回滚封禁',async t=>{
 const {service,channel}=await fixture(t);await connect(service);await service.setReading(true);const snapshot=await service.candidates(true);
 const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];const token=await service.eligibility(b.contact_id);
 channel.account=async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-2',assurance:'verified',supportProfile:'synthetic-metadata-v1'});
 const candidate=await service.detectAccount();await assert.rejects(service.confirmAccount(candidate.candidate_token),{code:'identity_continuity_unverified'});
 await assert.rejects(service.validate(token),{code:'read_not_authorized'});
});
test('已授权稳定身份改为非私聊时必须撤销旧资格',async t=>{
 const {service,channel}=await fixture(t);await connect(service);await service.setReading(true);const snapshot=await service.candidates(true);
 const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];const token=await service.eligibility(b.contact_id);
 channel.sessions=async()=>[{externalKey:'friend-a',displayName:'同名',kind:'group',identityAssurance:'verified'}];
 await assert.rejects(service.candidates(true),{code:'metadata_identity_conflict'});await assert.rejects(service.validate(token),{code:'read_not_authorized'});
});
test('删除authority用实际资料代次封禁旧写者，清空不取消同步，整账号撤销全部读取',async t=>{
 const {service,storage}=await fixture(t,{registryModule:new URL('./fixtures/contacts/registry.mjs',import.meta.url).href});await connect(service);await service.setReading(true);
 const snapshot=await service.candidates(true);const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];
 const token=await service.eligibility(b.contact_id);
 const clear=await storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind:'contact_history',contactId:b.contact_id}});
 await assert.rejects(storage.execute('fixture.acceptResult',{token,id:'late-clear'}),{code:'read_eligibility_stale'});
 assert.equal((await storage.execute('fixture.verifyFence',clear)).result,'passed');
 assert.equal((await service.directory()).bindings[0].status,'active');
 const fresh=await service.eligibility(b.contact_id);await storage.execute('fixture.acceptResult',{token:fresh,id:'after-clear'});
 const account=await storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind:'account'}});
 await assert.rejects(service.eligibility(b.contact_id),{code:'read_not_authorized'});
 assert.equal((await storage.execute('fixture.verifyFence',account)).result,'passed');
});
test('重新打开同一SQLite只读回合法选择，不访问渠道或纳入新私聊',async t=>{
 const {service,storage,channel,root}=await fixture(t);await connect(service);const snapshot=await service.candidates(true);
 const saved=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];
 const databaseId=storage.status.databaseId;await service.close();await storage.close();
 const reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 let touched=false;const next=new SqliteContactService(reopened,owner,{...channel,account:async()=>{touched=true;throw new Error('不应读取渠道');},sessions:async()=>{touched=true;throw new Error('不应读取名单');}});await next.initialize();
 const directory=await next.directory();assert.equal(directory.contacts.length,1);assert.equal(directory.bindings[0].binding_id,saved.binding_id);assert.equal(directory.bindings[0].grant_id,saved.grant_id);assert.equal(directory.read_enabled,false);assert.equal(touched,false);
});
test('身份删除domain清理证明和展示资料，保留稳定墓碑阻止普通重选复活',async t=>{
 const {service,storage}=await fixture(t,{registryModule:new URL('./fixtures/contacts/registry.mjs',import.meta.url).href});await connect(service);await service.setReading(true);
 const snapshot=await service.candidates(true);const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];
 await service.manualConfirm(b.contact_id,'before-delete');
 const operation=await storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind:'contact',contactId:b.contact_id}});
 const checks=await storage.execute('fixture.cleanIdentity',operation);assert.equal(checks.database_rows.result,'passed');assert.equal(checks.request_replay.result,'passed');
 assert.deepEqual((await service.directory()).contacts,[]);
 const next=await service.candidates(true);assert.equal(await storage.execute('fixture.conversationName',{ownerId:owner,locator:'friend-a'}),null);await assert.rejects(service.confirm(next.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}]),{code:'binding_identity_conflict'});
 const account=await storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind:'account'}});assert.equal((await storage.execute('fixture.cleanIdentity',account)).database_rows.result,'passed');
 await assert.rejects(service.setReading(true),{code:'identity_not_found'});const candidate=await service.detectAccount();await assert.rejects(service.confirmAccount(candidate.candidate_token),{code:'identity_not_found'});
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('身份authority拒绝讨论与媒体范围，不用联系人全域代次冒充精确删除',async t=>{
 const {storage}=await fixture(t,{registryModule:new URL('./fixtures/contacts/registry.mjs',import.meta.url).href});
 for(const kind of ['discussion','media_result_clear','media_result_replace'])await assert.rejects(storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind,contactId:'00000000-0000-4000-8000-000000000002'}}),{code:'identity_deletion_scope_invalid'});
});
test('更高合法清理代次仍证明旧writer失效，旧操作仅清固定旧确认不命中新确认',async t=>{
 const {service,storage}=await fixture(t,{registryModule:new URL('./fixtures/contacts/registry.mjs',import.meta.url).href});await connect(service);const snapshot=await service.candidates(true);
 const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];
 await service.manualConfirm(b.contact_id,'old-context');
 const first=await storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind:'contact_history',contactId:b.contact_id}});
 const newer=await service.manualConfirm(b.contact_id,'new-context');
 await storage.execute('fixture.fenceIdentity',{ownerId:owner,scope:{kind:'contact_history',contactId:b.contact_id}});
 assert.equal((await storage.execute('fixture.verifyFence',first)).result,'passed');
 const checks=await storage.execute('fixture.cleanIdentity',first);assert.equal(checks.database_rows.result,'passed');
 assert.equal(await storage.execute('fixture.confirmationExists',{ownerId:owner,id:newer}),true);
});
test('会话元数据端口失败时暂停旧资格，不能只拒绝新名单',async t=>{
 const {service,channel}=await fixture(t);await connect(service);await service.setReading(true);const snapshot=await service.candidates(true);
 const b=(await service.confirm(snapshot.snapshot_token,[{locator:'friend-a',observed_display_name:'同名',expected_selection_generation:'0'}])).bindings[0];const token=await service.eligibility(b.contact_id);
 channel.sessions=async()=>{throw new Error('合成外部端口失败');};await assert.rejects(service.candidates(true));await assert.rejects(service.validate(token),{code:'read_not_authorized'});
});
