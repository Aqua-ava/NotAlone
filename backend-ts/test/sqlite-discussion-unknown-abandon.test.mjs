import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

const ownerId='00000000-0000-4000-8000-000000000001';
const registryModule=new URL('./fixtures/sqlite/discussion-unknown-registry.mjs',import.meta.url).href;
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-unknown-abandon-')));
 let storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule});
 const contacts=new SqliteContactService(storage,ownerId,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snap=await contacts.candidates(true);await contacts.confirm(snap.snapshot_token,snap.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const ids=(await contacts.directory()).contacts.map(c=>c.contact_id);
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const begin=async(contactId=ids[0],requestKey=randomUUID())=>{
  const confirmationId=await storage.execute('identity.manualConfirm',{ownerId,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
  const discussions=new SqliteDiscussionService(storage,ownerId);
  const discussionId=(await discussions.list(contactId)).currentDiscussionId??(await discussions.newDiscussion(contactId)).id;
  return {requestKey,...await new SqliteReplyCandidateService(storage,ownerId).begin({contactId,discussionId,requestKey,text:'仅用于未知调用恢复的合成想法',identity:{kind:'manual',confirmationId},includeRelationshipContext:false})};
 };
 return {root,ids,begin,get storage(){return storage;},
  inspect:i=>storage.execute('unknownTest.inspect',i),
  fail:(i,dispatched=true)=>storage.execute('discussion.failCall',{...i,dispatched,code:'discussion_generation_timeout',failure:{kind:'error',code:'SERVER',status:503,dispatch:'authorized_unconfirmed'}}),
  async reopen(){const expectedDatabaseId=storage.status.databaseId;await storage.close();storage=await SqliteStorage.open({userData:root,intent:'open',expectedDatabaseId,role:'test',registryModule});},
  async prepare(contactId=ids[0],sent=true){
   const {attempt,requestKey}=await begin(contactId),input={...attempt,requestKey,contextId:randomUUID(),callId:randomUUID(),operationId:randomUUID()};
   await storage.execute('discussion.freezeContext',{...input,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
   await storage.execute('discussion.prepareCall',{...input,provider:'synthetic-no-network',model:'synthetic',configurationId:'a'.repeat(64),inputCap:1024,outputCap:128,requestKey:input.callId,inputSeal:'b'.repeat(64)});
   if(sent)await storage.execute('discussionTest.markSending',input);
   return input;
  },
 };
}
function assertAbandoned(state){
 assert.equal(state.calls[0].state,'failed');assert.equal(state.calls[0].error_code,'unknown_abandoned');assert.equal(state.calls[0].settlement_state,'unknown');
 assert.equal(state.operation.state,'sealed');assert.ok(state.operation.commit_forbidden_at!==null);assert.equal(state.operation.reply_request_id,state.request.id);
 assert.ok(state.scopes.every(s=>s.state==='released'));assert.equal(state.attempt.state,'failed');assert.equal(state.request.state,'cancelled');
}

test('failCall 已派发后自动放弃未知调用，同联系人可用新请求生成',async t=>{
 const f=await fixture(t),input=await f.prepare();await f.fail(input);
 const state=await f.inspect(input);assertAbandoned(state);
 assert.equal(state.attempt.error_code,'discussion_generation_timeout');
 assert.equal(JSON.parse(state.calls[0].receipt).failure.code,'SERVER');
 const fresh=await f.begin();assert.notEqual(fresh.requestKey,input.requestKey);assert.notEqual(fresh.attempt.requestId,input.requestId);
 await assert.rejects(f.begin(f.ids[0],input.requestKey),{code:'discussion_request_stale'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('failCall 未派发保持已结算失败，不封存操作',async t=>{
 const f=await fixture(t),input=await f.prepare(f.ids[0],false);await f.fail(input,false);
 const state=await f.inspect(input);
 assert.equal(state.calls[0].state,'failed');assert.equal(state.calls[0].settlement_state,'settled');assert.equal(state.calls[0].error_code,'discussion_generation_timeout');
 assert.equal(state.operation.state,'failed');assert.equal(state.operation.commit_forbidden_at,null);assert.equal(state.scopes[0].state,'released');
 assert.ok((await f.begin()).attempt);
});

test('recover 旧运行时已派发的运行中尝试自动放弃且不改写原发言',async t=>{
 const f=await fixture(t),input=await f.prepare();await f.reopen();
 assert.equal(await f.storage.execute('discussion.recover',{ownerId}),1);
 const state=await f.inspect(input);assertAbandoned(state);assert.equal(state.attempt.error_code,'runtime_interrupted');
 const view=await new SqliteDiscussionService(f.storage,ownerId).view(input.contactId,input.discussionId);
 assert.equal(view.entries.length,1);assert.equal(view.entries[0].body,'仅用于未知调用恢复的合成想法');
 assert.ok((await f.begin()).attempt);
});

test('recover 升级前已失败的存量未知也封存，原回执保持未知且完整',async t=>{
 const f=await fixture(t),input=await f.prepare();await f.storage.execute('unknownTest.legacy',input);
 const before=await f.inspect(input);await f.reopen();
 await f.storage.execute('discussion.recover',{ownerId});
 const after=await f.inspect(input);assertAbandoned(after);
 assert.equal(after.calls[0].receipt,before.calls[0].receipt);assert.deepEqual(after.attempt,before.attempt);assert.deepEqual(after.request,before.request);
 assert.equal(after.operation.input_seal,before.operation.input_seal);assert.ok((await f.begin()).attempt);
});

test('recover 不误伤当前 runtime 与 epoch 的在途请求，仍拦截同联系人并发',async t=>{
 const f=await fixture(t),input=await f.prepare(),before=await f.inspect(input);
 assert.equal(await f.storage.execute('discussion.recover',{ownerId}),0);assert.deepEqual(await f.inspect(input),before);
 await assert.rejects(f.begin(),{code:'discussion_call_unknown'});
});

test('封存后的迟到提交被 discussion_call_invalidated 拒收且不生成候选',async t=>{
 const f=await fixture(t),input=await f.prepare();await f.fail(input);
 const before=await f.inspect(input);
 for(const action of ['discussion.commitAssistant','reply.commitCandidates','discussion.settleStep']){
  await assert.rejects(f.storage.execute(action,{...input,skillRun:{packages:[],eligible:[]}}),{code:'discussion_call_invalidated'});
 }
 assert.deepEqual(await f.inspect(input),before);assert.deepEqual(before.candidates,[]);
});

test('放弃后的 status 与历史生成状态为可重试失败，保留已发出事实和原因',async t=>{
 const f=await fixture(t),input=await f.prepare();await f.fail(input);
 const service=new SqliteReplyCandidateService(f.storage,ownerId),status=await service.status(input.contactId,input.discussionId,input.requestKey);
 assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.retryable,true);assert.equal(status.errorCode,'discussion_generation_timeout');
 const [view]=await service.view(input.contactId,input.discussionId);
 assert.equal(view.generationState,'failed');assert.equal(view.generationSent,true);assert.equal(view.generationErrorCode,'discussion_generation_timeout');
});

test('放弃可幂等且按 owner 和联系人隔离，不改写已有封存时间与回执',async t=>{
 const f=await fixture(t),a=await f.prepare(),b=await f.prepare(f.ids[1]),active=await f.inspect(b);
 await f.fail({...a,ownerId:randomUUID()});assert.equal((await f.inspect(a)).calls[0].state,'sending');
 await f.fail(a);const abandoned=await f.inspect(a);
 await f.fail(a);await f.storage.execute('discussion.recover',{ownerId});await f.storage.execute('discussion.recover',{ownerId});
 assert.deepEqual(await f.inspect(a),abandoned);assert.deepEqual(await f.inspect(b),active);
 assert.ok((await f.begin(f.ids[0])).attempt);await assert.rejects(f.begin(f.ids[1]),{code:'discussion_call_unknown'});
 await f.storage.execute('unknownTest.legacy',b);await f.storage.execute('discussion.recover',{ownerId:randomUUID()});
 assert.equal((await f.inspect(b)).operation.state,'unknown');
 await f.storage.execute('discussion.recover',{ownerId});const recovered=await f.inspect(b);assertAbandoned(recovered);
 await f.storage.execute('discussion.recover',{ownerId});await f.fail(b);assert.deepEqual(await f.inspect(b),recovered);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('recover 已取消但仍 sending 的旧调用释放为可重试失败且成本未知',async t=>{
 const f=await fixture(t),input=await f.prepare();await f.storage.execute('discussion.cancel',{...input,at:1});
 const before=await f.inspect(input);await f.reopen();await f.storage.execute('discussion.recover',{ownerId});
 const after=await f.inspect(input);
 assert.equal(after.calls[0].state,'failed');assert.equal(after.calls[0].error_code,'unknown_abandoned');assert.equal(after.calls[0].settlement_state,'unknown');
 assert.deepEqual(after.attempt,before.attempt);assert.deepEqual(after.request,before.request);assert.equal(after.operation.state,'sealed');assert.equal(after.scopes[0].state,'released');
 const status=await new SqliteReplyCandidateService(f.storage,ownerId).status(input.contactId,input.discussionId,input.requestKey);
 assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.retryable,true);assert.ok((await f.begin()).attempt);
});
