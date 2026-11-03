import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBusinessEmbeddingFactory,createLocalEmbeddingLifecycle} from '../src/platform/models/local-embedding-lifecycle.ts';

test('宿主从明确的业务目录读取模型，不沿用DSH运行目录',async t=>{
 const businessHome=await mkdtemp(join(tmpdir(),'notalone-embedding-home-'));
 t.after(()=>rm(businessHome,{recursive:true,force:true}));
 const open=createBusinessEmbeddingFactory(businessHome);
 await assert.rejects(open(),error=>error.name==='EmbeddingUnavailableError'
  &&error.cause?.code==='ENOENT'
  &&error.cause?.path===join(businessHome,'.cache/notalone/memory-embedding/models--Qdrant--bge-small-zh-v1.5/snapshots/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59/model_optimized.onnx'));
});

test('宿主沿用显式准备的绝对缓存目录，拒绝相对路径',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'notalone-embedding-cache-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await assert.rejects(createBusinessEmbeddingFactory('/synthetic/business-home',directory)(),error=>
  error.cause?.code==='ENOENT'&&error.cause.path.startsWith(directory+'/models--Qdrant--bge-small-zh-v1.5/'));
 assert.throws(()=>createBusinessEmbeddingFactory('/synthetic/business-home','relative-cache'),error=>
  error.name==='EmbeddingUnavailableError'&&error.cause?.message==='embedding_cache_path_invalid');
});

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

test('本机embedding释放失败保留原模型，明确重试只释放一次且不再接收推理',async()=>{
 let opens=0,closes=0;
 const failure=new Error('合成释放失败');
 const lifecycle=createLocalEmbeddingLifecycle(async()=>{
  opens++;
  return {embed:async()=>[[1]],close:async()=>{if(++closes===1)throw failure;}};
 });
 await lifecycle.embed(['合成']);
 const first=lifecycle.close();
 assert.equal(lifecycle.close(),first);
 await assert.rejects(first,error=>error===failure);
 assert.equal(lifecycle.opened(),true);
 await assert.rejects(lifecycle.embed(['关闭后']),error=>error.cause?.message==='embedding_host_closed');
 await lifecycle.close();
 await lifecycle.close();
 assert.equal(closes,2);
 assert.equal(opens,1);
 assert.equal(lifecycle.opened(),false);
});

test('本机embedding打开期间退出保留迟到模型，释放失败必须报告并允许重试',async()=>{
 let resolveOpen,opens=0,embeds=0,closes=0;
 const opened=new Promise(resolve=>{resolveOpen=resolve;});
 const failure=new Error('合成迟到资源释放失败');
 const lifecycle=createLocalEmbeddingLifecycle(()=>{opens++;return opened;});
 const embedding=lifecycle.embed(['合成']).then(()=>assert.fail('退出后不能开始推理'),error=>error);
 const closing=lifecycle.close();
 resolveOpen({embed:async()=>{embeds++;return [[1]];},close:async()=>{if(++closes===1)throw failure;}});
 await assert.rejects(closing,error=>error===failure);
 assert.equal((await embedding).cause?.message,'embedding_host_closed');
 assert.equal(lifecycle.opened(),true);
 await assert.rejects(lifecycle.embed(['关闭后']),error=>error.cause?.message==='embedding_host_closed');
 await lifecycle.close();
 assert.equal(opens,1);
 assert.equal(embeds,0);
 assert.equal(closes,2);
 assert.equal(lifecycle.opened(),false);
});
