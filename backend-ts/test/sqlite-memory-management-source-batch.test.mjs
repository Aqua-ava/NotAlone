import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {adjudicationFixture} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {managementRead,versionView} from '../src/memory/sqlite/management/read.ts';
import {requireVersion} from '../src/memory/sqlite/management/qualification.ts';
import {assertReplyLocalSource} from '../src/history/sqlite/reply-local-source.ts';

function transaction(db,queries=[]){
 const all=(sql,values=[])=>{queries.push(sql);const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 return {all,get:(sql,values)=>all(sql,values)[0],run:(sql,values=[])=>db.prepare(sql).run(...values)};
}
const sourceQueries=queries=>queries.filter(sql=>sql.includes('wanted AS ('));
function singleVersion(tx,m,v){
 try{if(v.content_state==='present')requireVersion(tx,owner,m,v);return versionView(tx,owner,v);}
 catch{
  if(v.content_state==='present')try{requireVersion(tx,owner,m,v,assertReplyLocalSource);return {...versionView(tx,owner,v,assertReplyLocalSource),sourcePendingRecheck:true};}catch{}
  return {...versionView(tx,owner,{...v,body:null,content_state:'redacted'}),sources:[],provenanceState:'invalidated'};
 }
}
function assertSingleVersions(tx,view){
 for(const memory of view.memories){
  const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,memory.id]);
  const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? ORDER BY version_no DESC LIMIT 1',[owner,memory.id]);
  assert.deepEqual(memory.versions,[singleVersion(tx,m,v)]);
 }
}
async function seeded(t,count){
 const f=await fixture(t),contactId=f.saved[0].contact_id,other=f.saved[1].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:count},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 for(const contact of [contactId,other])await f.service.synchronize(contact);
 const management=new SqliteMemoryManagement(f.storage,owner);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const tx=transaction(db);
 const refs=tx.all('SELECT r.contact_id,r.id AS record_id,r.message_id,m.interpretation_revision,m.text_body FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id WHERE r.owner_id=? ORDER BY r.contact_id,r.id',[owner]);
 async function memory(scope,sources){
  const result=await management.decide({requestKey:randomUUID(),action:'manual',scope,body:'合成且可核对的记忆'});
  for(const source of sources){
   tx.run('INSERT INTO memory_required_message VALUES(?,?,?,?,?,?,?)',[owner,randomUUID(),null,result.memoryId,1n,source.contact_id,source.message_id]);
   tx.run('INSERT INTO memory_citation(owner_id,id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end) VALUES(?,?,?,?,?,?,?,?,?,?)',[owner,randomUUID(),result.memoryId,1n,source.contact_id,source.message_id,source.record_id,source.interpretation_revision,0n,BigInt([...source.text_body].length)]);
  }
  return result.memoryId;
 }
 return {...f,contactId,other,management,db,tx,refs,memory};
}

test('管理页10／100／400条来源以同联系人一次资格SQL核验，结果与逐条核验一致',async t=>{
 for(const count of [10,100,400])await t.test(String(count),async t=>{
  const f=await seeded(t,count),scope={scopeKind:'contact',contactId:f.contactId},refs=f.refs.filter(r=>r.contact_id===f.contactId);
  await f.memory(scope,refs);await f.memory(scope,refs);await f.management.read(scope);
  const queries=[],view=managementRead(transaction(f.db,queries),{ownerId:owner,scope});
  assert.equal(view.memories.length,2);assertSingleVersions(f.tx,view);
  assert.equal(sourceQueries(queries).length,1,`同联系人本页${count}条来源不可逐条查资格`);
 });
});

test('来源失效按项撤下、本人显示范围及本地待复验结果与逐条核验一致',async t=>{
 const f=await seeded(t,3),scope={scopeKind:'self',contactId:null},a=f.refs.filter(r=>r.contact_id===f.contactId),b=f.refs.filter(r=>r.contact_id===f.other);
 const valid=await f.memory(scope,a),invalid=await f.memory(scope,b);await f.management.read(scope);
 const queries=[],read=()=>managementRead({...f.tx,all(sql,values){queries.push(sql);return f.tx.all(sql,values);},get(sql,values){queries.push(sql);return f.tx.get(sql,values);}},{ownerId:owner,scope});
 let view=read();assertSingleVersions(f.tx,view);assert.equal(sourceQueries(queries).length,2);
 f.tx.run("UPDATE conversation_binding SET state='needs_confirmation' WHERE owner_id=? AND contact_id=?",[owner,f.contactId]);
 queries.length=0;view=read();assertSingleVersions(f.tx,view);assert.equal(view.memories.find(m=>m.id===valid).current.sourcePendingRecheck,true);
 assert.equal(sourceQueries(queries).length,3,'当前资格每联系人一次，仅失败联系人补一次本地资格');
 f.tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[owner,f.other,b[0].record_id]);
 queries.length=0;view=read();assertSingleVersions(f.tx,view);assert.equal(view.memories.find(m=>m.id===invalid).current,null);assert.equal(view.memories.find(m=>m.id===invalid).versions[0].body,null);
 const filtered=managementRead(f.tx,{ownerId:owner,scope,displayContactId:f.contactId});
 assert.deepEqual(filtered.memories,[],'手录本人记忆没有冻结贡献联系人，不能仅凭引句猜测显示归属');
 f.tx.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND contact_id=?",[owner,f.contactId]);
 assert.equal(read().memories.find(m=>m.id===valid).current,null,'下一请求必须重新核验，不能沿用先前集合');
});

test('批量集合只收集当前页最新版本，页外记忆不提前核验且翻页无遗漏',async t=>{
 const f=await seeded(t,1),scope={scopeKind:'contact',contactId:f.contactId},refs=f.refs.filter(r=>r.contact_id===f.contactId);
 for(let i=0;i<21;i++)await f.memory(scope,refs);
 await f.management.read(scope);
 const parents=[],tx={...f.tx,all(sql,values){if(sql.startsWith('WITH RECURSIVE versions(memory_id,version_no) AS ('))parents.push(values[0]);return f.tx.all(sql,values);}};
 const first=managementRead(tx,{ownerId:owner,scope});assert.equal(first.memories.length,20);assert.ok(first.page.nextCursor);
 const firstIds=new Set(first.memories.map(m=>m.id));assert.deepEqual(new Set(parents),firstIds,'来源集合不得触及第21条或其他历史版本');
 parents.length=0;const second=managementRead(tx,{ownerId:owner,scope,cursor:first.page.nextCursor});assert.equal(second.memories.length,1);assert.equal(second.page.nextCursor,null);
 assert.ok(second.memories.every(m=>!firstIds.has(m.id)));assert.deepEqual(new Set(parents),new Set(second.memories.map(m=>m.id)));
});

test('正式采纳版本的冻结窗口与本页候选合并核验，失效来源过滤保持一致',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期住在合成地区甲。'],{publish:true});await f.extract(['我长期偏好合成兴趣乙。']);await f.management.read(f.scope);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());const queries=[],tx=transaction(db,queries);
 const view=managementRead(tx,{ownerId:owner,scope:f.scope});assert.equal(view.memories.length,1);assert.equal(view.candidates.length,1);assertSingleVersions(transaction(db),view);
 assert.equal(sourceQueries(queries).length,1,'候选与版本共用同事务的来源集合');
 const source=view.candidates[0].sources[0];tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[owner,source.contactId,source.recordId]);
 const after=managementRead(tx,{ownerId:owner,scope:f.scope});assert.equal(after.candidates.length,0);assertSingleVersions(transaction(db),after);
});
