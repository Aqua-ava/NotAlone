import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {ExtractionWorker} from '../src/memory/extraction/tasks/worker.ts';
import {ExtractionWorkerTaskControl,TaskControlError} from '../src/tasks/task-control.ts';

async function waitFor(check,timeoutMs=3000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const value=await check();
  if(value)return value;
  await delay(20);
 }
 throw new Error('synthetic_control_timeout');
}

test('任务控制只唤醒同一TS Worker并可在失败后恢复原任务',{timeout:20000},async t=>{
 const fixture=await createExtractionFixture(),client=fixture.client;
 const pool=new pg.Pool({host:'/tmp',database:client.database,max:4});
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID();
 let worker;
 t.after(async()=>{
  await worker?.stop();
  await pool.end();
  await fixture.close();
 });
 await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-control.jsonl',$4,1)`,[source,owner,contact,'a'.repeat(64)]);
 await client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text','合成任务控制消息','2026-10-20T02:00:00Z')`,[message,owner,contact]);
 await client.query(`INSERT INTO message_source_ref
  (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'source_document',$4,'synthetic:1','{}')`,[message,owner,contact,source]);
 const store=new ExtractionTaskStore(pool);
 const taskId=await store.enqueueImport({ownerId:owner,contactId:contact},source,1);
 let runs=0;
 const runner={async run(){
  runs++;
  return {processedCount:1,totalCount:1};
 }};
 worker=new ExtractionWorker({store,ownerId:owner,runner,idleMs:20,leaseMs:5000,heartbeatMs:1000});
 const control=new ExtractionWorkerTaskControl({store,worker});
 const scope={ownerId:owner,contactId:contact};
 assert.equal(await worker.start(),true);
 assert.equal(await control.run(scope,taskId),'started');
 await waitFor(async()=>(await client.query(`SELECT 1 FROM background_task_step
  WHERE task_id=$1 AND step_name='extract_memory' AND status='succeeded'`,[taskId])).rowCount);
 assert.equal(runs,1);
 await client.query(`UPDATE background_task SET status='failed',current_step='extract_memory',
  last_error_code='synthetic_retry' WHERE id=$1`,[taskId]);
 await client.query(`UPDATE background_task_step SET status='failed',last_error_code='synthetic_retry'
  WHERE task_id=$1 AND step_name='extract_memory'`,[taskId]);
 assert.deepEqual(await control.retry(scope,taskId),{task_id:taskId,status:'queued'});
 await waitFor(()=>runs===2);
 assert.equal(runs,2);
 assert.equal(await control.wake(scope,taskId),'started');
 await control.close();
 await assert.rejects(control.run(scope,taskId),error=>
  error instanceof TaskControlError&&error.code==='worker_unavailable');
});

test('未启动或已关闭任务控制失败关闭，同一任务重复唤醒只执行一次',{timeout:20000},async t=>{
 const fixture=await createExtractionFixture(),client=fixture.client;
 const pool=new pg.Pool({host:'/tmp',database:client.database,max:4});
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID();
 let worker,control;
 t.after(async()=>{
  await worker?.stop();
  await pool.end();
  await fixture.close();
 });
 await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-idempotent.jsonl',$4,1)`,[source,owner,contact,'b'.repeat(64)]);
 const store=new ExtractionTaskStore(pool),scope={ownerId:owner,contactId:contact};
 const taskId=await store.enqueueImport(scope,source,1);
 await client.query("UPDATE background_task SET status='failed',current_step='extract_memory' WHERE id=$1",[taskId]);
 await client.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[taskId]);
 await client.query("UPDATE background_task_step SET status='failed' WHERE task_id=$1 AND step_name='extract_memory'",[taskId]);
 let runs=0;
 worker=new ExtractionWorker({store,ownerId:owner,runner:{async run(){runs++;return {processedCount:1,totalCount:1};}},
  idleMs:60000,leaseMs:5000,heartbeatMs:1000});
 control=new ExtractionWorkerTaskControl({store,worker});
 await assert.rejects(control.wake(scope,taskId),error=>
  error instanceof TaskControlError&&error.code==='worker_unavailable');
 assert.equal(await worker.start(),true);
 await delay(100);
 assert.equal((await store.resume(scope,taskId,'resume')).status,'queued');
 assert.deepEqual(await Promise.all([control.wake(scope,taskId),control.wake(scope,taskId)]),['started','started']);
 await waitFor(()=>runs===1);
 await delay(100);
 assert.equal(runs,1,'重复提示必须合并，不能领取或执行第二条任务');
 await control.close();
 await assert.rejects(control.wake(scope,taskId),error=>
  error instanceof TaskControlError&&error.code==='worker_unavailable');
});

test('TS任务控制关闭时排空在途原任务恢复',async()=>{
 let releaseResume,resumeCalls=0,wakeCalls=0;
 const resumeGate=new Promise(resolve=>{releaseResume=resolve;});
 const taskId=randomUUID(),scope={ownerId:randomUUID(),contactId:randomUUID()};
 const control=new ExtractionWorkerTaskControl({
  store:{async resume(){resumeCalls++;await resumeGate;return {task_id:taskId,status:'queued'};}},
  worker:{wake(){wakeCalls++;return true;}},
 });
 const retry=control.retry(scope,taskId);
 await new Promise(resolve=>setImmediate(resolve));
 let closed=false;
 const closing=control.close().then(()=>{closed=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(closed,false,'关闭必须等待已登记恢复');
 assert.equal(resumeCalls,1);assert.equal(wakeCalls,0);
 releaseResume();
 assert.deepEqual(await retry,{task_id:taskId,status:'queued'});
 await closing;
 assert.equal(wakeCalls,1);
 await assert.rejects(control.wake(scope,taskId),error=>
  error instanceof TaskControlError&&error.code==='worker_unavailable');
});

test('任务停止只中止匹配的在途执行，不停止唯一Worker',{timeout:20000},async t=>{
 const fixture=await createExtractionFixture(),client=fixture.client;
 const pool=new pg.Pool({host:'/tmp',database:client.database,max:4});
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID();
 let worker,runStarted,markStarted;
 t.after(async()=>{await worker?.stop();await pool.end();await fixture.close();});
 await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-stop.jsonl',$4,1)`,[source,owner,contact,'c'.repeat(64)]);
 const store=new ExtractionTaskStore(pool),scope={ownerId:owner,contactId:contact};
 const taskId=await store.enqueueImport(scope,source,1);
 await client.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[taskId]);
 runStarted=new Promise(resolve=>{markStarted=resolve;});
 let aborted=false;
 worker=new ExtractionWorker({store,ownerId:owner,idleMs:60000,leaseMs:5000,heartbeatMs:1000,
  runner:{async run(_claim,signal){
   markStarted();
   await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
   return {processedCount:1,totalCount:1};
  }}});
 assert.equal(await worker.start(),true);
 assert.equal(await worker.wake(scope,taskId),true);
 await runStarted;
 assert.equal(await worker.cancel(scope,taskId),true);
 await waitFor(()=>aborted);
 assert.equal(worker.status().state,'running','取消单个任务不得关闭共享Worker');
});
