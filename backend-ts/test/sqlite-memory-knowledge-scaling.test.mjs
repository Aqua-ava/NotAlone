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
