import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExtractionModelCaller} from '../src/memory/extraction/model.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {createModelPermitPort} from '../src/platform/models/model-permit-port.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

const budget={measurement_id:'synthetic-v1',measurement_kind:'approximate',input_tokens:1,maxTokens:1,
 context_window_tokens:10,safety_margin_tokens:1,request_sha256:'a'.repeat(64),serialized_bytes:1};
function fixture(failure,stepName='extraction_verification'){
 const arbiter=new ModelPermitArbiter(1),calls={reserve:0,record:0,onReceipt:0,http:0,close:0};
 const permit=createModelPermitPort(arbiter,{
  reserve:async()=>{calls.reserve++;throw failure;},
  recordReserved:async()=>{calls.record++;},unconfirmedRequests:async()=>[],
 });
 let registration;
 const caller=createExtractionModelCaller({permit,
  ctx:{llm:{prepareCall:async config=>({config,async *stream(){
   await registration.beforeDispatch({budget});calls.http++;
  }})}},provider:{beginCall(value){registration=value;return {
   observation:()=>({before_dispatch_started:true,fetch_started:false,dispatch:'not_authorized'}),
   close(){calls.close++;},
  };}},
 });
 const input={request_id:randomUUID(),attempt_id:randomUUID(),owner_id:randomUUID(),contact_id:randomUUID(),
  claim:{task_id:randomUUID(),step_id:randomUUID(),step_name:stepName,worker_id:randomUUID(),lease_generation:1},
  binding:{provider:'synthetic',model:'synthetic',maxTokens:1,reasoningEffort:'off'},
  profile:{context_window_tokens:10,safety_margin_tokens:1},messages:[],
  signal:new AbortController().signal,requireCurrent:async()=>{},onReceipt:async()=>{calls.onReceipt++;}};
 return {arbiter,calls,invoke:()=>caller.call(input)};
}

for(const code of ['memory_extraction_model_scope_invalid','memory_extraction_budget_invalid','memory_adjudication_reservation_missing',
 'memory_adjudication_scope_invalid','memory_adjudication_budget_invalid','memory_head_conflict',
 'history_source_not_available','memory_source_stale','memory_content_source_stale',
 'memory_scope_stale','memory_conditions_pending','stale_lease','storage_busy']){
 test(`提取预约明确拒绝 ${code} 不发送且释放后台许可`,async()=>{
  const f=fixture(new StorageFailure(code),(code.startsWith('memory_adjudication_')||code==='memory_head_conflict'||code==='memory_source_stale')?'adjudication':'extraction_verification');
  await assert.rejects(f.invoke(),error=>error.code==='extraction_model_reservation_rejected'&&error.receipt===null);
  assert.deepEqual(f.calls,{reserve:1,record:0,onReceipt:0,http:0,close:1});
  assert.equal(f.arbiter.snapshot().backgroundActive,0);assert.equal(f.arbiter.snapshot().orphaned,0);
  const next=await f.arbiter.acquire('background');next.settle();
 });
}

for(const failure of [new StorageFailure('worker_failed'),new StorageFailure('storage_timeout'),new StorageFailure('storage_failed'),
 Object.assign(new Error('合成未知预约结果'),{code:'memory_extraction_model_scope_invalid'})]){
 test(`提取预约结果未知 ${failure.name}:${failure.code} 保留后台冻结但不占前台车道`,async()=>{
  const f=fixture(failure);
  await assert.rejects(f.invoke(),{code:'extraction_model_ack_unknown'});
  assert.deepEqual(f.calls,{reserve:1,record:0,onReceipt:0,http:0,close:1});
  assert.equal(f.arbiter.snapshot().backgroundActive,1);assert.equal(f.arbiter.snapshot().orphaned,1);
  const foreground=await f.arbiter.acquire('foreground');foreground.settle();
  assert.equal(f.arbiter.snapshot().backgroundActive,1);assert.equal(f.arbiter.snapshot().orphaned,1);
 });
}
