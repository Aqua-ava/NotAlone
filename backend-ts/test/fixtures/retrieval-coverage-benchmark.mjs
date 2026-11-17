import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {retrievalIndexMigration} from '../../src/retrieval/sqlite/schema.ts';
import {retrievalIndexActions} from '../../src/retrieval/sqlite/actions.ts';
import {searchTokenizerFingerprint} from '../../src/retrieval/search-tokenizer.ts';
import {RETRIEVAL_MODEL_FINGERPRINT} from '../../src/retrieval/sqlite/contracts.ts';
const modes=['retrieval.pending','retrieval.coverage'],results=[],repeats=15;
const actions=modes.map(name=>retrievalIndexActions.find(action=>action.name===name));
for(const count of [1000,10000,100000]){
 const db=new DatabaseSync(':memory:');
 // 仅比较真实检索派生表和查询；不包含来源核验、Worker IPC、ONNX或模型调用。
 db.exec("CREATE TABLE owner(owner_id TEXT PRIMARY KEY,state TEXT);CREATE TABLE contact(owner_id TEXT,id TEXT,state TEXT,PRIMARY KEY(owner_id,id));CREATE TABLE message(owner_id TEXT,contact_id TEXT,id TEXT,PRIMARY KEY(owner_id,contact_id,id));CREATE TABLE memory_version(owner_id TEXT,memory_id TEXT,version_no INTEGER,PRIMARY KEY(owner_id,memory_id,version_no));CREATE TABLE deletion_operation(owner_identity TEXT,state TEXT);INSERT INTO owner VALUES('synthetic-owner','active');INSERT INTO contact VALUES('synthetic-owner','synthetic-contact','active');");
 const ddl=retrievalIndexMigration(56).sql;db.exec(ddl.slice(ddl.indexOf('CREATE TABLE retrieval_document'),ddl.indexOf('CREATE VIRTUAL TABLE retrieval_fts')));
 const insert=db.prepare("INSERT INTO retrieval_document(owner_id,kind,entity_id,contact_id,message_id,text_seal,tokenizer_fingerprint) VALUES('synthetic-owner','history',?,'synthetic-contact',?,?,?)");
 const insertMessage=db.prepare("INSERT INTO message VALUES('synthetic-owner','synthetic-contact',?)");db.exec('BEGIN');for(let n=0;n<count;n++){insertMessage.run('synthetic-'+n);insert.run('synthetic-'+n,'synthetic-'+n,'a'.repeat(64),searchTokenizerFingerprint());}db.exec('COMMIT');
 const statements=new Map();const statement=sql=>{if(!statements.has(sql))statements.set(sql,db.prepare(sql));return statements.get(sql);};
 let queries=0;const tx={get(sql,values=[]){queries++;return statement(sql).get(...values);}};
 const input={ownerId:'synthetic-owner',contactId:'synthetic-contact',kind:'history',modelFingerprint:RETRIEVAL_MODEL_FINGERPRINT};
 for(const state of ['text-queued','vector-backfill','ready']){
  if(state==='text-queued')db.exec("INSERT INTO retrieval_text_pending SELECT owner_id,kind,entity_id,contact_id FROM retrieval_document");
  if(state==='vector-backfill')db.exec('DELETE FROM retrieval_text_pending');
  if(state==='ready')db.prepare('UPDATE retrieval_document SET vector_seal=text_seal,model_fingerprint=?').run(RETRIEVAL_MODEL_FINGERPRINT);
  for(let warm=0;warm<5;warm++)for(const action of actions)action.execute(tx,input);
  const samples=modes.map(()=>({times:[],queries:[],result:undefined}));
  for(let run=0;run<repeats;run++)for(const index of run%2?[1,0]:[0,1]){
   queries=0;const start=performance.now();samples[index].result=actions[index].execute(tx,input);
   samples[index].times.push(performance.now()-start);samples[index].queries.push(queries);
  }
  const [before,after]=samples.map((sample,index)=>{
   sample.times.sort((a,b)=>a-b);
   return {action:modes[index],medianMs:Number(sample.times[Math.floor(repeats/2)].toFixed(4)),p95Ms:Number(sample.times[Math.floor(repeats*.95)].toFixed(4)),queriesPerCall:sample.queries.reduce((a,b)=>a+b,0)/repeats,result:sample.result};
  });
  if(after.result.indexIncomplete!==(before.result.textPending>0||before.result.vectorPending>0))throw new Error('覆盖状态与原计数不一致');
  results.push({count,state,before,after});
 }
 db.close();
}
console.log(JSON.stringify({node:process.version,sqlite:process.versions.sqlite,repeats,workload:'内存SQLite检索派生表，外键开启，预备语句，交错测量；不含业务来源核验、Worker IPC及ONNX',results},null,2));
