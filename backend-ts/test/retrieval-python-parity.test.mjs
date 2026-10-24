import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { tokenize, buildQueryTokens,score } from '../src/retrieval-lexical.ts';
import { bm25Scores } from '../src/retrieval-hybrid.ts';
test('合成Unicode及BM25与旧Python独立实现逐项对照',()=>{
 const inputs=['ＴＥＡ Straße 𠀀茶','İ Σς ﬃ K','甲'.repeat(100)+'中'.repeat(30)+'乙'.repeat(100),'😀','茶叶 咖啡','你好\u0301'];
 const script=`import json,sys\nfrom dataclasses import asdict\nfrom notalone.retrieval.lexical import tokenize,build_query_tokens,score\nfrom notalone.memory_extraction.recall import bm25_scores\nxs=json.load(sys.stdin)\nprint(json.dumps([dict(tokens=[asdict(t) for t in tokenize(s)],query=[asdict(t) for t in build_query_tokens(s)],score=asdict(score(s,'tea 茶叶 Straße')),bm25=bm25_scores(s,xs)) for s in xs]))`;
 const rows=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script],{input:JSON.stringify(inputs),env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:30000}));
 for(let i=0;i<inputs.length;i++){
  assert.deepEqual(tokenize(inputs[i]),rows[i].tokens);assert.deepEqual(buildQueryTokens(inputs[i]),rows[i].query);assert.deepEqual(score(inputs[i],'tea 茶叶 Straße'),rows[i].score);
  bm25Scores(inputs[i],inputs).forEach((s,j)=>assert.ok(Math.abs(s-rows[i].bm25[j])<1e-12));
 }
});
test('Unicode兼容分解与casefold单码点逐项对照',()=>{
 const inputs=[];for(let cp=0;cp<=0x10ffff;cp++){const s=String.fromCodePoint(cp);if(s.normalize('NFKC')!==s||s.toLowerCase()!==s)inputs.push(s);}
 const script=`import json,sys\nfrom dataclasses import asdict\nfrom notalone.retrieval.lexical import tokenize\nprint(json.dumps([[asdict(t) for t in tokenize(s)] for s in json.load(sys.stdin)]))`;
 const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script],{input:JSON.stringify(inputs),env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:30000,maxBuffer:5*1024*1024}));
 for(let i=0;i<inputs.length;i++)assert.deepEqual(tokenize(inputs[i]),expected[i],`U+${inputs[i].codePointAt(0).toString(16)}`);
});
