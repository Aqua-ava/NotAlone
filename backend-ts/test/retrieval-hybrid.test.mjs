import test from 'node:test';
import assert from 'node:assert/strict';
import { bm25Scores, hybridCandidates } from '../src/retrieval/retrieval-hybrid.ts';
test('语义零和负分保留，故障不词法兜底，DF随池重算',async()=>{
 const pool=[{memory_id:'b',text:'咖啡'},{memory_id:'a',text:'雨天'}];
 assert.deepEqual((await hybridCandidates(['茶'],pool,async()=>[[1,0],[-1,0],[0,0]]))[0].map(r=>r.memory_id),['a','b']);
 await assert.rejects(hybridCandidates(['茶'],pool,async()=>{throw Error('embedding_unavailable');}),/embedding_unavailable/);
 const one=bm25Scores('茶叶',['茶叶']);
 assert.ok(bm25Scores('茶叶',['茶叶','咖啡'])[0]>one[0]);
 assert.deepEqual(bm25Scores('茶',['茶']),[0]);
});
test('每路切片含旧零/负预算与最终UUID同分保持合同',async()=>{
 const pool=[{memory_id:'3',text:'周末游泳'},{memory_id:'2',text:'周末跑步'},{memory_id:'1',text:'固定读书'}];
 for(const [k,ids] of [[0,[]],[1,['2']],[2,['2','3']],[3,['2','3','1']],[8,['2','3','1']],[-1,['3']]]){
  const result=await hybridCandidates(['周末游泳'],pool,async()=>[[1,0],[0,1],[1,0],[-1,0]],k);
  assert.deepEqual(result[0].map(r=>r.memory_id),ids);
 }
});
