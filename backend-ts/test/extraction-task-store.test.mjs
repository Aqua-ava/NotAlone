import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import pg from 'pg';
import {ExtractionTaskStore} from '../src/extraction-task-store.ts';
import {ExtractionWorker} from '../src/extraction-worker.ts';
import {ExtractionProgressApi} from '../src/extraction-progress-http.ts';
import {modelTaskRequestId} from '../src/host-model-accounting.ts';

// 原迁移建立随机合成库；只在所有自有连接退出后普通 DROP，不终止其他进程。
async function fixture() {
 const name=`notalone_task10_store_${randomUUID().replaceAll('-','')}_test`;
 const python=`${homedir()}/miniconda3/envs/NotAlone/bin/python`;
 const root=new URL('../../',import.meta.url).pathname;
 const env={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:`${root}/backend/src`};
 execFileSync(python,['-c',`import sys,psycopg\nfrom pathlib import Path\nfrom psycopg import sql\nfrom notalone.database_migrations import migrate\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c: c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(sys.argv[1])))\nmigrate('host=/tmp dbname='+sys.argv[1],Path(sys.argv[2]))`,name,`${root}/backend/database/migrations`],{env,stdio:'pipe'});
 const pool=new pg.Pool({host:'/tmp',database:name,max:5});
 const scope={ownerId:randomUUID(),contactId:randomUUID()};const sourceId=randomUUID();
 await pool.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[scope.ownerId]);
 await pool.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[scope.contactId,scope.ownerId]);
 await pool.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,2)",[sourceId,scope.ownerId,scope.contactId,'a'.repeat(64)]);
 return {pool,scope,sourceId,store:new ExtractionTaskStore(pool),async close(){await pool.end();execFileSync(python,['-c',"import sys,psycopg\nfrom psycopg import sql\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c: c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(sys.argv[1])))",name],{env,stdio:'pipe'});}};
}
async function addObservation(f,binding,sequence){
 const observation=randomUUID(),message=randomUUID();
 await f.pool.query("INSERT INTO local_wechat_observation(id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,last_local_id,last_cursor,record_count,event_count) VALUES($1,$2,$3,$4,'live','synthetic','synthetic',$5,$6,1,1)",[observation,f.scope.ownerId,f.scope.contactId,binding,sequence,String(sequence)]);
 await f.pool.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成观察',now())",[message,f.scope.ownerId,f.scope.contactId]);
 await f.pool.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) VALUES($1,$2,$3,'local_wechat_observation',$4,$5,'{}')",[message,f.scope.ownerId,f.scope.contactId,observation,`id:${sequence}`]);
 await f.store.transaction(f.scope,c=>f.store.recordObservation(c,f.scope,observation,[message]));
 return {observation,message};
}

test('原任务身份重放与两Worker争抢：只领取一个租约，固定前序不跳过',async()=>{
 const f=await fixture();try{
  const task=await f.store.enqueueImport(f.scope,f.sourceId,2);
  assert.equal(await f.store.enqueueImport(f.scope,f.sourceId,2),task);
  assert.equal(await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
  await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const claims=await Promise.all([1,2].map(()=>f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000})));
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal(claims.find(Boolean).stepName,'extract_memory');
  assert.equal(claims.find(Boolean).leaseGeneration,1);
 }finally{await f.close();}
});

test('调用端未知身份在PG已知后仍阻重放，失败入口保留unknown分类',async()=>{
 const f=await fixture();try{
  const task=await f.store.enqueueImport(f.scope,f.sourceId,0);
  await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const blocked=new ExtractionTaskStore(f.pool,{unconfirmedRequests:()=>[task]});
  assert.equal(await blocked.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});
  assert.ok(claim);
  assert.equal(await blocked.fail(claim,'temporary_model_failure',true),'failed');
  const p=(await f.store.progress(f.scope,task)).tasks[0];
  assert.equal(p.status,'failed');assert.equal(p.reason_code,'model_call_outcome_unknown');
 }finally{await f.close();}
});

test('global-worker会话锁贯穿run与步骤完成，退出释放后才允许另一宿主',async()=>{
 const f=await fixture();let held;try{
  held=await f.store.acquireWorker();assert.ok(held);
  assert.equal(await f.store.acquireWorker(),null);
  const task=await f.store.enqueueImport(f.scope,f.sourceId,0);
  await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});
  await f.store.complete(claim,0,0);
  await assert.rejects(f.store.check(claim),{code:'lease_stale'});
  const next=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000,supportedSteps:['index']});
  assert.equal(next.stepName,'index');
  await held.release();await held.release();const replacement=await f.store.acquireWorker();assert.ok(replacement);await replacement.release();
 }finally{await held?.release();await f.close();}
});

test('观察持久调度保留阈值、同任务身份、冻结目标和撤销后事件拒绝',async()=>{
 const f=await fixture();try{
  const binding=randomUUID();await f.pool.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic','synthetic')",[binding,f.scope.ownerId,f.scope.contactId]);
  const first=await addObservation(f,binding,1);
  const task=await f.store.enqueueObservation(f.scope,[first.message]);assert.ok(task);
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});assert.deepEqual((await f.store.targets(claim)).targetIds,[first.message]);
  const second=await addObservation(f,binding,2);assert.equal(await f.store.claimScheduled(f.scope),null);
  const third=await addObservation(f,binding,3);assert.equal(await f.store.claimScheduled(f.scope),task);
  assert.equal((await f.store.targets(claim)).targetIds.length,3);
  assert.equal((await f.store.progress(f.scope,task)).tasks[0].total_count,3);
  await f.pool.query("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1",[binding]);
  assert.equal(await f.store.enqueueObservation(f.scope,[second.message,third.message]),null);
  await assert.rejects(f.store.check(claim),{code:'lease_stale'});
 }finally{await f.close();}
});

test('原批次unknown隔离旧目标，删除窗口正文保留input关联，真正新目标可运行',async()=>{
 const f=await fixture();try{
  const binding=randomUUID();await f.pool.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic','synthetic')",[binding,f.scope.ownerId,f.scope.contactId]);
  const first=await addObservation(f,binding,1),task=await f.store.enqueueObservation(f.scope,[first.message]);
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});await f.store.targets(claim);
  const trace=randomUUID(),key='synthetic-batch';await f.pool.query("INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,$5)",[trace,f.scope.ownerId,f.scope.contactId,randomUUID(),key]);
  await f.pool.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES($1,$2,$3,$4,1,'window',$5)",[randomUUID(),trace,f.scope.ownerId,f.scope.contactId,{task_runtime:{task_id:task},target_message_ids:[first.message]}]);
  const blocked=new ExtractionTaskStore(f.pool,{unconfirmedRequests:()=>[modelTaskRequestId('extraction',task,key)]});
  assert.equal(await blocked.fail(claim,'transport_failure',true),'failed');
  assert.equal((await blocked.progress(f.scope,task)).tasks[0].processed_count,1);
  await blocked.resume(f.scope,task,'resume');assert.equal(await blocked.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
  await f.pool.query("INSERT INTO memory_extraction_trace_link(trace_id,owner_id,contact_id,record_kind,record_id,commit_status,operation) VALUES($1,$2,$3,'message',$4,'committed','input')",[trace,f.scope.ownerId,f.scope.contactId,first.message]);
  await f.pool.query('DELETE FROM memory_extraction_trace_event WHERE trace_id=$1',[trace]);
  assert.equal(await blocked.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
  const second=await addObservation(f,binding,2);await addObservation(f,binding,3);assert.equal(await f.store.claimScheduled(f.scope),task);
  const fresh=await blocked.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});assert.ok(fresh);
  assert.ok((await blocked.targets(fresh)).targetIds.includes(second.message));
  assert.ok(!(await blocked.targets(fresh)).targetIds.includes(first.message));
 }finally{await f.close();}
});

test('冻结历史目标与同事务进度：新增消息不混入旧计划，失败回滚不多算，重放不重复',async()=>{
 const f=await fixture();try{
  async function message(text,seconds){const id=randomUUID();await f.pool.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-01-01'::timestamptz+$5*interval '1 second')",[id,f.scope.ownerId,f.scope.contactId,text,seconds]);await f.pool.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,$5,'{}')",[id,f.scope.ownerId,f.scope.contactId,f.sourceId,`line:${seconds}`]);return id;}
  const a=await message('合成一',1),b=await message('合成二',2);
  const task=await f.store.enqueueImport(f.scope,f.sourceId,2);
  await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});
  assert.deepEqual((await f.store.targets(claim)).targetIds,[a,b]);await message('后加入不属于旧计划',3);
  assert.deepEqual((await f.store.targets(claim)).targetIds,[a,b]);
  await assert.rejects(f.store.fenced(claim,async c=>{await f.store.checkpoint(c,claim,[a],'succeeded');throw new Error('合成事务中断');}));
  assert.equal((await f.store.progress(f.scope,task)).tasks[0].processed_count,0);
  await f.store.fenced(claim,c=>f.store.checkpoint(c,claim,[a],'succeeded'));
  await f.store.fenced(claim,c=>f.store.checkpoint(c,claim,[a],'succeeded'));
  assert.equal((await f.store.progress(f.scope,task)).tasks[0].processed_count,1);
  assert.equal((await f.store.progress(f.scope,task)).tasks[0].total_count,2);
  assert.deepEqual((await f.store.targets(claim)).targetIds,[b]);
  await assert.rejects(f.store.progress({...f.scope,ownerId:randomUUID()},task),{code:'contact_not_found'});
 }finally{await f.close();}
});

test('旧租约、取消及来源撤销围栏：同事务checkpoint回滚，显式恢复保留目标',async()=>{
 const f=await fixture();try{
  const id=await f.store.enqueueImport(f.scope,f.sourceId,2);
  await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[id]);
  const claim=await f.store.claim(f.scope,{taskId:id,workerId:randomUUID(),leaseMs:30000});
  await f.store.check(claim);
  await assert.rejects(f.store.check({...claim,leaseGeneration:0}),{code:'lease_stale'});
  await f.pool.query("UPDATE background_task SET status='cancelled' WHERE id=$1",[id]);
  await assert.rejects(f.store.fenced(claim,async()=>{}),{code:'lease_stale'});
  await f.pool.query("UPDATE background_task_step SET status='cancelled',lease_expires_at=NULL WHERE task_id=$1 AND status='running'",[id]);
  await assert.rejects(f.store.resume(f.scope,id,'resume'),{code:'resume_action_mismatch'});
  assert.equal((await f.store.resume(f.scope,id,'restart')).status,'queued');
  const resumed=await f.store.claim(f.scope,{taskId:id,workerId:randomUUID(),leaseMs:30000});
  assert.ok(resumed.leaseGeneration>claim.leaseGeneration);
  await f.pool.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[f.sourceId]);
  await assert.rejects(f.store.check(resumed),{code:'lease_stale'});
  await assert.rejects(f.store.resume(f.scope,id,'resume'),{code:'source_unavailable'});
 }finally{await f.close();}
});

test('事务末尾再次检查真实租约：已写checkpoint随租约失效全部回滚',async()=>{
 const f=await fixture();try{
  const task=await f.store.enqueueImport(f.scope,f.sourceId,0);await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});
  assert.ok((await f.store.renew(claim,60000))>claim.leaseExpiresAt);
  await assert.rejects(f.store.fenced(claim,async c=>{
   await c.query("UPDATE background_task SET message_count=99 WHERE id=$1",[task]);
   await c.query("UPDATE background_task_step SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.stepId]);
  }),{code:'lease_stale'});
  assert.equal((await f.pool.query('SELECT message_count FROM background_task WHERE id=$1',[task])).rows[0].message_count,0);
  await f.store.check(claim);
  await f.pool.query("UPDATE background_task_step SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[claim.stepId]);
  const next=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});assert.equal(next.leaseGeneration,2);
  await assert.rejects(f.store.check(claim),{code:'lease_stale'});
 }finally{await f.close();}
});

test('原110物理未知阻止领取，PG已知结果不能消除调用端journal未知',async()=>{
 const f=await fixture();try{
  const task=await f.store.enqueueImport(f.scope,f.sourceId,0);await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const attempt=randomUUID();await f.pool.query("INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status) VALUES($1,$2,$3,$4,$5,'synthetic','synthetic',now(),'authorized_unconfirmed','unknown','unknown')",[attempt,f.scope.ownerId,f.scope.contactId,task,randomUUID()]);
  assert.equal(await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
  await f.pool.query("UPDATE model_call_receipt SET dispatch='response_observed',outcome='succeeded' WHERE attempt_id=$1",[attempt]);
  const journal=new ExtractionTaskStore(f.pool,{unconfirmedRequests:()=>[task]});
  assert.equal(await journal.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),null);
  assert.ok(await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}));
 }finally{await f.close();}
});

test('显式历史模式保留固定规则，版本不匹配时不改变任务或领取代际',async()=>{
 const f=await fixture();try{
  const task=await f.store.enqueueImport(f.scope,f.sourceId,0);await f.pool.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  await f.pool.query('UPDATE background_task SET extraction_runtime_config=$2 WHERE id=$1',[task,{version:1,mode:'bounded-runtime-v1',rule_set_sha256:'b'.repeat(64)}]);
  assert.deepEqual(await f.store.readyScopes(f.scope.ownerId),[]);
  assert.deepEqual(await f.store.readyScopes(f.scope.ownerId,64,['bounded-runtime-v1']),[{ownerId:f.scope.ownerId,contactId:f.scope.contactId}]);
  await assert.rejects(f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000}),{code:'extraction_runtime_rule_unavailable'});
  assert.equal((await f.pool.query("SELECT lease_generation FROM background_task_step WHERE task_id=$1 AND step_name='extract_memory'",[task])).rows[0].lease_generation,'0');
  const claim=await f.store.claim(f.scope,{taskId:task,workerId:randomUUID(),leaseMs:30000,runtimeRuleSetSha256:'b'.repeat(64)});
  assert.equal(claim.runtimeConfig.mode,'bounded-runtime-v1');
 }finally{await f.close();}
});

test('owner进度复用联系人任务行，并保持owner与contact范围',async()=>{
 const f=await fixture();try{
  const otherContact=randomUUID(),otherSource=randomUUID();
  await f.pool.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'另一合成联系人')",[otherContact,f.scope.ownerId]);
  await f.pool.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic-other.jsonl',$4,1)",[otherSource,f.scope.ownerId,otherContact,'b'.repeat(64)]);
  const first=await f.store.enqueueImport(f.scope,f.sourceId,2);
  const second=await f.store.enqueueImport({ownerId:f.scope.ownerId,contactId:otherContact},otherSource,1);
  const owner=await f.store.ownerProgress(f.scope.ownerId);
  assert.equal(owner.scope,'owner');assert.equal(owner.contact_id,null);
  assert.deepEqual(new Set(owner.tasks.map(task=>task.task_id)),new Set([first,second]));
  assert.equal((await f.store.progress(f.scope,first)).tasks.length,1);
  assert.equal((await f.store.progress(f.scope,second)).tasks.length,0);
  await assert.rejects(f.store.ownerProgress(randomUUID()),{code:'owner_not_found'});
  const wakes=[];const api=new ExtractionProgressApi(f.store,f.scope.ownerId,{wake:(scope,task)=>wakes.push([scope,task])});
  assert.equal((await api.handle('GET','/api/owner/memory-processing')).status,200);
  assert.equal((await api.handle('GET',`/api/contacts/${otherContact}/memory-processing`)).status,200);
  assert.equal(await api.handle('POST','/api/owner/memory-processing'),null);
  assert.equal((await api.handle('GET','/api/contacts/not-a-uuid/memory-processing')).status,400);
  for(const body of [null,{}, {task_id:'bad',action:'resume'},{task_id:first,action:'retry'},{task_id:first,action:'resume',extra:true}]){
   assert.equal((await api.handle('POST','/api/owner/memory-processing/resume',body)).status,400);
  }
  assert.equal((await api.handle('POST',`/api/contacts/${otherContact}/memory-processing/resume`,{task_id:first,action:'resume'})).status,404);
  assert.equal((await api.handle('POST','/api/owner/memory-processing/resume',{task_id:randomUUID(),action:'resume'})).status,404);
  assert.deepEqual((await api.handle('POST','/api/owner/memory-processing/resume',{task_id:first,action:'resume'})),{status:200,body:{task_id:first,status:'queued'}});
  assert.deepEqual(wakes.at(-1),[{ownerId:f.scope.ownerId,contactId:f.scope.contactId},first]);
  assert.equal((await api.handle('POST','/api/owner/memory-processing/resume',{task_id:first,action:'resume'})).status,200);
  await f.pool.query("UPDATE background_task SET status='cancelled' WHERE id=$1",[first]);
  await f.pool.query("UPDATE background_task_step SET status='cancelled' WHERE task_id=$1",[first]);
  assert.equal((await api.handle('POST',`/api/contacts/${f.scope.contactId}/memory-processing/resume`,{task_id:first,action:'resume'})).status,409);
  assert.deepEqual((await api.handle('POST',`/api/contacts/${f.scope.contactId}/memory-processing/resume`,{task_id:first,action:'restart'})),{status:200,body:{task_id:first,status:'queued'}});
  const unavailable=new ExtractionProgressApi(null,f.scope.ownerId);
  assert.equal((await unavailable.handle('GET','/api/owner/memory-processing')).status,503);
  await f.pool.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[f.sourceId]);
  assert.equal((await api.handle('POST',`/api/contacts/${f.scope.contactId}/memory-processing/resume`,{task_id:first,action:'resume'})).status,409);
 }finally{await f.close();}
});

test('完整观察回执进入唯一Worker，全局锁阻止第二只，owner进度读真实处理量',async()=>{
 const f=await fixture();let firstWorker,secondWorker;try{
  const binding=randomUUID();await f.pool.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic','synthetic')",[binding,f.scope.ownerId,f.scope.contactId]);
  const observed=await addObservation(f,binding,1);
  assert.deepEqual(await f.store.readyScopes(f.scope.ownerId),[{ownerId:f.scope.ownerId,contactId:f.scope.contactId}]);
  let releaseRun,runStarted;
  const started=new Promise(resolve=>{runStarted=resolve;});
  const gate=new Promise(resolve=>{releaseRun=resolve;});
  const runner={
   async run(claim,signal){
    runStarted();await Promise.race([gate,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    assert.equal(signal.aborted,false);
    const targets=await f.store.targets(claim);assert.deepEqual(targets.targetIds,[observed.message]);
    await f.store.fenced(claim,c=>f.store.checkpoint(c,claim,[observed.message],'succeeded'));
    return {processedCount:1,totalCount:1};
   },
  };
  firstWorker=new ExtractionWorker({store:f.store,ownerId:f.scope.ownerId,runner,idleMs:20,leaseMs:5000,heartbeatMs:1000});
  secondWorker=new ExtractionWorker({store:f.store,ownerId:f.scope.ownerId,runner,idleMs:20,leaseMs:5000,heartbeatMs:1000});
  assert.equal(await firstWorker.start(),true);
  assert.equal(await secondWorker.start(),false);
  await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker_start_timeout')),1000))]);
  releaseRun();
  const deadline=Date.now()+2000;
  let progress;
  while(Date.now()<deadline){
   progress=await f.store.ownerProgress(f.scope.ownerId);
   if(progress.tasks[0]?.processed_count===1&&progress.tasks[0]?.status==='interrupted')break;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(progress.tasks[0].processed_count,1);
  assert.equal(progress.tasks[0].total_count,1);
  assert.equal(progress.tasks[0].contact_id,f.scope.contactId);
  assert.equal(await firstWorker.stop(),true);
  assert.equal(await secondWorker.start(),true);
 }finally{
  await secondWorker?.stop();await firstWorker?.stop();await f.close();
 }
});
