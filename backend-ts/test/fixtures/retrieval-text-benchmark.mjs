/** 比较真实合成 SQLite 文本回填的分页身份、SQL 次数和局部耗时，不运行模型。 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture,owner,record} from './memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../../src/memory/sqlite/management/service.ts';
import {configureRetrievalConnection} from '../../src/retrieval/sqlite/extension.ts';

const args=process.argv.slice(2),current=fileURLToPath(new URL('../../src/retrieval/sqlite/actions.ts',import.meta.url));
assert.ok(args.length===0||args.length===2&&args[0]==='--compare-actions-module'&&isAbsolute(args[1]),
 '用法：node test/fixtures/retrieval-text-benchmark.mjs [--compare-actions-module /绝对路径/固定旧动作.mts]');
const modules=await Promise.all([...(args.length?[['before',args[1]]]:[]),['current',current]].map(async([label,path])=>({
 label,sourceSHA256:createHash('sha256').update(await readFile(path)).digest('hex'),
 action:(await import(pathToFileURL(path).href)).retrievalIndexActions.find(action=>action.name==='retrieval.syncTextBatch'),
})));
const results=[],repeats=5;
for(const count of [10,100,1000]){
 const cleanups=[],f=await fixture({after:cleanup=>cleanups.push(cleanup)});
 let db;
 try{
  const [contactId,otherId]=f.saved.map(binding=>binding.contact_id);
  f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
   records:Array.from({length:count},(_,n)=>record(String(n+1))),completedPartitions:['shard-a'],exhausted:true});
  await f.service.synchronize(contactId);await f.service.synchronize(otherId);
  const management=new SqliteMemoryManagement(f.storage,owner);
  for(const contact of [contactId,otherId,null])await management.decide({requestKey:randomUUID(),action:'manual',
   scope:{scopeKind:contact===null?'self':'contact',contactId:contact},body:'合成文本回填偏好'});
  db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{allowExtension:true});configureRetrievalConnection(db);
  // 三组身份分别只排队、只过期及两者重叠，UNION 必须只处理每个身份一次。
  db.exec("UPDATE retrieval_document SET tokenizer_fingerprint='synthetic-stale-tokenizer' WHERE id%3<>0;INSERT INTO retrieval_text_pending SELECT owner_id,kind,entity_id,contact_id FROM retrieval_document WHERE id%3<>1");
  const statements=new Map(),statement=sql=>{
   if(!statements.has(sql)){const prepared=db.prepare(sql);prepared.setReadBigInts(true);statements.set(sql,prepared);}
   return statements.get(sql);
  };
  let reads=0,writes=0,countQueries=0,ids=[];
  const tx={
   all(sql,values=[]){reads++;if(/COUNT\s*\(/i.test(sql))countQueries++;return statement(sql).all(...values);},
   get(sql,values=[]){reads++;if(/COUNT\s*\(/i.test(sql))countQueries++;return statement(sql).get(...values);},
   run(sql,values=[]){writes++;if(sql.startsWith('DELETE FROM retrieval_text_pending WHERE'))ids.push(`${values[1]}:${values[2]}`);return statement(sql).run(...values);},
  };
  const documents=db.prepare('SELECT kind,entity_id,contact_id FROM retrieval_document ORDER BY kind,entity_id').all();
  const cases=[{name:'global',limit:128},{name:'contact-history',contactId,kind:'history',limit:10},
   {name:'contact-memory-and-self',contactId,kind:'memory',limit:2},{name:'unavailable-contact',contactId:'synthetic-missing-contact',limit:8}];
  for(const scope of cases){
   const expected=documents.filter(row=>(scope.contactId===undefined||row.contact_id===scope.contactId||row.contact_id===null)
    &&(scope.kind===undefined||row.kind===scope.kind)).map(row=>`${row.kind}:${row.entity_id}`);
   if(scope.name==='unavailable-contact')expected.length=0;
   const samples=modules.map(()=>[]);
   // 每次回滚到同一批身份、分词与队列，交错顺序减小预热偏差。
   for(let run=0;run<repeats;run++)for(const index of modules.map((_,n)=>n).sort((a,b)=>run%2?b-a:a-b)){
    db.exec('SAVEPOINT text_benchmark');reads=0;writes=0;countQueries=0;
    const {name,...input}=scope,pages=[],start=performance.now();
    try{
     for(let page=0;;page++){
      assert.ok(page<512,'文本回填必须在有限分页内结束');ids=[];
      const batch=modules[index].action.execute(tx,{ownerId:owner,...input});
      const scanMore=Object.hasOwn(batch,'scanMore')?batch.scanMore:batch.remaining>0;
      assert.equal(typeof scanMore,'boolean');assert.equal(batch.processed,ids.length);
      pages.push({ids,scanMore});if(!scanMore)break;
     }
     assert.deepEqual(pages.flatMap(page=>page.ids),expected,'范围、顺序和去重身份保持一致');
     const empty=modules[index].action.execute(tx,{ownerId:owner,...input});
     assert.equal(empty.processed,0);assert.equal(Object.hasOwn(empty,'scanMore')?empty.scanMore:empty.remaining>0,false);
     samples[index].push({pages,reads,writes,countQueries,ms:performance.now()-start});
    }finally{db.exec('ROLLBACK TO text_benchmark;RELEASE text_benchmark');}
   }
   const baseline=samples[0][0].pages;
   for(const sample of samples.flat())assert.deepEqual(sample.pages,baseline,'同一工作负载的分页及继续信号必须一致');
   results.push({historyPerContact:count,scope:scope.name,observations:samples.map((runs,index)=>{
    const sample=runs[0],times=runs.map(run=>run.ms).sort((a,b)=>a-b);
    for(const run of runs)assert.deepEqual([run.reads,run.writes,run.countQueries],[sample.reads,sample.writes,sample.countQueries]);
    return {label:modules[index].label,pages:sample.pages.length,processed:expected.length,reads:sample.reads,writes:sample.writes,
     countQueries:sample.countQueries,medianMs:Number(times[Math.floor(repeats/2)].toFixed(3)),
     paginationSHA256:createHash('sha256').update(JSON.stringify(sample.pages)).digest('hex')};
   })});
  }
 }finally{db?.close();for(const cleanup of cleanups.reverse())await cleanup();}
}
console.log(JSON.stringify({node:process.version,sqlite:process.versions.sqlite,repeats,
 workload:'同一真实合成SQLite，两位联系人各10/100/1000条文字及三条人工记忆；排队与旧分词交叠；每次回滚，交错五次；含文本回填SQL与分词，不含Worker IPC、ONNX、外部模型或整体App耗时',
 modules:modules.map(({action,...module})=>module),results},null,2));
