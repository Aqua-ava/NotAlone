import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {reciprocalRankFusion} from '../src/retrieval/hybrid-ranking.ts';
import {indexText,buildFtsQuery,searchTokenizerFingerprint} from '../src/retrieval/search-tokenizer.ts';

test('两路共同靠前的资料优先，RRF不受两路原始分数量纲影响',()=>{
 const lexical=[{id:'literal',score:900},{id:'both',score:1}],dense=[{id:'semantic',score:.99},{id:'both',score:.51}];
 const result=reciprocalRankFusion([lexical,dense],item=>item.id);
 assert.equal(result[0].item.id,'both');assert.equal(result[0].score,2/62);assert.equal(result.length,3);
 assert.deepEqual(reciprocalRankFusion([lexical.map(x=>({...x,score:-123})),dense.map(x=>({...x,score:0}))],x=>x.id).map(x=>[x.item.id,x.score]),result.map(x=>[x.item.id,x.score]));
});
test('RRF单路可用、同路重复不加权、等分顺序稳定且遵守返回量',()=>{
 assert.deepEqual(reciprocalRankFusion([[{id:'b'},{id:'b'}],[],[{id:'a'}]],x=>x.id,2).map(x=>[x.item.id,x.score]),[['a',1/61],['b',1/61]]);
 assert.deepEqual(reciprocalRankFusion([[],[]],x=>x.id),[]);
});
test('中文写入和查询使用同一搜索分词，FTS能命中完整词与子词并拒绝查询语法注入',()=>{
 assert.equal(searchTokenizerFingerprint(),'jieba-2.0.1-search-v1');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE VIRTUAL TABLE docs USING fts5(tokens)');
  db.prepare('INSERT INTO docs(rowid,tokens) VALUES(?,?)').run(1,indexText('人工智能的分支与程序设计'));
  db.prepare('INSERT INTO docs(rowid,tokens) VALUES(?,?)').run(2,indexText('今天去公园散步'));
  assert.deepEqual(db.prepare('SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY bm25(docs)').all(buildFtsQuery('人工智能')).map(x=>x.rowid),[1]);
  assert.equal(buildFtsQuery('的 呢 嗯'),null);
  assert.doesNotThrow(()=>db.prepare('SELECT rowid FROM docs WHERE docs MATCH ?').all(buildFtsQuery('"人工智能" OR NOT *')));
 }finally{db.close();}
});
