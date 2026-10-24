import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createLocalEmbedding,embeddingSnapshot} from '../src/retrieval-embedding.ts';
test('固定本地权重、token IDs和mask、CLS归一化与Python实际推理对照',async()=>{
 const texts=['合成联系人喜欢清淡食物。','ＴＥＡ Straße 𠀀茶','你好😀\u0000世界','茶'.repeat(600),'[MASK] 喝茶','İ Σς ﬃ K',''];
 const model=await createLocalEmbedding();
 try{
  const script=`import json,sys\nfrom pathlib import Path\nfrom fastembed import TextEmbedding\nfrom fastembed.common.preprocessor_utils import load_tokenizer\ntexts=json.load(sys.stdin); path=Path(sys.argv[1]); tok,_=load_tokenizer(path); encoded=tok.encode_batch(texts)\nm=TextEmbedding('BAAI/bge-small-zh-v1.5',specific_model_path=str(path),local_files_only=True,threads=2)\nprint(json.dumps(dict(ids=[r.ids for r in encoded],mask=[r.attention_mask for r in encoded],vectors=[r.tolist() for r in m.embed(texts)])))`;
  const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script,embeddingSnapshot()],{input:JSON.stringify(texts),timeout:60000}));
  assert.deepEqual(model.encode(texts),{ids:expected.ids,mask:expected.mask});
  const actual=await model.embed(texts);
  let maximum=0;
  for(let i=0;i<actual.length;i++)for(let j=0;j<512;j++)maximum=Math.max(maximum,Math.abs(actual[i][j]-expected.vectors[i][j]));
  assert.ok(maximum<1e-5,`向量最大绝对误差 ${maximum}`);
  console.log(JSON.stringify({embedding_cases:texts.length,dimensions:512,max_absolute_error:maximum,tolerance:1e-5}));
 }finally{await model.close();}
});
test('缺失模型明确失败，无词法或网络回退',async()=>{await assert.rejects(createLocalEmbedding('/tmp/notalone-nonexistent-embedding-fixture'),/embedding_unavailable/);});
test('同权重实际语义向量参与RRF后与Python排名一致',async()=>{
 const {hybridCandidates}=await import('../src/retrieval-hybrid.ts');
 const queries=['周末跑步','不喝咖啡','喜欢清淡食物','一起读书'];
 const pool=['周末游泳','周末跑步','固定读书','不喝咖啡','喜欢清淡食物','喜欢清淡食物'].map((text,i)=>({memory_id:`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`,text}));
 const model=await createLocalEmbedding();
 try{
  const script=`import json,sys\nfrom types import SimpleNamespace\nfrom notalone.memory_extraction.recall import hybrid_candidates\na=json.load(sys.stdin)\nprint(json.dumps([[r.memory_id for r in rows] for rows in hybrid_candidates(a['queries'],[SimpleNamespace(**row) for row in a['pool']])]))`;
  const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script],{input:JSON.stringify({queries,pool}),env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_IMPLICIT_TOKEN:'1'},timeout:60000}));
  assert.deepEqual((await hybridCandidates(queries,pool,model.embed)).map(rows=>rows.map(r=>r.memory_id)),expected);
 }finally{await model.close();}
});
