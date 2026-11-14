import test from 'node:test';
import assert from 'node:assert/strict';
import {record} from './fixtures/memory-sqlite/support.mjs';
import {unifiedChainFixture} from './fixtures/memory-content/unified-chain.mjs';

test('纯文字来源增长时正式裁决不逐条重复物化并重建完整比较池',async t=>{
 const measurements=[];
 for(const parents of [1,5]){
  const f=await unifiedChainFixture(t);
  await f.sync(Array.from({length:parents},(_,index)=>record(String(index+1),{text:`我长期喜欢合成项目${index+1}。`})));
  assert.equal((await f.run()).state,'completed');
  assert.equal((await f.read()).memories.length,parents);
  const execute=f.storage.execute.bind(f.storage),before=f.adjudicationRequests.length;
  let current=0,materials=0;
  f.storage.execute=async(name,input)=>{
   if(name==='memoryAdjudication.current')current++;
   if(name==='memoryAdjudication.materials')materials++;
   return execute(name,input);
  };
  await f.sync([record('31',{text:'我长期保留另一项合成计划。'})]);
  assert.equal((await f.run()).state,'completed',JSON.stringify(f.failures));
  assert.equal((await f.read()).memories.length,parents+1);
  assert.equal(f.adjudicationRequests.length-before,2,'同一页仍完整执行裁决与独立关系核验');
  measurements.push({parents,current,materials});
 }
 t.diagnostic(JSON.stringify({syntheticTextSourceGrowth:measurements,measurement:'正式提取、裁决及发布；仅模型语义由合成供应商提供'}));
 assert.ok(measurements.every(result=>result.current>0&&result.materials===2),'发送与提交的权威复验仍执行');
 assert.equal(measurements[1].current,measurements[0].current,'同页文字来源增加不应新增完整比较池的重建次数');
});
