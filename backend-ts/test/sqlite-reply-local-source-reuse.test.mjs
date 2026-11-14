import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {assertReplyLocalSource,assertReplyLocalSources,withReplyLocalSourceEligibility} from '../src/history/sqlite/reply-local-source.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {registry} from '../src/storage/sqlite/registry.ts';
import {sha256} from '../src/platform/sha256.ts';

const registryModule=new URL('./fixtures/sqlite-reply-local-source-reuse-registry.mjs',import.meta.url).href;

async function committedRuntime(t,sourceCount){
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:sourceCount},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const sources=await f.storage.execute('fixture.replySourceReferences',{ownerId:owner,contactId}),management=new SqliteMemoryManagement(f.storage,owner);
 for(let index=0;index<5;index++){
  const saved=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:`园艺合成记忆${index}`});
  await f.storage.execute('fixture.attachReplySources',{ownerId:owner,memoryId:saved.memoryId,sources});
 }
 const discussion=await new SqliteDiscussionService(f.storage,owner).newDiscussion(contactId),requestKey=randomUUID(),service=new SqliteReplyCandidateService(f.storage,owner);
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await service.begin({contactId,discussionId:discussion.id,requestKey,text:'园艺',identity:{kind:'manual',confirmationId}});
 const input={...attempt,contextId:randomUUID(),callId:randomUUID(),copyId:randomUUID(),configurationDigest:'c'.repeat(64)},skillRun={packages:[],eligible:[]};
 await f.storage.execute('reply.freezeInput',{...input,skillRun,items:[],queryText:'园艺',at:Date.now()});
 const ticket=await f.storage.execute('reply.beginSearch',{...input,kind:'memory',query:'园艺'});
 assert.equal(ticket.status,'accepted');await f.storage.execute('reply.finishSearch',{...input,ticketId:ticket.ticketId,query:'园艺'});
 const budget={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,input_tokens:12,serialized_bytes:128,measurement_kind:'approximate',measurement_id:'synthetic-estimate',request_sha256:'a'.repeat(64)};
 await f.storage.execute('discussion.prepareCall',{...input,operationId:randomUUID(),provider:budget.provider,requestKey:input.callId,inputSeal:'b'.repeat(64),model:budget.model,configurationId:input.configurationDigest,inputCap:1024,outputCap:512});
 await f.storage.execute('runtime.prepare',{...input,sdkInstanceId:randomUUID(),locator:input.copyId});
 const files=new ManagedFiles(f.root);files.prepareArea('runtime');await mkdir(join(f.root,'managed/runtime-copies',input.copyId),{mode:0o700});
 const address=files.capture('runtime',input.copyId,'directory');
 await f.storage.execute('runtime.attach',{...input,address});await f.storage.execute('runtime.incorporate',input);
 // 供应商响应由合成事件代替；出站、结算及业务提交沿用真实存储动作，不调用外部模型。
 await f.storage.execute('reply.dispatchCall',{...input,skillRun,budget,requestPayload:{messages:['园艺合成请求']}});
 await f.storage.execute('discussion.settleStep',{...input,usage:{inputTokens:5,outputTokens:3},reason:'stop'});
 const text=JSON.stringify({candidates:[{parts:['合成园艺候选'],basis:[1]}]});
 await f.storage.execute('reply.commitCandidates',{...input,skillRun,text,sessionEvent:{type:'assistant/message',seq:1,data:{message:{source:{provider:budget.provider,model:budget.model},content:[{type:'text',text}]},usage:{inputTokens:5,outputTokens:3},interrupted:false}}});
 await f.storage.execute('runtime.manifest',{...input,rootAbsent:false,files:[address]});
 input.eventBoundary=JSON.stringify({formatVersion:4,eventCount:1,lastSeq:1,eventSha256:'d'.repeat(64)});
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 let sourceQueries=0;
 const all=(sql,values=[])=>{if(sql.includes('wanted AS ('))sourceQueries++;const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const tx={all,get:(sql,values)=>all(sql,values)[0],run:(sql,values=[])=>{db.prepare(sql).run(...values);}};
 function measure(name){
  sourceQueries=0;const start=performance.now(),value=registry.actions.find(action=>action.name===name).execute(tx,input,f.storage.status);
  return {value,sourceQueries,elapsedMs:performance.now()-start};
 }
 return {...f,db,tx,input,sources,service,requestKey,measure};
}

for(const sourceCount of [10,100,400])test(`已提交候选的运行副本复验5条记忆共享${sourceCount}条来源时，不重复放大资格查询`,async t=>{
 const f=await committedRuntime(t,sourceCount);
 assert.equal((await f.service.status(f.input.contactId,f.input.discussionId,f.requestKey)).phase,'committed');
 f.db.exec('BEGIN IMMEDIATE');
 try{
  const inspected=f.measure('runtime.inspect'),ready=f.measure('runtime.ready');
  assert.equal(inspected.value.state,'dirty');assert.equal(ready.value.state,'ready');
  t.diagnostic(JSON.stringify({sourceCount,memoryCount:5,inspect:{sourceQueries:inspected.sourceQueries,elapsedMs:inspected.elapsedMs},ready:{sourceQueries:ready.sourceQueries,elapsedMs:ready.elapsedMs}}));
  assert.ok(inspected.sourceQueries<=sourceCount,`回看共享${sourceCount}条来源不应执行${inspected.sourceQueries}次资格查询`);
  assert.ok(ready.sourceQueries<=sourceCount,`保存后共享${sourceCount}条来源不应执行${ready.sourceQueries}次资格查询`);
 }finally{f.db.exec('ROLLBACK');}
 // 下一动作重新核验来源；已有成功不能跨动作或消息修订复用。
 const source=f.sources[0];f.db.exec('BEGIN IMMEDIATE');
 try{
  f.tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[owner,source.contact_id,source.message_id]);
  assert.throws(()=>f.measure('runtime.ready'),{code:'discussion_runtime_invalidated'});
 }finally{f.db.exec('ROLLBACK');}
 f.db.exec('BEGIN IMMEDIATE');
 try{
  f.tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[owner,source.contact_id,source.record_id]);
  assert.throws(()=>f.measure('runtime.inspect'),{code:'discussion_runtime_invalidated'});
 }finally{f.db.exec('ROLLBACK');}
});

for(const sourceCount of [10,100,400])test(`正式候选冻结的5条记忆共享${sourceCount}条来源时，资格核验不随重复引用放大`,async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:sourceCount},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const sources=await f.storage.execute('fixture.replySourceReferences',{ownerId:owner,contactId});
 assert.equal(sources.length,sourceCount);
 const management=new SqliteMemoryManagement(f.storage,owner),ids=[];
 for(let index=0;index<5;index++){
  const saved=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:`园艺合成记忆${index}`});ids.push(saved.memoryId);
  await f.storage.execute('fixture.attachReplySources',{ownerId:owner,memoryId:saved.memoryId,sources});
 }
 const discussion=await new SqliteDiscussionService(f.storage,owner).newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await new SqliteReplyCandidateService(f.storage,owner).begin({contactId,discussionId:discussion.id,requestKey,text:'园艺',identity:{kind:'manual',confirmationId}});
 const contextId=randomUUID(),result=await f.storage.execute('fixture.freezeReplyMeasured',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[],queryText:'园艺',at:Date.now()});
 assert.deepEqual(result.memories.map(item=>item.id).sort(),ids.sort());assert.ok(result.memories.every(item=>item.sources===sourceCount));
 t.diagnostic(JSON.stringify({sourceCount,memoryCount:ids.length,...result,memories:undefined}));
 // 写入冻结上下文后允许再做一次整批资格核验；其余相同来源由本动作的只读阶段复用。
 assert.ok(result.sourceQueries<=sourceCount+1,`共享${sourceCount}条来源不应执行${result.sourceQueries}次资格查询`);
 const revision=await f.storage.execute('fixture.reviseFrozenReply',{...attempt,contextId});
 assert.deepEqual(revision,{before:true,errorCode:'reply_source_unavailable'},'消息修订变化仍使已冻结候选输入失效');
});

async function sourceFixture(t){
 const f=await fixture(t,{registryModule});for(const binding of f.saved)await f.service.synchronize(binding.contact_id);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 let sourceQueries=0;
 const all=(sql,values=[])=>{if(sql.includes('wanted AS ('))sourceQueries++;const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const tx={all,get:(sql,values)=>all(sql,values)[0],run:(sql,values=[])=>{db.prepare(sql).run(...values);}};
 const refs=tx.all(`SELECT r.owner_id,r.contact_id,r.id record_id,r.message_id FROM capture_record r
  JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id WHERE m.kind='text' ORDER BY r.contact_id`);
 return {db,tx,refs,get sourceQueries(){return sourceQueries;}};
}

test('来源复用按完整归属隔离，不缓存失败，离开同步作用域后重新核验',async t=>{
 const f=await sourceFixture(t),[a,b]=f.refs;let escaped;
 f.db.exec('BEGIN');
 try{
  withReplyLocalSourceEligibility(f.tx,tx=>{
   escaped=tx;assertReplyLocalSources(tx,[a,a,b]);
   for(let i=0;i<20;i++){assertReplyLocalSource(tx,a);assertReplyLocalSource(tx,b);}
   withReplyLocalSourceEligibility(tx,nested=>assertReplyLocalSources(nested,[a,b]));
   assert.equal(f.sourceQueries,2,'重复来源按各自联系人核验一次');
   for(const bad of [{...a,owner_id:'wrong-owner'},{...a,contact_id:b.contact_id},{...a,message_id:b.message_id}])
    assert.throws(()=>assertReplyLocalSource(tx,bad),{code:'history_source_not_available'});
   for(let i=0;i<2;i++)assert.throws(()=>assertReplyLocalSource(tx,{...a,record_id:'missing-record'}),{code:'history_source_not_available'});
   assert.equal(f.sourceQueries,7,'不同归属不能命中；失败每次必须重新核验');
  });
  assertReplyLocalSource(escaped,a);assert.equal(f.sourceQueries,8,'作用域退出即释放复用集合');
  let failedScope;
  assert.throws(()=>withReplyLocalSourceEligibility(f.tx,tx=>{failedScope=tx;assertReplyLocalSource(tx,a);throw new Error('合成同步失败');}),/合成同步失败/);
  assertReplyLocalSource(failedScope,a);assert.equal(f.sourceQueries,10,'异常退出也释放复用集合');
 }finally{f.db.exec('ROLLBACK');}
 f.db.exec('BEGIN');
 try{withReplyLocalSourceEligibility(f.tx,tx=>assertReplyLocalSource(tx,a));assert.equal(f.sourceQueries,11,'下一事务不能复用原资格');}
 finally{f.db.exec('ROLLBACK');}
});

test('同一事务写入删除、隔离及来源失证后，重复引用仍重新拒绝；结清派生状态也作废复用',async t=>{
 const f=await sourceFixture(t),a=f.refs[0];
 const invalid=tx=>assert.throws(()=>assertReplyLocalSource(tx,a),{code:'history_source_not_available'});
 f.db.exec('BEGIN IMMEDIATE');
 try{
  withReplyLocalSourceEligibility({...f.tx,flushDerived(){f.tx.run("UPDATE source_proof SET state='needs_confirmation' WHERE owner_id=? AND contact_id=?",[a.owner_id,a.contact_id]);}},tx=>{
   assertReplyLocalSource(tx,a);
   const rejectAfter=(sql,values)=>{
    tx.run('SAVEPOINT source_mutation');tx.run(sql,values);invalid(tx);
    tx.run('ROLLBACK TO source_mutation');tx.run('RELEASE source_mutation');assertReplyLocalSource(tx,a);
   };
   rejectAfter("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[a.owner_id,a.contact_id,a.record_id]);
   rejectAfter('INSERT INTO history_message_quarantine VALUES(?,?,?,?)',[a.owner_id,a.contact_id,a.message_id,'synthetic']);
   rejectAfter("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND contact_id=?",[a.owner_id,a.contact_id]);
   tx.flushDerived();invalid(tx);
  });
 }finally{f.db.exec('ROLLBACK');}
});

test('主动搜索只冻结记忆头部身份与摘要，不复制正文或遍历文档；旧读者保持只读兼容',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 const discussion=await new SqliteDiscussionService(f.storage,owner).newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await new SqliteReplyCandidateService(f.storage,owner).begin({contactId,discussionId:discussion.id,requestKey,text:'合成记忆池',identity:{kind:'manual',confirmationId}});
 const listed=await f.storage.execute('fixture.searchPoolReads',attempt);
 assert.equal(listed.ticket.status,'accepted');assert.equal(listed.ticket.pool,undefined);
 assert.deepEqual(listed.anchors,[{id:'synthetic-memory',versionNo:'1',textSeal:sha256('合成记忆头部')}]);
 assert.doesNotMatch(JSON.stringify(listed),/合成记忆头部|未确认候选|文档不进入语义记忆池/);
 assert.deepEqual(listed.calls,{list:1,read:0,documents:0},'仅提取记忆头部不应展开文档和来源');
 const legacy=await f.storage.execute('fixture.searchPoolReads',{...attempt,legacy:true});
 assert.equal(legacy.ticket.pool,undefined);assert.deepEqual(legacy.anchors,listed.anchors);assert.deepEqual(legacy.calls,{list:0,read:1,documents:0});
});
