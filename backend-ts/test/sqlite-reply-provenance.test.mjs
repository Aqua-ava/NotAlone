import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

const ownerId='00000000-0000-4000-8000-000000000001';
const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-reply-provenance-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/reply-provenance-registry.mjs',import.meta.url).href});
 let history;
 t.after(async()=>{await history?.close();await storage.close();await rm(root,{recursive:true,force:true});});
 const contacts=new SqliteContactService(storage,ownerId,{
  account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),
  sessions:async()=>['a','b'].map((externalKey,index)=>({externalKey,displayName:index?'合成乙':'合成甲',kind:'private',identityAssurance:'verified'})),
 });
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snapshot=await contacts.candidates(true);
 await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const ids=(await contacts.directory()).contacts.map(c=>c.contact_id);await contacts.setReading(true);
 const target={protocol:'private-history-v1',descriptor:'synthetic-target',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'};
 history=new SqliteHistoryService(storage,contacts,{
  inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),
  target:async()=>target,
  page:async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:['1','2'].map(localId=>({partition:'shard-a',table:'table-instance-1',localId,serverId:'0',sender:'contact',kind:'text',text:`合成消息${localId}`,originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['shard-a'],exhausted:true}),
 });
 for(const id of ids)await history.synchronize(id);
 const discussions=new SqliteDiscussionService(storage,ownerId);
 async function context(contactId,{entryIds=[],messageIds,candidate=false}={}){
  const requestKey=randomUUID(),confirmationId=await storage.execute('identity.manualConfirm',{ownerId,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
  const {attempt}=candidate
   ?await new SqliteReplyCandidateService(storage,ownerId).begin({contactId,requestKey,text:'本次合成表达要求',identity:{kind:'manual',confirmationId},discussionId:(await discussions.forRequest(contactId)).discussion.id})
   :await discussions.begin(contactId,requestKey,'本次合成表达要求',{kind:'manual',confirmationId});
  const messages=await storage.execute('discussion.messages',{...attempt,messageIds:messageIds??(await history.read(contactId)).messages.map(m=>m.id)}),contextId=randomUUID();
  await storage.execute(candidate?'reply.freezeInput':'discussion.freezeContext',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[...messages.map(m=>({kind:'message',sourceContactId:contactId,messageId:m.id,recordId:m.record_id,acceptedRevision:m.interpretation_revision})),...entryIds.map(entryId=>({kind:'entry',entryId}))],at:Date.now()});
  return {...attempt,contextId,messages};
 }
 return {storage,contacts,history,discussions,ids,context,check:scope=>storage.execute('provenanceTest.check',{ownerId,...scope})};
}

test('当前请求多条实际来源中任意一条不可用都会拒绝，且无需扫描无关联系人',async t=>{
 const f=await fixture(t),a=await f.context(f.ids[0]),b=await f.context(f.ids[1]);
 assert.equal(await f.check({requestIds:[a.requestId]}),true);
 await f.storage.execute('provenanceTest.sourceUnavailable',{ownerId,contactId:f.ids[1],recordId:b.messages[0].record_id});
 assert.equal(await f.check({contextIds:[a.contextId]}),true);
 await f.storage.execute('provenanceTest.sourceUnavailable',{ownerId,contactId:f.ids[0],recordId:a.messages[1].record_id});
 await assert.rejects(f.check({requestIds:[a.requestId]}),{code:'history_source_not_available'});
});

test('来源守卫丢失和单消息修订都能使冻结输入失效，无需联系人总版本变化',async t=>{
 for(const mode of ['guardLost','messageChanged'])await t.test(mode,async t=>{
  const f=await fixture(t),a=await f.context(f.ids[0]);assert.equal(await f.check({requestIds:[a.requestId]}),true);
  await f.storage.execute(`provenanceTest.${mode}`,{ownerId,contactId:f.ids[0],messageId:a.messages[0].id});
  await assert.rejects(f.check({requestIds:[a.requestId]}),{code:'history_source_not_available'});
 });
});

test('运行副本检查全部已接触的上下文，不遗漏较早纳入的资料',async t=>{
 const f=await fixture(t),first=await f.context(f.ids[0]),next=await f.context(f.ids[0],{messageIds:[]}),copyId=randomUUID();
 await f.storage.execute('runtime.prepare',{...next,copyId,sdkInstanceId:randomUUID(),locator:copyId,configurationDigest:'a'.repeat(64)});
 await f.storage.execute('provenanceTest.copyContexts',{ownerId,copyId,contextIds:[first.contextId,next.contextId]});
 assert.equal(await f.check({copyIds:[copyId]}),true);
 await f.storage.execute('provenanceTest.messageChanged',{ownerId,contactId:f.ids[0],messageId:first.messages[0].id});
 assert.equal(await f.check({contextIds:[next.contextId]}),true);
 await assert.rejects(f.check({copyIds:[copyId]}),{code:'history_source_not_available'});
});

test('本人记忆引用的另一联系人来源属于本次实际依赖，同样必须核对',async t=>{
 const f=await fixture(t);
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId,contactId:f.ids[0],sourceContactId:f.ids[1],mode:'owner'});
 const next=await f.context(f.ids[0],{messageIds:[],candidate:true});
 assert.equal(await f.check({contextIds:[next.contextId]}),true);
 await f.storage.execute('provenanceTest.guardLost',{ownerId,contactId:f.ids[1]});
 await assert.rejects(f.check({contextIds:[next.contextId]}),{code:'history_source_not_available'});
});

test('无关联系人增加失证的旧请求，不增加当前依赖校验读取的行数',async t=>{
 const f=await fixture(t),a=await f.context(f.ids[0]);
 const read=()=>f.storage.execute('provenanceTest.inspect',{ownerId,requestIds:[a.requestId]});
 const before=await read();assert.equal(before.current,true);
 let unrelated;
 for(let index=0;index<8;++index)unrelated=await f.context(f.ids[1]);
 await f.storage.execute('provenanceTest.guardLost',{ownerId,contactId:f.ids[1]});
 assert.equal((await f.storage.execute('provenanceTest.inspect',{ownerId,requestIds:[unrelated.requestId]})).current,false);
 const after=await read();assert.deepEqual(after,before);
});

test('旧讨论条目的实际来源失效会阻止后续复用，不能只检查当前直接聊天',async t=>{
 const f=await fixture(t),first=await f.context(f.ids[0]);
 const entry=(await f.discussions.view(f.ids[0],first.discussionId)).entries[0];
 const next=await f.context(f.ids[0],{entryIds:[entry.id],messageIds:[]});
 assert.equal(await f.check({contextIds:[next.contextId]}),true);
 await f.storage.execute('provenanceTest.sourceUnavailable',{ownerId,contactId:f.ids[0],recordId:first.messages[0].record_id});
 await assert.rejects(f.check({contextIds:[next.contextId]}),{code:'history_source_not_available'});
});
