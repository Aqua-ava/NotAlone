import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {SqliteDeletionHttp} from '../src/storage/sqlite/deletion/http.ts';
import {ContactMetadataLifetime} from '../src/storage/sqlite/deletion/contact-metadata.ts';
const ownerId='00000000-0000-4000-8000-000000000055';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
async function fixture(t,createMetadata,unblock=()=>{}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-metadata-delete-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 const holders=new ActiveHolders();
 const contacts=new ContactMetadataLifetime(storage,ownerId,holders,createMetadata);await contacts.initialize();
 const deletion=new DeletionService(storage,holders,new ManagedFiles(root),{drainTimeoutMs:20});
 const http=new SqliteDeletionHttp(deletion,ownerId);
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer synthetic-only'){res.writeHead(401).end();return;}
  if(!await http.handle(req,res)&&!await contacts.handle(req,res))res.writeHead(404).end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{unblock();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await contacts.close();await storage.close();await rm(root,{recursive:true,force:true});});
 const request=async(path,method='GET',body,headers={})=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method,headers:{authorization:'Bearer synthetic-only','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
 };
 return {request,deletion,storage};
}
test('账号删除等待真实元数据持有者，迟到读取不返回旧账号候选且删除后不重装',async t=>{
 let release,started,closed=0,reads=0,created=0;
 const pending=new Promise(resolve=>{release=resolve;});const began=new Promise(resolve=>{started=resolve;});
 const f=await fixture(t,()=>{created++;return {account:async()=>{reads++;started();return pending;},sessions:async()=>[],close:async()=>{closed++;}};},()=>release(evidence));
 const late=f.request('/api/setup/wechat/detect','POST',{});await began;
 try{
  const op=await f.deletion.plan({ownerId,requestKey:'close-pending',scope:{kind:'account'}});
  assert.equal((await f.deletion.advance(op)).state,'blocked');assert.equal(closed,1);
  release(evidence);
  const result=await late;assert.equal(result.body.account_id,null);assert.equal(result.body.candidate_token,null);
  assert.equal((await f.deletion.advance(op)).state,'completed');
  const retrigger=await f.request('/api/setup/wechat/detect','POST',{});
  assert.equal(retrigger.body.account_id,null);assert.equal(reads,1);assert.equal(created,1);
 }finally{release(evidence);await late;}
});
test('联系人删除清掉账号候选与跨联系人预览，重建空服务而保留其他已授权联系人',async t=>{
 let closed=0,reads=0;
 const f=await fixture(t,()=>({account:async()=>{reads++;return evidence;},sessions:async()=>[
  {externalKey:'synthetic-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},
  {externalKey:'synthetic-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}],close:async()=>{closed++;}}));
 const candidate=(await f.request('/api/setup/wechat/detect','POST',{})).body;
 assert.equal((await f.request('/api/setup/wechat/confirm','POST',{candidate_token:candidate.candidate_token,confirmed:true,mode:'selected',history_authorized:false})).status,200);
 const snapshot=(await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'})).body;
 const confirmation={snapshot_token:snapshot.snapshot_token,selections:snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})),history_authorized:true};
 assert.equal((await f.request('/api/sync/cli-bindings/confirm','POST',confirmation)).status,200);
 const before=(await f.request('/api/contacts')).body.contacts;const contact=before.find(row=>row.display_name==='合成甲').contact_id;const sibling=before.find(row=>row.display_name==='合成乙').contact_id;
 const response=await f.request(`/api/contacts/${contact}`,'DELETE',{confirmed:true,confirm_contact_id:contact});
 assert.equal(response.status,202);assert.equal(closed,1);
 const completed=await f.request(`/api/deletions/${response.body.operation_id}`);
 assert.equal(completed.body.state,'completed');assert.equal(completed.body.scope_kind,'contact');
 assert.equal(completed.body.status,'succeeded');assert.equal(typeof completed.body.finished_at,'string');
 assert.ok(completed.body.checks.some(check=>check.kind==='final_recheck'&&check.result==='passed'));
 assert.ok(completed.body.checks.every(check=>['passed','not_applicable'].includes(check.result)));
 assert.equal(Object.hasOwn(completed.body,'contact_id'),false);
 const listed=(await f.request('/api/deletions')).body.operations.find(row=>row.operation_id===response.body.operation_id);
 assert.equal(listed.state,'completed');assert.equal(listed.scope_kind,'contact');
 const remaining=(await f.request('/api/contacts')).body.contacts;assert.deepEqual(remaining.map(row=>row.contact_id),[sibling]);
 const oldReads=reads;
 const oldCandidate=await f.request('/api/setup/wechat/confirm','POST',{candidate_token:candidate.candidate_token,confirmed:true,mode:'selected',history_authorized:false});
 assert.equal(oldCandidate.body.error,'account_candidate_stale');
 assert.equal((await f.request('/api/sync/cli-bindings/confirm','POST',confirmation)).body.error,'selection_stale');
 assert.equal(reads,oldReads);
 const fresh=(await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'})).body;
 const deletedSession=fresh.sessions.find(row=>row.username==='synthetic-a');
 assert.equal(deletedSession.bound_contact_id,null);
 assert.equal(deletedSession.known_contact_id,null);
 const explicit=await f.request('/api/sync/cli-bindings/confirm','POST',{snapshot_token:fresh.snapshot_token,history_authorized:true,
  selections:[{locator:deletedSession.username,display_name:deletedSession.display_name,observed_display_name:deletedSession.display_name,
   expected_selection_generation:deletedSession.selection_generation}]});
 assert.equal(explicit.status,200,JSON.stringify(explicit.body));
 const restored=(await f.request('/api/sync/cli-bindings')).body.bindings.find(row=>row.conversation_locator==='synthetic-a');
 assert.ok(restored);
 assert.notEqual(restored.contact_id,contact);
 assert.equal(restored.display_name,'合成甲');
 const preview=(await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'})).body.sessions.find(row=>row.username==='synthetic-a');
 assert.equal(preview.known_contact_id,restored.contact_id);
 assert.equal(preview.display_name,'合成甲');
 assert.equal((await f.request('/api/sync/enable','POST',{})).status,200);
 assert.equal((await f.storage.execute('identity.eligibility',{ownerId,contactId:restored.contact_id})).contact_id,restored.contact_id);
 const activeBinding=(await f.request('/api/sync/cli-bindings')).body.bindings.find(row=>row.contact_id===restored.contact_id);
 assert.ok(activeBinding);
 assert.equal((await f.request('/api/sync/disable','POST',{})).status,200);
 await assert.rejects(f.storage.execute('identity.eligibility',{ownerId,contactId:restored.contact_id}),{code:'read_not_authorized'});
 assert.equal((await f.request('/api/sync/cli-bindings/revoke','POST',{contact_id:restored.contact_id,binding_id:activeBinding.binding_id,
  expected_selection_generation:activeBinding.selection_generation})).status,200);
 const stopped=(await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'})).body;
 const stoppedSession=stopped.sessions.find(row=>row.username==='synthetic-a');
 assert.equal(stoppedSession.bound_contact_id,null);
 assert.equal(stoppedSession.known_contact_id,restored.contact_id);
 assert.equal((await f.request('/api/sync/cli-bindings/confirm','POST',{snapshot_token:stopped.snapshot_token,history_authorized:true,
  selections:[{locator:stoppedSession.username,contact_id:restored.contact_id,observed_display_name:stoppedSession.display_name,
   expected_selection_generation:stoppedSession.selection_generation}]})).status,200);
 const reselected=(await f.request('/api/sync/cli-bindings')).body.bindings.find(row=>row.conversation_locator==='synthetic-a');
 assert.equal(reselected.contact_id,restored.contact_id);
 assert.equal(reselected.display_name,'合成甲');
 assert.equal((await f.request('/api/sync/enable','POST',{})).status,200);
 assert.equal((await f.storage.execute('identity.eligibility',{ownerId,contactId:restored.contact_id})).contact_id,restored.contact_id);
 const afterExplicit=(await f.request('/api/contacts')).body.contacts;
 assert.ok(afterExplicit.some(row=>row.contact_id===restored.contact_id));
 assert.ok(!afterExplicit.some(row=>row.contact_id===contact));
 const replay=await f.request(`/api/contacts/${contact}`,'DELETE',{confirmed:true,confirm_contact_id:contact});
 assert.equal(replay.body.operation_id,response.body.operation_id);
 const afterReplay=(await f.request('/api/contacts')).body.contacts;
 assert.ok(afterReplay.some(row=>row.contact_id===restored.contact_id));
 assert.ok(afterReplay.some(row=>row.contact_id===sibling));
});

async function seeded(f) {
 const candidate=(await f.request('/api/setup/wechat/detect','POST',{})).body;
 await f.request('/api/setup/wechat/confirm','POST',{candidate_token:candidate.candidate_token,confirmed:true,mode:'selected',history_authorized:false});
 const snapshot=(await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'})).body;
 await f.request('/api/sync/cli-bindings/confirm','POST',{snapshot_token:snapshot.snapshot_token,selections:snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})),history_authorized:true});
 const contacts=(await f.request('/api/contacts')).body.contacts;
 return {contact:contacts.find(row=>row.display_name==='合成甲').contact_id,sibling:contacts.find(row=>row.display_name==='合成乙').contact_id};
}

test('名单准入只在联系人已封禁后提前放行，封禁前与账户删除仍关闭', async t => {
 const f=await fixture(t,()=>({account:async()=>evidence,sessions:async()=>[
  {externalKey:'synthetic-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},
  {externalKey:'synthetic-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}],close:async()=>{}}));
 const {contact}=await seeded(f);
 const admission=()=>f.storage.execute('deletion.metadataAdmission',{ownerId});
 const strict=()=>f.storage.execute('deletion.metadataAvailable',{ownerId});
 assert.deepEqual(await admission(),{available:true,writable:true,admittedOperations:[]});
 assert.equal(await strict(),true);
 const op=await f.deletion.plan({ownerId,requestKey:'admission-contact',scope:{kind:'contact',contactId:contact}});
 // 严格门禁仍把未完成的联系人删除视为不可用；读侧准入因联系人已置 deleting 提前放行。
 assert.equal(await strict(),false);
 assert.deepEqual(await admission(),{available:true,writable:false,admittedOperations:[op.operationId]});
 assert.equal((await f.deletion.advance(op)).state,'completed');
 assert.deepEqual(await admission(),{available:true,writable:true,admittedOperations:[]});
 assert.equal(await strict(),true);
 await f.deletion.plan({ownerId,requestKey:'admission-account',scope:{kind:'account'}});
 const account=await admission();
 assert.equal(account.available,false);assert.equal(account.writable,false);
 assert.equal(await strict(),false);
});

test('联系人封禁后名单服务立即重建，兄弟联系人可读且删除闭包不受早开读者阻塞', async t => {
 let closed=0,created=0;
 const f=await fixture(t,()=>{created++;return {account:async()=>evidence,sessions:async()=>[
  {externalKey:'synthetic-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},
  {externalKey:'synthetic-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}],close:async()=>{closed++;}};});
 const {contact,sibling}=await seeded(f);
 const base=f.storage.execute.bind(f.storage);
 let release,stepped=false;const gate=new Promise(resolve=>{release=resolve;});
 f.storage.execute=(name,input,...rest)=>{
  if(name==='deletion.clearTarget'&&!stepped){stepped=true;return gate.then(()=>base(name,input,...rest));}
  return base(name,input,...rest);
 };
 const op=await f.deletion.plan({ownerId,requestKey:'early-open-contact',scope:{kind:'contact',contactId:contact}});
 const advancing=f.deletion.advance(op);
 for(let i=0;i<500&&!stepped;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(stepped,'清理未开始');
 for(let i=0;i<500&&closed===0;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(closed,1,'旧名单服务应在清理前关闭');
 // 清理仍被挡住时重建名单服务：只读可读、被删联系人不可见、身份写入与敏感预览仍拒绝。
 const roster=await f.request('/api/contacts');
 assert.equal(roster.status,200);assert.deepEqual(roster.body.contacts.map(row=>row.contact_id),[sibling]);
 assert.equal(created,2,'名单服务应在封禁后重建');
 const bindings=await f.request('/api/sync/cli-bindings');
 assert.equal(bindings.status,200);assert.ok(bindings.body.bindings.every(row=>row.contact_id===sibling));
 assert.equal((await f.request('/api/sync/status')).status,200);
 const write=await f.request('/api/sync/enable','POST',{});
 assert.equal(write.status,409);assert.equal(write.body.error,'identity_closed');
 const sessions=await f.request('/api/sync/cli-sessions','GET',undefined,{'x-notalone-metadata-consent':'selected-list'});
 assert.equal(sessions.status,409);assert.equal(sessions.body.error,'identity_closed');
 const admitted=await f.storage.execute('deletion.metadataAdmission',{ownerId});
 assert.deepEqual(admitted.admittedOperations,[op.operationId]);
 release();
 const done=await advancing;
 assert.equal(done.state,'completed','早开的名单读者不能阻塞删除闭包');
 const after=await f.request('/api/contacts');
 assert.equal(after.status,200);assert.deepEqual(after.body.contacts.map(row=>row.contact_id),[sibling]);
 assert.equal((await f.storage.execute('deletion.metadataAdmission',{ownerId})).writable,true);
 assert.equal((await f.request('/api/sync/enable','POST',{})).status,200);
});
