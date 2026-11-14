import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import * as dependencies from '../src/memory/sqlite/management/dependencies.ts';
import {assertSourceEligibility} from '../src/history/sqlite/source.ts';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';

async function layered(t){
 const f=await adjudicationFixture(t);
 await f.extract(['我长期喜欢合成园艺。'],{publish:true});
 f.setRespond(adjudicationSupplier({action:'update'}));
 await f.extract(['我现在长期喜欢合成登山。'],{publish:true});
 const memory=(await f.read()).memories[0];assert.equal(memory.current.versionNo,'2');
 await f.extract(['我长期偏好合成白茶。']);
 const candidate=(await f.read()).candidates.find(item=>item.state==='pending');assert.ok(candidate);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 let closureQueries=0;
 const tx={
  all(sql,values=[]){if(/^\s*WITH RECURSIVE versions/.test(sql))closureQueries++;const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);},
  get(sql,values=[]){const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.get(...values);},
  run(sql,values=[]){return db.prepare(sql).run(...values);},
 };
 const within=work=>{
  db.exec('BEGIN');closureQueries=0;
  try{return dependencies.withQualificationSources(tx,work);}
  finally{db.exec('ROLLBACK');}
 };
 return {...f,tx,within,memoryId:memory.id,versionNo:2n,candidateId:candidate.id,get closureQueries(){return closureQueries;}};
}

test('同一SQLite动作的多层自动依赖只展开一次并核验唯一来源，完整闭包不丢失',async t=>{
 const f=await layered(t);let checks=0;
 const eligibility=(tx,ref)=>{checks++;assertSourceEligibility(tx,ref);};
 const result=f.within(()=>{
  const parent={memoryId:f.memoryId,versionNo:f.versionNo},candidate={candidateId:f.candidateId};
  const prior=dependencies.qualificationSources(f.tx,f.owner,parent,eligibility);
  const current=dependencies.qualificationSources(f.tx,f.owner,candidate,eligibility);
  const again=dependencies.qualificationSources(f.tx,f.owner,parent,eligibility);
  const againCandidate=dependencies.qualificationSources(f.tx,f.owner,candidate,eligibility);
  assert.deepEqual(again,prior);assert.deepEqual(againCandidate,current);
  return dependencies.mergeKnowledgeSources(prior,current);
 });
 t.diagnostic(JSON.stringify({closureQueries:f.closureQueries,checks,distinctSources:result.length}));
 assert.equal(result.length,3,'两层自动版本和待裁决候选的三条来源完整保留');
 assert.equal(f.closureQueries,2,'每个冻结父身份在一次动作只展开一次');
 assert.equal(checks,3,'重复父项与重叠闭包只复用同一策略下成功核验的来源');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('缓存不跨owner、来源核验函数或SQLite动作；异常退出和来源失效后必须重新核验',async t=>{
 const f=await layered(t),parent={memoryId:f.memoryId,versionNo:f.versionNo};let allowed=0,denied=0;
 const first=(tx,ref)=>{allowed++;assertSourceEligibility(tx,ref);};
 const reject=()=>{denied++;throw Object.assign(new Error('合成不同来源策略拒绝'),{code:'synthetic_policy_denied'});};
 f.within(()=>{
  assert.deepEqual(dependencies.qualificationSourceRows(f.tx,'00000000-0000-4000-8000-000000009999',parent),[]);
  assert.equal(dependencies.qualificationSources(f.tx,f.owner,parent,first).length,2);
  assert.throws(()=>dependencies.qualificationSources(f.tx,f.owner,parent,reject),{code:'synthetic_policy_denied'});
 });
 assert.equal(allowed,2);assert.equal(denied,1);
 assert.throws(()=>f.within(()=>{dependencies.qualificationSources(f.tx,f.owner,parent,first);throw new Error('合成动作回滚');}),/合成动作回滚/);
 assert.equal(allowed,4,'同一个tx包装对象的新动作不能沿用旧资格');
 await f.storage.execute('fixture.quarantineMemorySources',{ownerId:f.owner,memoryId:f.memoryId});
 assert.throws(()=>f.within(()=>dependencies.qualificationSources(f.tx,f.owner,parent,first)),{code:'history_source_not_available'});
 await f.storage.execute('fixture.releaseMemorySources',{ownerId:f.owner,memoryId:f.memoryId});
 assert.equal(f.within(()=>dependencies.qualificationSources(f.tx,f.owner,parent,first)).length,2,'失败不能被缓存为成功，恢复后仍须重新核验');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('冻结依赖缓存保留两个root并集与返回值独立性，部分失败不公开已通过的单项资格',async t=>{
 const f=await layered(t),parent={memoryId:f.memoryId,versionNo:f.versionNo};
 f.within(()=>{
  const rows=dependencies.qualificationSourceRows(f.tx,f.owner,parent),expected=structuredClone(rows);
  rows[0].record_id='synthetic-mutated-result';rows.pop();
  assert.deepEqual(dependencies.qualificationSourceRows(f.tx,f.owner,parent),expected,'调用方修改数组或行对象不能污染缓存');
  assert.equal(dependencies.qualificationSources(f.tx,f.owner,{...parent,candidateId:f.candidateId}).length,3,'同时给出候选与记忆root仍保留原递归并集');
  let checks=0,reject=true;
  const eligibility=(tx,ref)=>{checks++;assertSourceEligibility(tx,ref);if(reject&&checks===2)throw Object.assign(new Error('合成第二来源拒绝'),{code:'synthetic_partial_rejection'});};
  assert.throws(()=>dependencies.qualificationSources(f.tx,f.owner,parent,eligibility),{code:'synthetic_partial_rejection'});
  reject=false;
  assert.equal(dependencies.qualificationSources(f.tx,f.owner,parent,eligibility).length,2);
  assert.equal(checks,4,'父项整体失败后，两条来源都重新核验');
 });
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
