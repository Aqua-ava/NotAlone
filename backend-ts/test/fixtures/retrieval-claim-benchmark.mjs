/** 比较真实合成 SQLite 的向量领取查询次数与分页身份；不运行模型或推理。 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture,owner,record} from './memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../../src/memory/sqlite/management/service.ts';
import {configureRetrievalConnection} from '../../src/retrieval/sqlite/extension.ts';
import {RETRIEVAL_MODEL_FINGERPRINT} from '../../src/retrieval/sqlite/contracts.ts';

const args=process.argv.slice(2),current=fileURLToPath(new URL('../../src/retrieval/sqlite/actions.ts',import.meta.url));
assert.ok(args.length===0||args.length===2&&args[0]==='--compare-actions-module'&&isAbsolute(args[1]),
 '用法：node test/fixtures/retrieval-claim-benchmark.mjs [--compare-actions-module /绝对路径/固定旧动作.mts]');
const modules=await Promise.all([...(args.length?[['before',args[1]]]:[]),['current',current]].map(async([label,path])=>({
 label,sourceSHA256:createHash('sha256').update(await readFile(path)).digest('hex'),
 action:(await import(pathToFileURL(path).href)).retrievalIndexActions.find(action=>action.name==='retrieval.claimVectorBatch'),
})));
const cleanups=[],f=await fixture({after:cleanup=>cleanups.push(cleanup)});
let db;
try{
 const [contactId,otherId]=f.saved.map(binding=>binding.contact_id);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:Array.from({length:24},(_,n)=>record(String(n+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.service.synchronize(otherId);
 const management=new SqliteMemoryManagement(f.storage,owner);
 await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'合成联系人偏好'});
 await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'self',contactId:null},body:'合成本人偏好'});
 db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{allowExtension:true});configureRetrievalConnection(db);
 const statements=new Map(),statement=sql=>{
  if(!statements.has(sql)){const prepared=db.prepare(sql);prepared.setReadBigInts(true);statements.set(sql,prepared);}
  return statements.get(sql);
 };
 let reads=0,writes=0,countQueries=0;
 const tx={
  all(sql,values=[]){reads++;if(/COUNT\s*\(/i.test(sql))countQueries++;return statement(sql).all(...values);},
  get(sql,values=[]){reads++;if(/COUNT\s*\(/i.test(sql))countQueries++;return statement(sql).get(...values);},
  run(sql,values=[]){writes++;return statement(sql).run(...values);},
 };
 const cases=[{name:'global'},{name:'contact-memory',contactId,kind:'memory'},{name:'contact-history',contactId,kind:'history'}];
 const results=[];
 for(const scope of cases){
  const observations=[];
  for(const module of modules){
   db.prepare('DELETE FROM retrieval_vector_cursor WHERE owner_id=?').run(owner);
   reads=0;writes=0;countQueries=0;
   const {name,...input}=scope,pages=[];
   for(let page=0;;page++){
    assert.ok(page<64,'领取必须在固定尾界结束');
    const batch=module.action.execute(tx,{ownerId:owner,modelFingerprint:RETRIEVAL_MODEL_FINGERPRINT,limit:8,...input});
    assert.equal(typeof batch.scanMore,'boolean');
    pages.push({ids:batch.items.map(item=>item.docId),scanMore:batch.scanMore});
    if(!batch.scanMore)break;
   }
   observations.push({label:module.label,pages,reads,writes,countQueries});
  }
  if(observations.length===2)assert.deepEqual(observations[1].pages,observations[0].pages,'同一资料的领取身份和分页边界保持一致');
  results.push({scope:scope.name,observations:observations.map(({pages,...result})=>({...result,pages:pages.length,
   claimed:pages.reduce((n,page)=>n+page.ids.length,0),paginationSHA256:createHash('sha256').update(JSON.stringify(pages)).digest('hex')}))});
 }
 console.log(JSON.stringify({workload:'同一真实合成SQLite：48条文字、2条人工记忆，固定八条领取；不含Worker IPC、ONNX、外部模型或耗时比较',
  modules:modules.map(({action,...module})=>module),results},null,2));
}finally{
 db?.close();for(const cleanup of cleanups.reverse())await cleanup();
}
