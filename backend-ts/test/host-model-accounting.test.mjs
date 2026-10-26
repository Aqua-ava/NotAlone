import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {createHostModelAccounting,modelTaskRequestId} from '../src/host-model-accounting.ts';
import {adoptionPurposeRequestId} from '../src/extraction-adoption-service.ts';
async function fixture(t){
 const db=`notalone_accounting_${randomUUID().replaceAll('-','')}_test`,admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();let c;
 t.after(async()=>{await c?.end();await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);await admin.end();});
 await admin.query(`CREATE DATABASE "${db}" TEMPLATE template0`);c=new pg.Client({host:'/tmp',database:db});await c.connect();
 for(const f of (await readdir(new URL('../database/migrations/',import.meta.url))).sort())await c.query(await readFile(new URL(`../database/migrations/${f}`,import.meta.url),'utf8'));
 const owner=(await c.query("INSERT INTO owner(display_name) VALUES('合成') RETURNING id")).rows[0].id;
 const contact=(await c.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'合成') RETURNING id",[owner])).rows[0].id;
 await c.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status) VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
 const tx=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}};
 const accounting=createHostModelAccounting({transaction:tx,provider:'synthetic',model:'deepseek-flash',unconfirmedPermitIds:()=>[]});
 const task=async(kind,step,scope=contact)=>{
  const id=(await c.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'running',$4,0) RETURNING id",[owner,scope,kind,step])).rows[0].id;
  const worker=randomUUID();const sid=(await c.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at) VALUES($1,$2,1,'running',$3,1,1,now()+interval '1 minute') RETURNING id",[id,step,worker])).rows[0].id;
  return {task_id:id,step_id:sid,step_name:step,worker_id:worker,lease_generation:1};
 };
 const receipt=(id,scope=contact)=>({attempt_id:randomUUID(),permit_id:randomUUID(),request_id:id,owner_id:owner,contact_id:scope,scope_kind:scope===null?'owner_memory':'contact',provider:'synthetic',model:'deepseek-flash',called_at:'2026-10-24T00:00:00Z',latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}});
 return {c,db,owner,contact,accounting,task,receipt,tx};
}
const done=r=>({...r,outcome:'succeeded',dispatch:'response_observed'});
async function l2(c,owner,contact,task,status='running'){
 const id=randomUUID();await c.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES($1,$2,$3,1,$4,$5,'[]','[]','{}',now(),$6)",[id,owner,contact,randomUUID(),status,task]);return id;
}

test('学习精确claim/确定批次/单次额度；跨新batch旧预约仍结算，unknown不重放',async t=>{
 const {c,owner,contact,accounting:a,task,receipt}=await fixture(t),claim=await task('skill_learning','propose_skill');
 await c.query("INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,last_attempt_key) VALUES($1,$2,true,'batch-a')",[owner,contact]);
 const r=receipt(modelTaskRequestId('skill_learning',claim.task_id,'batch-a'));
 await assert.rejects(a.reserve(r),/claim_invalid/);await assert.rejects(a.reserve(r,{...claim,lease_generation:2}),/claim_stale/);
 await assert.rejects(a.reserve({...r,request_id:randomUUID()},claim),/request_invalid/);
 await a.reserve(r,claim);await a.reserve(r,claim);
 await assert.rejects(a.reserve({...r,attempt_id:randomUUID(),maxPhysicalCalls:999999},claim),/budget_exceeded|claim_spent/);
 await c.query("UPDATE skill_learning_scope SET last_attempt_key='batch-b' WHERE owner_id=$1",[owner]);
 await a.recordReserved(done(r));await assert.rejects(a.reserve(r,claim),/request_invalid/);
 const b=receipt(modelTaskRequestId('skill_learning',claim.task_id,'batch-b'));
 await assert.rejects(a.reserve(b,claim),/claim_spent/,'同一真实claim不能只换批次扩大额度');
 await c.query('UPDATE background_task_step SET lease_generation=2,attempt_count=1 WHERE id=$1',[claim.step_id]);
 const next={...claim,lease_generation:2};await a.reserve(b,next);
 await a.recordReserved({...b,outcome:'unknown'});
 await assert.rejects(a.reserve({...b,attempt_id:randomUUID()},next),/unsettled|claim_spent/);
 await assert.rejects(a.reserve(b,next),/already_settled/);
 await c.query('UPDATE background_task_step SET lease_generation=3,attempt_count=1 WHERE id=$1',[claim.step_id]);
 await assert.rejects(a.reserve({...b,attempt_id:randomUUID(),permit_id:randomUUID()},{...claim,lease_generation:3}),/unsettled/);
 await c.query('DELETE FROM contact WHERE id=$1',[contact]);await assert.rejects(a.recordReserved(done(b)),/scope_deleted/);
});
test('提取只按window真实claim与batch反算，跨permit pending拒绝',async t=>{
 const {c,owner,contact,accounting:a,task,receipt}=await fixture(t),claim=await task('observation','extract_memory'),key='a'.repeat(64),tr=randomUUID();
 await c.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,$5)',[tr,owner,contact,randomUUID(),key]);
 const r=receipt(modelTaskRequestId('extraction',claim.task_id,key));
 await assert.rejects(a.reserve(r,claim),/request_invalid/);
 await c.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES($1,$2,$3,$4,1,'window',$5)",[randomUUID(),tr,owner,contact,{task_runtime:claim,body:'合成正文不应读取'}]);
 await a.reserve(r,claim);await assert.rejects(a.reserve({...r,attempt_id:randomUUID(),permit_id:randomUUID()},claim),/unsettled|claim_spent/);
 await a.recordReserved(done(r));await a.reserve({...r,attempt_id:randomUUID()},claim);
 await c.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES($1,$2,$3,$4,2,'typescript_a_result',$5)",
  [randomUUID(),tr,owner,contact,{outcome:{accepted:[{}]}}]);
 const bRequests={
  adjudication:adoptionPurposeRequestId('adjudication',claim.task_id,key),
  relation:adoptionPurposeRequestId('relation_verification',claim.task_id,key),
  merge:adoptionPurposeRequestId('merge_verification',claim.task_id,key,'0'),
 };
 assert.equal(new Set(Object.values(bRequests)).size,3);
 for(const requestId of [bRequests.adjudication,bRequests.merge]){
  const request=receipt(requestId);
  await a.reserve(request,claim);
  await a.recordReserved(done(request));
 }
 const relation=receipt(bRequests.relation);
 await a.reserve(relation,claim);
 await a.recordReserved({...relation,outcome:'unknown'});
 await assert.rejects(a.reserve({...relation,attempt_id:randomUUID(),permit_id:randomUUID()},claim),/unsettled|unknown/);
 await assert.rejects(a.reserve(receipt(adoptionPurposeRequestId('merge_verification',claim.task_id,key,'1')),claim),/request_invalid/);
 await assert.rejects(a.reserve(receipt(modelTaskRequestId('adjudication',claim.task_id,key)),claim),/request_invalid/);
 await assert.rejects(a.reserve(receipt(adoptionPurposeRequestId('adjudication',randomUUID(),key)),claim),/request_invalid/);
 await c.query("UPDATE background_task_step SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[claim.step_id]);
 await assert.rejects(a.reserve(receipt(adoptionPurposeRequestId('adjudication',claim.task_id,key,'batch')),claim),/claim_stale/);
});
test('升级跨batch共享原job剩余额度，同attempt幂等不二扣，失败回滚',async t=>{
 const {c,owner,contact,accounting:a,task,receipt}=await fixture(t);
 const job=(await c.query("INSERT INTO memory_upgrade_job(owner_id,contact_id,scope_kind,operation_key,message_limit,batch_size,model_call_limit,model_calls_used) VALUES($1,$2,'contact',$3,1,1,3,1) RETURNING id",[owner,contact,randomUUID()])).rows[0].id;
 const add=async n=>{const claim=await task('memory_upgrade','preview_upgrade');await c.query("INSERT INTO memory_upgrade_batch(job_id,owner_id,contact_id,task_id,batch_number,message_ids,source_generation,dependency_ids) VALUES($1,$2,$3,$4,$5,'{}','{}','{}')",[job,owner,contact,claim.task_id,n]);return claim;};
 const ca=await add(1),cb=await add(2),r=receipt(ca.task_id);await a.reserve(r,ca);await a.reserve(r,ca);
 assert.equal((await c.query('SELECT model_calls_used FROM memory_upgrade_job WHERE id=$1',[job])).rows[0].model_calls_used,2);
 await assert.rejects(a.reserve(receipt(cb.task_id),cb),/unsettled/);
 await a.recordReserved(done(r));
 await assert.rejects(a.reserve({...receipt(cb.task_id),permit_id:r.permit_id},cb),/attempt_conflict/);
 assert.equal((await c.query('SELECT model_calls_used FROM memory_upgrade_job WHERE id=$1',[job])).rows[0].model_calls_used,2,'ledger拒绝时原job预扣同事务回滚');
 const rb=receipt(cb.task_id);await a.reserve(rb,cb);await a.recordReserved(done(rb));
 await assert.rejects(a.reserve({...rb,attempt_id:randomUUID()},cb),/budget_exceeded/);
 assert.equal((await c.query('SELECT model_calls_used FROM memory_upgrade_job WHERE id=$1',[job])).rows[0].model_calls_used,3);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,2);
});
test('本人整理合法NULL scope，同事务扣计/预约失败回滚并拒绝错误用途',async t=>{
 const {c,owner,accounting:a,task,receipt}=await fixture(t),claim=await task('layered_memory','organize_memory',null);
 await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,NULL,true,1)",[owner]);
 await c.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit) VALUES($1,$2,NULL,1,'synthetic','synthetic','{}','{}','active',1,2)",[claim.task_id,owner]);
 await l2(c,owner,null,claim.task_id);
 const r=receipt(claim.task_id,null);await a.reserve(r,claim);await a.recordReserved(done(r));
 await assert.rejects(a.reserve({...r,attempt_id:randomUUID(),provider:'ecnu'},claim),/route_invalid/);
 await c.query("UPDATE layered_memory_state SET settings_generation=2 WHERE owner_id=$1",[owner]);
 await assert.rejects(a.reserve({...r,attempt_id:randomUUID()},claim),/job_stale/);
 assert.equal((await c.query('SELECT model_calls_used FROM layered_memory_job')).rows[0].model_calls_used,1);
});
test('本人整理接收已登记TS provider，未知provider仍拒绝',async t=>{
 const {c,owner,contact,task,receipt,tx}=await fixture(t),claim=await task('layered_memory','organize_memory',null);
 await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,NULL,true,1)",[owner]);
 await c.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit) VALUES($1,$2,NULL,1,'synthetic','synthetic','{}','{}','active',1,2)",[claim.task_id,owner]);
 await l2(c,owner,null,claim.task_id);
 const accounting=createHostModelAccounting({transaction:tx,provider:'deepseek',typescriptProvider:'notalone-deepseek',
   model:'deepseek-flash',unconfirmedPermitIds:()=>[]});
 const request={...receipt(claim.task_id,null),provider:'notalone-deepseek'};
 await assert.rejects(accounting.reserve({...request,attempt_id:randomUUID(),provider:'synthetic-other'},claim),/route_invalid/);
 await accounting.reserve(request,claim);
 await accounting.recordReserved(done(request));
 assert.equal((await c.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[claim.task_id])).rows[0].model_calls_used,1);
});
test('两条真实PG连接竞争原job最后额度，仅一预约成功',async t=>{
 const {c,db,owner,task,receipt}=await fixture(t),claim=await task('layered_memory','organize_memory',null);
 await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,NULL,true,1)",[owner]);
 await c.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit) VALUES($1,$2,NULL,1,'synthetic','synthetic','{}','{}','active',1,1)",[claim.task_id,owner]);
 const transaction=async work=>{const connection=new pg.Client({host:'/tmp',database:db});await connection.connect();try{await connection.query('BEGIN');const result=await work(connection);await connection.query('COMMIT');return result;}catch(e){await connection.query('ROLLBACK');throw e;}finally{await connection.end();}};
 await l2(c,owner,null,claim.task_id);
 const a=createHostModelAccounting({transaction,provider:'synthetic',model:'deepseek-flash',unconfirmedPermitIds:()=>[]}),r=receipt(claim.task_id,null);
 const results=await Promise.allSettled([a.reserve(r,claim),a.reserve({...r,attempt_id:randomUUID()},claim)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.match(results.find(x=>x.status==='rejected').reason.code,/budget_exceeded/);
 assert.equal((await c.query('SELECT model_calls_used FROM layered_memory_job')).rows[0].model_calls_used,1);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,1);
});
test('PG实际work为文档多轮只预留核验额度，L2/L3共享预算且pending幂等',async t=>{
 const {c,owner,accounting:a,task,receipt}=await fixture(t),claim=await task('layered_memory','organize_memory',null);
 await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,NULL,true,1)",[owner]);
 await c.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status) VALUES($1,$2,NULL,1,'synthetic','scenario:document-tools-v1:profile-tools-v1','{}','{}','active',1,8,true,'pending')",[claim.task_id,owner]);
 const batch=await l2(c,owner,null,claim.task_id),r=receipt(claim.task_id,null);
 await a.reserve(r,claim);await a.reserve(r,claim);await a.recordReserved(done(r));
 const secondProposal={...r,attempt_id:randomUUID()};
 await a.reserve(secondProposal,claim);await a.recordReserved(done(secondProposal));
 assert.equal((await c.query('SELECT model_calls_used FROM layered_memory_job')).rows[0].model_calls_used,2);
 await c.query("UPDATE layered_memory_batch SET output_payload='{}' WHERE id=$1",[batch]);
 const verification={...r,attempt_id:randomUUID()};await a.reserve(verification,claim);await a.recordReserved(done(verification));
 await c.query("UPDATE layered_memory_batch SET status='succeeded' WHERE id=$1",[batch]);
 const profile=randomUUID();await c.query("INSERT INTO layered_profile_batch(id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,task_id,status,lease_expires_at,scenario_version_ids,input_manifest,input_payload,dependency_ids,created_at) VALUES($1,$2,NULL,1,0,$3,$4,$5,$6,'running',now()+interval '1 minute','{}','[]','{}','{}',now())",[profile,owner,randomUUID(),randomUUID(),batch,claim.task_id]);
 // 累计历史消耗保留；剩两次时L3 proposal仅能占一次，最后一次专留verification。
 await c.query('UPDATE layered_memory_job SET model_calls_used=6 WHERE task_id=$1',[claim.task_id]);
 const proposal={...r,attempt_id:randomUUID()};
 await c.query("UPDATE layered_profile_batch SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[profile]);
 await assert.rejects(a.reserve(proposal,claim),/work_ambiguous/);
 await c.query("UPDATE layered_profile_batch SET lease_expires_at=now()+interval '1 minute' WHERE id=$1",[profile]);
 await a.reserve(proposal,claim);await a.reserve(proposal,claim);await a.recordReserved(done(proposal));
 await assert.rejects(a.reserve({...r,attempt_id:randomUUID()},claim),/budget_exceeded|claim_spent/);
 await c.query("UPDATE layered_profile_batch SET output_payload='{}' WHERE id=$1",[profile]);
 const final={...r,attempt_id:randomUUID()};await a.reserve(final,claim);await a.recordReserved(done(final));
 assert.equal((await c.query('SELECT model_calls_used FROM layered_memory_job')).rows[0].model_calls_used,8);
 await assert.rejects(a.reserve({...r,attempt_id:randomUUID()},claim),/budget_exceeded|claim_spent/);
});
test('多个running work或无work均拒绝，L2无profile仅保留1',async t=>{
 const {c,owner,accounting:a,task,receipt}=await fixture(t),claim=await task('layered_memory','organize_memory',null);
 await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,NULL,true,1)",[owner]);
 await c.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit) VALUES($1,$2,NULL,1,'synthetic','scenario:document-tools-v1','{}','{}','active',1,2)",[claim.task_id,owner]);
 const r=receipt(claim.task_id,null);await assert.rejects(a.reserve(r,claim),/work_ambiguous/);
 const first=await l2(c,owner,null,claim.task_id),second=await l2(c,owner,null,claim.task_id);
 await assert.rejects(a.reserve(r,claim),/work_ambiguous/);await c.query('DELETE FROM layered_memory_batch WHERE id=$1',[second]);
 await a.reserve(r,claim);await a.recordReserved(done(r));await assert.rejects(a.reserve({...r,attempt_id:randomUUID()},claim),/budget_exceeded|claim_spent/);
 await c.query("UPDATE layered_memory_batch SET output_payload='{}' WHERE id=$1",[first]);await a.reserve({...r,attempt_id:randomUUID()},claim);
});
test('学习已知失败仅真实新claim可重试至3，显式resume保持request及累计记录',async t=>{
 const {c,owner,contact,accounting:a,task,receipt}=await fixture(t);let claim=await task('skill_learning','propose_skill');
 await c.query("INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,last_attempt_key) VALUES($1,$2,true,'retry-batch')",[owner,contact]);
 const request=modelTaskRequestId('skill_learning',claim.task_id,'retry-batch');
 const acquire=async attempt=>{
  const worker=randomUUID();const row=(await c.query("UPDATE background_task_step SET worker_id=$2,lease_generation=lease_generation+1,attempt_count=$3,status='running',lease_expires_at=now()+interval '1 minute' WHERE id=$1 RETURNING lease_generation",[claim.step_id,worker,attempt])).rows[0];
  claim={...claim,worker_id:worker,lease_generation:Number(row.lease_generation)};
 };
 for(let i=1;i<=3;i++){
  if(i>1)await acquire(i);
  const r=receipt(request);await a.reserve(r,claim);await a.reserve(r,claim);
  await a.recordReserved({...r,outcome:'failed',dispatch:'response_observed'});
  await assert.rejects(a.reserve(receipt(request),claim),/budget_exceeded|claim_spent/);
 }
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,3);
 await acquire(4);await assert.rejects(a.reserve(receipt(request),claim),/claim_invalid|retry_limit/);
 // 原显式resume只重置当前步骤attempt_count，lease_generation和稳定batch均保留。
 await c.query("UPDATE background_task_step SET status='pending',attempt_count=0,worker_id=NULL,lease_expires_at=NULL,started_at=NULL WHERE id=$1",[claim.step_id]);
 await acquire(1);const resumed=receipt(request);await a.reserve(resumed,claim);await a.recordReserved(done(resumed));
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt WHERE request_id=$1',[request])).rows[0].n,4);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_learning_claim WHERE request_id=$1',[request])).rows[0].n,4);
 await c.query('DELETE FROM contact WHERE id=$1',[contact]);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_learning_claim')).rows[0].n,0);
});
test('学习pending跨新claim拒绝，claim映射FK绑定真实receipt及task范围',async t=>{
 const {c,owner,contact,accounting:a,task,receipt}=await fixture(t),claim=await task('skill_learning','propose_skill');
 await c.query("INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,last_attempt_key) VALUES($1,$2,true,'pending-batch')",[owner,contact]);
 const r=receipt(modelTaskRequestId('skill_learning',claim.task_id,'pending-batch'));
 await c.query('ALTER TABLE model_call_learning_claim ADD CONSTRAINT synthetic_slot_failure CHECK(lease_generation>100)');
 await assert.rejects(a.reserve(r,claim),{code:'23514'});
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0,'slot写入失败必须回滚同事务receipt');
 await c.query('ALTER TABLE model_call_learning_claim DROP CONSTRAINT synthetic_slot_failure');
 await a.reserve(r,claim);
 await c.query('UPDATE background_task_step SET lease_generation=2,attempt_count=2 WHERE id=$1',[claim.step_id]);
 await assert.rejects(a.reserve({...r,attempt_id:randomUUID()},{...claim,lease_generation:2}),/unsettled/);
 await assert.rejects(c.query('UPDATE model_call_learning_claim SET request_id=$2 WHERE attempt_id=$1',[r.attempt_id,randomUUID()]),{code:'23503'});
 await assert.rejects(c.query('UPDATE model_call_learning_claim SET task_id=$2 WHERE attempt_id=$1',[r.attempt_id,randomUUID()]),{code:'23503'});
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,1);
 await c.query('DELETE FROM background_task WHERE id=$1',[claim.task_id]);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_learning_claim')).rows[0].n,0);
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,1,'仅删除任务不抹掉累计物理收据');
});
