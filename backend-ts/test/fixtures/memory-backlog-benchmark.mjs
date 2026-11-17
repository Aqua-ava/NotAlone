/** 同一真实合成SQLite比较积压发现和指定轮恢复资格，不连接供应商或真实资料。 */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fixture,owner,record,modelPort} from './memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../../src/memory/sqlite/service.ts';
const args=process.argv.slice(2),current=fileURLToPath(new URL('../../src/memory/sqlite/backlog-recovery.ts',import.meta.url));
assert.ok(args.length===0||args.length===2&&args[0]==='--compare-module'&&isAbsolute(args[1]),
 '用法：node test/fixtures/memory-backlog-benchmark.mjs [--compare-module /绝对路径/固定旧模块.mts]');
const modules=await Promise.all([...(args.length?[['before',args[1]]]:[]),['current',current]].map(async([label,path])=>({
 label,sourceSHA256:createHash('sha256').update(await readFile(path)).digest('hex'),...await import(pathToFileURL(path).href),
})));
console.log(JSON.stringify({modules:modules.map(({label,sourceSHA256})=>({label,sourceSHA256}))}));

const cleanup=[],t={after:fn=>cleanup.unshift(fn)};
let db;
try{
 const f=await fixture(t);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.saved[0].contact_id);
 let memory;const port=modelPort(()=>memory.accounting);port.prepare=async()=>{throw Object.assign(Error('合成已知失败'),{code:'extraction_model_bad_request'});};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const run=await memory.start('benchmark-known-failure');await memory.waitForIdle(run.runId);await memory.close();await f.storage.close();
 db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));db.exec('PRAGMA foreign_keys=ON');
 const statement=sql=>{const s=db.prepare(sql);s.setReadBigInts(true);return s;};
 let counters;const tx={all(sql,args=[]){const rows=statement(sql).all(...args);if(counters){counters.queries++;counters.rows+=rows.length;}return rows;},get(sql,args=[]){const row=statement(sql).get(...args);if(counters){counters.queries++;counters.rows+=row?1:0;}return row;}};
 const templates=Object.fromEntries(['processing_run','run_contact','processing_task','processing_step'].map(table=>[table,tx.get(`SELECT * FROM ${table} LIMIT 1`)]));
 const insert=(table,changes)=>{const row={...templates[table],...changes},columns=Object.keys(row);statement(`INSERT INTO ${table}(${columns.map(c=>'"'+c+'"').join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));};
 let count=1;
 for(const size of [10,100,1000]){
  db.exec('BEGIN');
  for(;count<size;count++){
   const id=`benchmark-run-${count}`,taskId=`benchmark-task-${count}`;
   insert('processing_run',{id,start_request_key:`benchmark-${count}`,started_at:templates.processing_run.started_at+BigInt(count)});
   insert('run_contact',{run_id:id});insert('processing_task',{id:taskId,run_id:id});insert('processing_step',{id:`benchmark-step-${count}`,task_id:taskId});
  }
  db.exec('COMMIT');
  const expectedList=modules[0].recoverableBacklogRuns(tx,owner);assert.equal(expectedList.length,size);
  for(const module of modules)assert.deepEqual(module.recoverableBacklogRuns(tx,owner),expectedList);
  for(const id of [`benchmark-run-${size-1}`,'missing-run']){
   const metrics={};let expected;
   for(const {label:name,backlogRunRecoverable:query} of modules){
    const times=[];counters={queries:0,rows:0};let result;
    for(let sample=0;sample<5;sample++){const started=performance.now();result=query(tx,owner,id);times.push(performance.now()-started);}
    metrics[name]={...counters,medianMs:Number(times.sort((a,b)=>a-b)[2].toFixed(3))};counters=undefined;
    if(expected===undefined)expected=result;else assert.equal(result,expected);
   }
   console.log(JSON.stringify({runs:size,case:id==='missing-run'?'missing':'selected',result:expected,samples:5,...metrics}));
  }
  const selected=`benchmark-run-${size-1}`,stepId=`benchmark-step-${size-1}`,rejections=[
   ['user_pause',"UPDATE processing_run SET pause_requested_at=1 WHERE id=?",[selected]],
   ['task_unknown',"UPDATE processing_task SET state='unknown' WHERE run_id=?",[selected]],
   ['step_unknown',"UPDATE processing_step SET state='unknown' WHERE id=?",[stepId]],
   ['retry_used',"UPDATE processing_task SET resume_no=1 WHERE run_id=?",[selected]],
   ['operation_unknown',"INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,'extraction',?,0,?,'unknown')",[owner,'benchmark-unknown',stepId,'a'.repeat(64)]],
   ['other_active_run',"UPDATE processing_run SET state='pending' WHERE id=?",[run.runId]],
  ];
  for(const [name,sql,values] of rejections){
   db.exec('SAVEPOINT rejection');statement(sql).run(...values);
   const expected=modules[0].recoverableBacklogRuns(tx,owner);
   for(const module of modules){assert.equal(module.backlogRunRecoverable(tx,owner,selected),false,name);assert.deepEqual(module.recoverableBacklogRuns(tx,owner),expected,name);}
   db.exec('ROLLBACK TO rejection;RELEASE rejection');
  }
  for(const module of modules)assert.equal(module.backlogRunRecoverable(tx,owner,selected),true);
  console.log(JSON.stringify({runs:size,rejections:rejections.map(([name])=>name),qualificationAndDiscovery:'same'}));
 }
 assert.equal(statement('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(statement('PRAGMA foreign_key_check').all(),[]);
}finally{db?.close();for(const fn of cleanup)await fn();}
