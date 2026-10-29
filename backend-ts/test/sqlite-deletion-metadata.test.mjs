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
 return {request,deletion};
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
 const before=(await f.request('/api/contacts')).body.contacts;const contact=before[0].contact_id;
 const response=await f.request(`/api/contacts/${contact}`,'DELETE',{confirmed:true,confirm_contact_id:contact});
 assert.equal(response.status,202);assert.equal(closed,1);
 assert.equal((await f.request(`/api/deletions/${response.body.operation_id}`)).body.state,'completed');
 const remaining=(await f.request('/api/contacts')).body.contacts;assert.deepEqual(remaining.map(row=>row.contact_id),[before[1].contact_id]);
 const oldReads=reads;
 const oldCandidate=await f.request('/api/setup/wechat/confirm','POST',{candidate_token:candidate.candidate_token,confirmed:true,mode:'selected',history_authorized:false});
 assert.equal(oldCandidate.body.error,'account_candidate_stale');
 assert.equal((await f.request('/api/sync/cli-bindings/confirm','POST',confirmation)).body.error,'selection_stale');
 assert.equal(reads,oldReads);
});
