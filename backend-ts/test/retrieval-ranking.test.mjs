import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMemories } from '../src/retrieval/retrieval-ranking.ts';
import { buildQueryTokens } from '../src/retrieval/retrieval-lexical.ts';
test('相关度、人工采纳、置信度、微秒时间、UUID顺序及pending不冒充人工',()=>{
 const base={text:'茶',confidence:1,adoption_method:'auto',valid_at:null};
 const rows=[{...base,memory_id:'b'}, {...base,memory_id:'a'}, {...base,memory_id:'c',valid_at:'2026-01-01T00:00:00.000001Z'}, {...base,memory_id:'d',valid_at:'2026-01-01T00:00:00.000002Z'}, {...base,memory_id:'e',adoption_method:'manual'}, {...base,candidate_id:'f',adoption_method:'manual'}];
 assert.deepEqual(rankMemories(rows,buildQueryTokens('茶'),6).map(r=>r.memory_id??r.candidate_id),['e','d','c','a','b','f']);
});
