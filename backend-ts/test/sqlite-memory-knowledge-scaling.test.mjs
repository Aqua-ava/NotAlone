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

test('联系人BM25召回及预算选择只核验有界排名候选，与整池核验使用同一排名',{timeout:60000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/knowledge-scaling-registry.mjs',import.meta.url).href});
 const contactId=(await f.contacts.directory()).contacts[0].contact_id;
 const management=new SqliteMemoryManagement(f.storage,owner),scope={scopeKind:'contact',contactId},measurements=[];
 for(let index=0;index<1000;index++){
  // 每条都含“园艺”，共享 BM25 召回再按精确来源核验；最终只选择五条，不沿用旧词法门槛。
  await management.decide({requestKey:`selection-${index}`,action:'manual',scope,body:`园艺合成资料第${index}项，种植编号${index}。`});
  if(index===99||index===999){
   const result=await f.storage.execute('fixture.measureSelection',{scope:{ownerId:owner,contactId,discussionId:'synthetic'},query:'园艺'});
   assert.equal(result.poolSize,index+1);
   assert.equal(result.lazyIds.length,5,'联系人记忆条数预算');
   assert.deepEqual(result.lazyIds,result.eagerIds,'同一BM25排名下按需核验不得改变入选结果与顺序');
   assert.ok(result.openCount<=60,'当前top-K放大最多核验60个有效排名候选，不把只有五条最终结果误称为只核验五条');
   measurements.push(result);
  }
 }
 t.diagnostic(JSON.stringify(measurements.map(({lazyIds,eagerIds,...value})=>value)));
 // 这里只测共享召回和选择，不把它冒充完整候选请求的来源准备、票据和最终冻结成本。
 assert.ok(measurements[1].lazyQueries<=measurements[0].lazyQueries+10,'超过召回候选容量后，十倍池大小不应增加逐项来源核验次数');
 assert.ok(measurements[1].lazyQueries*5<=measurements[1].eagerQueries,'1000条记忆下有界召回应避免整池逐项核验');
});
