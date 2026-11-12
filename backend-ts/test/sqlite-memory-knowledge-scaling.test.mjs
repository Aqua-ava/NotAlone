import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

test('正式记忆逐项复核只查询指定身份，工作量随资料数线性增长',{timeout:30000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/knowledge-scaling-registry.mjs',import.meta.url).href});
 const contactId=(await f.contacts.directory()).contacts[0].contact_id;
 const management=new SqliteMemoryManagement(f.storage,owner),scope={scopeKind:'contact',contactId},ids=[];
 const measurements=[];
 for(let index=0;index<100;index++){
  const saved=await management.decide({requestKey:`synthetic-${index}`,action:'manual',scope,body:`合成联系人第${index}项生活背景。`});ids.push(saved.memoryId);
  if(index===9||index===99){
   const result=await f.storage.execute('fixture.measureKnowledge',{ownerId:owner,contactId,discussionId:'synthetic'});
   assert.equal(result.count,index+1);assert.deepEqual([...result.ids].sort(),[...ids].sort());
   measurements.push(result);
  }
 }
 t.diagnostic(JSON.stringify(measurements.map(({ids,...measurement})=>measurement)));
 // 放大十倍资料允许少量固定开销，但不能重新读取每一条无关记忆。
 assert.ok(measurements[1].queries<=measurements[0].queries*12,'逐项资格复核不应产生平方级查询');
 assert.ok(measurements[1].fullScans<=2,'复核指定版本不应重新扫描完整目录');
});

test('回复挑选记忆只对入选条目核验来源：查询量不随记忆池增长，结果与整体核验后再排序一致',{timeout:60000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/knowledge-scaling-registry.mjs',import.meta.url).href});
 const contactId=(await f.contacts.directory()).contacts[0].contact_id;
 const management=new SqliteMemoryManagement(f.storage,owner),scope={scopeKind:'contact',contactId},measurements=[];
 for(let index=0;index<100;index++){
  // 每条都含共同词“园艺”，全部满足相关性门槛；预算只收前五条，其余无需核验。
  await management.decide({requestKey:`selection-${index}`,action:'manual',scope,body:`园艺合成资料第${index}项，种植编号${index}。`});
  if(index===9||index===99){
   const result=await f.storage.execute('fixture.measureSelection',{scope:{ownerId:owner,contactId,discussionId:'synthetic'},query:'园艺'});
   assert.equal(result.poolSize,index+1);
   assert.equal(result.lazyIds.length,5,'联系人记忆条数预算');
   assert.deepEqual(result.lazyIds,result.eagerIds,'按需核验不得改变入选结果与顺序');
   measurements.push(result);
  }
 }
 t.diagnostic(JSON.stringify(measurements.map(({lazyIds,eagerIds,...value})=>value)));
 // 列出头部是常数次查询，核验次数固定为入选条数：十倍记忆池下总量不变，整体核验则线性增长。
 assert.ok(measurements[1].lazyQueries<=measurements[0].lazyQueries+10,'列出头部是常数次查询，核验只随入选条数增长，不能随记忆池线性增长');
 assert.ok(measurements[1].lazyQueries*5<=measurements[1].eagerQueries,'100 条记忆下按需核验至少少 5 倍查询');
});
