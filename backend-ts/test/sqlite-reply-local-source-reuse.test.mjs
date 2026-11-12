import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {assertReplyLocalSource,assertReplyLocalSources,withReplyLocalSourceEligibility} from '../src/history/sqlite/reply-local-source.ts';

const registryModule=new URL('./fixtures/sqlite-reply-local-source-reuse-registry.mjs',import.meta.url).href;

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

test('语义记忆池只列记忆头部，不遍历文档；旧读者保持只读兼容',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 const discussion=await new SqliteDiscussionService(f.storage,owner).newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const {attempt}=await new SqliteReplyCandidateService(f.storage,owner).begin({contactId,discussionId:discussion.id,requestKey,text:'合成记忆池',identity:{kind:'manual',confirmationId}});
 const listed=await f.storage.execute('fixture.memoryPoolReads',attempt);
 assert.deepEqual(listed.pool,[{id:'synthetic-memory',versionNo:'1',text:'合成记忆头部'}]);
 assert.deepEqual(listed.calls,{list:1,read:0,documents:0},'仅提取记忆头部不应展开文档和来源');
 const legacy=await f.storage.execute('fixture.memoryPoolReads',{...attempt,legacy:true});
 assert.deepEqual(legacy.pool,listed.pool);assert.deepEqual(legacy.calls,{list:0,read:1,documents:0});
});
