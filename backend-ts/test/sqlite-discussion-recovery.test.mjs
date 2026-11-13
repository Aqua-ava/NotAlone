import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
const ownerId='00000000-0000-4000-8000-000000000001';
const registryModule=new URL('./fixtures/sqlite/discussion-registry.mjs',import.meta.url).href;
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-discussion-recovery-')));
 let storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule});
 const contacts=new SqliteContactService(storage,ownerId,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);const snap=await contacts.candidates(true);
 await contacts.confirm(snap.snapshot_token,['a','b'].map(locator=>({locator,observed_display_name:'合成联系人',expected_selection_generation:'0'})));
 const ids=(await contacts.directory()).contacts.map(c=>c.contact_id);
 const service=()=>new SqliteDiscussionService(storage,ownerId);
 const begin=async(contactId,key=randomUUID(),text='中断前的合成要求')=>{
  const confirmationId=await storage.execute('identity.manualConfirm',{ownerId,contactId,contextToken:key,id:randomUUID(),at:Date.now()});
  return service().begin(contactId,key,text,{kind:'manual',confirmationId});
 };
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 return {root,ids,begin,service,get storage(){return storage;},async reopen(){const expectedDatabaseId=storage.status.databaseId;await storage.close();storage=await SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId,role:'test',registryModule});},
  async prepare(contactId=ids[0]){
   const discussion=await service().newDiscussion(contactId),key=randomUUID(),accepted=await begin(contactId,key),attempt=accepted.attempt;
   const contextId=randomUUID(),callId=randomUUID(),operationId=randomUUID();
   await storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
   await storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId,provider:'synthetic-no-network',model:'synthetic',configurationId:'a'.repeat(64),inputCap:1024,outputCap:128,requestKey:callId,inputSeal:'b'.repeat(64)});
   return {discussion,key,attempt,contextId,callId,operationId};
  },
 };
}

test('旧实例发送授权中断后自动放弃，保留原发言且同联系人可用新请求生成',async t=>{
 const f=await fixture(t),old=await f.prepare();
 await f.storage.execute('discussionTest.markSending',{ownerId,callId:old.callId});await f.reopen();
 assert.equal(await f.storage.execute('discussion.recover',{ownerId}),1);
 const recovered=await f.storage.execute('discussionTest.recoveryState',{ownerId,attemptId:old.attempt.attemptId});assert.notEqual(recovered.commit_forbidden_at,null);
 assert.deepEqual({...recovered,commit_forbidden_at:null},{
  attempt_state:'failed',request_state:'cancelled',call_state:'failed',settlement_state:'unknown',operation_state:'sealed',commit_forbidden_at:null,scope_state:'released',
 });
 const view=await f.service().view(f.ids[0],old.discussion.id);assert.equal(view.entries.length,1);assert.equal(view.entries[0].body,'中断前的合成要求');
 await assert.rejects(f.begin(f.ids[0],old.key),{code:'discussion_request_stale'});
 assert.ok((await f.begin(f.ids[0])).attempt);
 assert.ok((await f.begin(f.ids[1])).attempt);assert.equal(await f.storage.execute('discussion.recover',{ownerId}),0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧实例in_flight在恢复前已封住同联系人新请求，不能利用启动窗口重发',async t=>{
 const f=await fixture(t),old=await f.prepare();await f.storage.execute('discussionTest.markSending',{ownerId,callId:old.callId});await f.reopen();
 await assert.rejects(f.begin(f.ids[0]),{code:'discussion_call_unknown'});
 assert.equal((await f.service().view(f.ids[0],old.discussion.id)).entries.length,1);
 assert.equal(await f.storage.execute('discussion.recover',{ownerId}),1);
 assert.ok((await f.begin(f.ids[0])).attempt);
});

test('旧实例仅准备的调用按未发送失败结算，原请求不重放而新明确请求可受理',async t=>{
 const f=await fixture(t),old=await f.prepare();await f.reopen();
 assert.equal(await f.storage.execute('discussion.recover',{ownerId}),1);
 assert.deepEqual(await f.storage.execute('discussionTest.recoveryState',{ownerId,attemptId:old.attempt.attemptId}),{
  attempt_state:'failed',request_state:'cancelled',call_state:'failed',settlement_state:'settled',operation_state:'failed',commit_forbidden_at:null,scope_state:'released',
 });
 await assert.rejects(f.begin(f.ids[0],old.key),{code:'discussion_request_stale'});
 const fresh=await f.begin(f.ids[0]);assert.notEqual(fresh.attempt.requestId,old.attempt.requestId);
 assert.equal((await f.service().view(f.ids[0],old.discussion.id)).entries.length,2);
 assert.equal(await f.storage.execute('discussion.recover',{ownerId}),0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('当前实例准备及发送中的真实活动attempt不被恢复动作取消',async t=>{
 const f=await fixture(t),active=await f.prepare();assert.equal(await f.storage.execute('discussion.recover',{ownerId}),0);
 assert.deepEqual(await f.storage.execute('discussionTest.recoveryState',{ownerId,attemptId:active.attempt.attemptId}),{
  attempt_state:'running',request_state:'running',call_state:'prepared',settlement_state:'reserved',operation_state:'prepared',commit_forbidden_at:null,scope_state:'reserved',
 });
 await f.storage.execute('discussionTest.markSending',{ownerId,callId:active.callId});assert.equal(await f.storage.execute('discussion.recover',{ownerId}),0);
 assert.deepEqual(await f.storage.execute('discussionTest.recoveryState',{ownerId,attemptId:active.attempt.attemptId}),{
  attempt_state:'running',request_state:'running',call_state:'sending',settlement_state:'reserved',operation_state:'in_flight',commit_forbidden_at:null,scope_state:'sent',
 });
 assert.equal((await f.begin(f.ids[0],active.key)).replayed,true);
 await assert.rejects(f.begin(f.ids[0]),{code:'discussion_call_unknown'});
});

test('正常讨论宿主在运行副本初始化前结算旧实例，不调用模型也不改写原发言',async t=>{
 const {Context}=await import('@deepseek-ai/cordis'),{ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');
 const {createSqliteDiscussionHost}=await import('../src/reply/sqlite/host-runtime.ts');
 const f=await fixture(t),old=await f.prepare();await f.storage.execute('discussionTest.markSending',{ownerId,callId:old.callId});await f.reopen();
 const ctx=new Context(),host=await createSqliteDiscussionHost({ctx,storage:f.storage,ownerId,userData:f.root,holders:new ActiveHolders(),authorizeRequest:()=>true});
 try{
  assert.equal((await f.storage.execute('discussionTest.recoveryState',{ownerId,attemptId:old.attempt.attemptId})).call_state,'failed');
  assert.equal((await host.service.view(f.ids[0],old.discussion.id)).entries[0].body,'中断前的合成要求');
  assert.equal(host.turns,undefined);assert.deepEqual(await f.storage.execute('runtime.inventory',{ownerId}),[]);
 }finally{await host.close();await ctx.fiber.dispose();}
});

test('讨论未确认清单只返回同用户及联系人真实发送或未知调用键，不含正文',async t=>{
 const f=await fixture(t),old=await f.prepare();
 const pending=contact_id=>f.storage.execute('discussion.unconfirmed',{owner_id:ownerId,contact_id});
 assert.deepEqual(await pending(null),[]);await f.storage.execute('discussionTest.markSending',{ownerId,callId:old.callId});
 assert.deepEqual(await pending(null),[old.callId]);assert.deepEqual(await pending(f.ids[0]),[old.callId]);assert.deepEqual(await pending(f.ids[1]),[]);
 assert.deepEqual(await f.storage.execute('discussion.unconfirmed',{owner_id:randomUUID(),contact_id:null}),[]);
 await f.reopen();await f.storage.execute('discussion.recover',{ownerId});assert.deepEqual(await pending(f.ids[0]),[]);
});
