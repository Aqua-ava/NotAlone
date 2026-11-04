import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteDiscussionHttp} from '../src/reply/sqlite/http.ts';

const owner='00000000-0000-4000-8000-000000000001';

async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-discussion-history-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/discussion-history-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snap=await contacts.candidates(true);await contacts.confirm(snap.snapshot_token,['a','b'].map(locator=>({locator,observed_display_name:'合成联系人',expected_selection_generation:'0'})));
 const contactIds=(await contacts.directory()).contacts.map(contact=>contact.contact_id);let now=1_000_000;
 const service=new SqliteDiscussionService(storage,owner,()=>now);
 const snapshot=contactId=>storage.execute('discussionHistory.snapshot',{ownerId:owner,contactId});
 const begin=async(contactId,discussionId,text)=>{
  const requestKey=randomUUID(),confirmationId=await contacts.manualConfirm(contactId,requestKey);
  return service.begin(contactId,requestKey,text,{kind:'manual',confirmationId},discussionId);
 };
 return {storage,contacts,contactIds,service,snapshot,begin,advance:ms=>{now+=ms;}};
}

test('历史列表和正文读取保持当前、活跃时间、运行副本和请求数不变',async t=>{
 const f=await fixture(t),contactId=f.contactIds[0];
 const earlier=await f.service.newDiscussion(contactId);f.advance(1_000);
 const current=await f.service.newDiscussion(contactId);f.advance(1_000);
 await f.storage.execute('discussionHistory.seedRuntimeForTest',{ownerId:owner,contactId,discussionId:earlier.id,copyId:randomUUID()});
 const before=await f.snapshot(contactId);

 await f.service.list(contactId);await f.service.view(contactId,earlier.id);
 const after=await f.snapshot(contactId);
 assert.deepEqual(after,before);
 assert.equal(after.discussions.find(row=>row.id===current.id).is_current,1n);
 assert.equal(after.discussions.find(row=>row.id===earlier.id).is_current,0n);
 assert.equal((await f.service.view(contactId,earlier.id)).discussion.currentRuntimeId!==null,true);
});

test('专用继续动作幂等切换目标讨论且不生成候选或恢复运行副本',async t=>{
 const f=await fixture(t),contactId=f.contactIds[0];
 const target=await f.service.newDiscussion(contactId);
 await f.begin(contactId,target.id,'目标讨论自己的合成正文');
 f.advance(1_000);
 const current=await f.service.newDiscussion(contactId);
 await f.begin(contactId,current.id,'不应带入目标讨论的当前合成正文');
 f.advance(1_000);
 const copyId=randomUUID();
 await f.storage.execute('discussionHistory.seedRuntimeForTest',{ownerId:owner,contactId,discussionId:target.id,copyId});
 const before=await f.snapshot(contactId);

 const continued=await f.service.continueDiscussion(contactId,target.id);
 assert.equal(continued.id,target.id);assert.equal(continued.isCurrent,true);
 const switched=await f.snapshot(contactId);
 assert.equal(switched.discussions.find(row=>row.id===target.id).is_current,1n);
 assert.equal(switched.discussions.find(row=>row.id===current.id).is_current,0n);
 assert.equal(switched.discussions.find(row=>row.id===target.id).current_runtime_id,copyId);
 assert.deepEqual(switched.runtimeCopies,before.runtimeCopies);
 assert.equal(switched.requestCount,before.requestCount);
 assert.equal(switched.modelCallCount,before.modelCallCount);
 assert.deepEqual((await f.service.view(contactId,target.id)).entries.map(entry=>entry.body),['目标讨论自己的合成正文']);
 assert.deepEqual((await f.service.view(contactId,current.id)).entries.map(entry=>entry.body),['不应带入目标讨论的当前合成正文']);

 f.advance(5_000);
 const stable=switched.discussions.find(row=>row.id===target.id).last_activity_at;
 await f.service.continueDiscussion(contactId,target.id);
 const repeated=await f.snapshot(contactId);
 assert.deepEqual(repeated,switched);
 assert.equal(repeated.discussions.find(row=>row.id===target.id).last_activity_at,stable);
});

test('跨联系人与来源失效的讨论不能继续，回看只保留清除状态',async t=>{
 const f=await fixture(t),contactId=f.contactIds[0],otherContactId=f.contactIds[1];
 const stale=await f.service.newDiscussion(contactId),key=randomUUID(),confirmationId=await f.contacts.manualConfirm(contactId,key);
 const accepted=await f.service.begin(contactId,key,'合成旧讨论正文',{kind:'manual',confirmationId},stale.id);
 f.advance(1_000);const current=await f.service.newDiscussion(contactId);
 await f.storage.execute('discussionHistory.invalidateSourceForTest',{ownerId:owner,contactId,discussionId:stale.id,requestId:accepted.attempt.requestId,at:1_000_001});

 const reviewed=await f.service.view(contactId,stale.id);
 assert.equal(reviewed.entries[0].body,null);
 assert.equal(reviewed.entries[0].content_state,'cleared');
 await assert.rejects(f.service.continueDiscussion(contactId,stale.id),{code:'discussion_source_unavailable'});
 assert.equal((await f.service.list(contactId)).currentDiscussionId,current.id);
 await assert.rejects(f.service.continueDiscussion(otherContactId,current.id),{code:'discussion_unavailable'});
});

test('HTTP 只有专用 continue POST 切换讨论，GET 回看不改变目录',async t=>{
 const f=await fixture(t),contactId=f.contactIds[0];
 const history=await f.service.newDiscussion(contactId);f.advance(1_000);
 const current=await f.service.newDiscussion(contactId);
 const before=await f.snapshot(contactId);
 const http=new SqliteDiscussionHttp(f.service,()=>true);
 const call=async(path,method='GET')=>{
  const body=method==='POST'?Buffer.from('{}'):undefined,req=Readable.from(body?[body]:[]);
  Object.assign(req,{method,url:`/api/contacts/${contactId}/assistant-sessions${path}`,headers:body?{'content-length':String(body.length)}:{},complete:true});
  let status=200,raw='';const res=new Writable({write(chunk,_encoding,callback){raw+=chunk;callback();}});
  res.writeHead=code=>{status=code;return res;};
  const finished=new Promise(resolve=>res.once('finish',resolve));
  const handled=await http.handle(req,res);
  if(!handled)return {handled,status,data:null};
  await finished;
  return {handled,status,data:JSON.parse(raw)};
 };

 assert.equal((await call(`/${history.id}/resume`,'POST')).handled,false);
 assert.equal((await call(`/${history.id}`)).status,200);
 assert.deepEqual(await f.snapshot(contactId),before);
 assert.equal((await call(`/${history.id}/continue`,'POST')).status,200);
 const switched=await f.snapshot(contactId);
 assert.equal(switched.discussions.find(row=>row.id===history.id).is_current,1n);
 assert.equal(switched.discussions.find(row=>row.id===current.id).is_current,0n);
 assert.equal(switched.requestCount,before.requestCount);
 assert.equal((await call(`/${current.id}/continue`,'POST')).status,200);
});
