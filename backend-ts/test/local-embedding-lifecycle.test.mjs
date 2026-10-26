import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalEmbeddingLifecycle} from '../src/platform/models/local-embedding-lifecycle.ts';

test('本机embedding惰性打开、并发复用，关闭先排空在途推理且不再重开',async()=>{
 let opens=0,closes=0,embeddingStarted;
 const releases=[];
 const started=new Promise(resolve=>{embeddingStarted=resolve;});
 const lifecycle=createLocalEmbeddingLifecycle(async()=>{
  opens++;
  return {
   async embed(texts){
    embeddingStarted();
    await new Promise(resolve=>{releases.push(resolve);});
    return texts.map(text=>[String(text).length,1]);
   },
   async close(){closes++;},
  };
 });
 assert.equal(lifecycle.opened(),false);
 const first=lifecycle.embed(['合成甲']);
 await started;
 const second=lifecycle.embed(['合成乙']);
 while(releases.length<2)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(opens,1);
 let closed=false;
 const closing=lifecycle.close().then(()=>{closed=true;});
 await Promise.resolve();
 assert.equal(closed,false);
 releases.forEach(release=>release());
 assert.deepEqual(await first,[[3,1]]);
 assert.deepEqual(await second,[[3,1]]);
 await closing;
 assert.equal(closes,1);
 assert.equal(lifecycle.opened(),false);
 await assert.rejects(lifecycle.embed(['关闭后']),error=>error.name==='EmbeddingUnavailableError'
  &&error.cause?.message==='embedding_host_closed');
 assert.equal(opens,1);
});
