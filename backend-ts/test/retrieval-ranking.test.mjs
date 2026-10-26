import test from 'node:test';
import assert from 'node:assert/strict';
import { recallMemories, mergeMemoryRecalls } from '../src/retrieval/retrieval-ranking.ts';
test('相关度、人工采纳、置信度、微秒时间、UUID顺序及pending不冒充人工',()=>{
 const base={text:'茶',confidence:1,adoption_method:'auto',valid_at:null};
 const rows=[{...base,memory_id:'b'}, {...base,memory_id:'a'}, {...base,memory_id:'c',valid_at:'2026-01-01T00:00:00.000001Z'}, {...base,memory_id:'d',valid_at:'2026-01-01T00:00:00.000002Z'}, {...base,memory_id:'e',adoption_method:'manual'}, {...base,candidate_id:'f',adoption_method:'manual'}];
 assert.deepEqual(recallMemories(rows,'茶',6).map(r=>r.memory_id??r.candidate_id),['e','d','c','a','b','f']);
 assert.deepEqual(recallMemories(rows,'😀',6),[]);
 assert.deepEqual(recallMemories(rows,null,2),rows.slice(0,2));
 const merged=mergeMemoryRecalls([[{...rows[0],relevance_score:.1}],[{...rows[0],relevance_score:.8}]]);
 assert.equal(merged[0].relevance_score,.8);
});
