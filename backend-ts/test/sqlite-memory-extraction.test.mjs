import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,owner,record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteMemoryExtraction } from '../src/memory/sqlite/service.ts';
const none={invoke:async()=>({blocks:[{type:'tool_use',id:'synthetic',name:'extract_relationship_memories',input:{scenes:[]}}]})};
test('消息状态失证后，旧正文不能进入新的记忆提取范围',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;
 await f.service.synchronize(contact);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('9007199254740993',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contact);await f.contacts.setReading(false);
 let calls=0;const memory=new SqliteMemoryExtraction(f.storage,owner,{invoke:async()=>{calls++;throw new Error('不应调用');}});t.after(()=>memory.close());
 const run=await memory.start('quarantined-source');await memory.waitForIdle();assert.equal(run.total,0);assert.equal(calls,0);
});
test('关闭读取后原子冻结已勾选联系人全部合法文字，同请求只建立原轮次且后到消息不追加',async t=>{
 const f=await fixture(t);for(const c of f.saved)await f.service.synchronize(c.contact_id);
 await f.contacts.setReading(false);
 const memory=new SqliteMemoryExtraction(f.storage,owner,none);t.after(()=>memory.close());
 const first=await memory.start('fixed-request');assert.equal(first.total,2);assert.equal(first.inputs.length,2);assert.equal(first.tasks.filter(t=>t.scopeKind==='contact').length,2);
 assert.equal((await memory.start('fixed-request')).runId,first.runId);
 await f.contacts.setReading(true);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('3',{sentAt:'1600000000000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.saved[0].contact_id);assert.equal((await f.service.read(f.saved[0].contact_id)).messages.filter(m=>m.kind==='text').length,2);await f.contacts.setReading(false);
 assert.equal((await memory.read(first.runId)).total,2);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('正常提示词和核验流程无新记忆仍成功记账，再次启动不重做且后续阶段未完成',async t=>{
 const f=await fixture(t);for(const c of f.saved)await f.service.synchronize(c.contact_id);await f.contacts.setReading(false);
 const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;const model=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const run=await memory.start('no-memory');await memory.waitForIdle();const done=await memory.read(run.runId);assert.equal(done.succeeded,2);assert.equal(done.candidates.length,0);assert.equal(done.laterStages,'pending');assert.notEqual(done.state,'completed');assert.equal(model.calls,2);
 const trace=await memory.trace(done.tasks.find(t=>t.scopeKind==='contact').taskId);assert.ok(trace.events.some(e=>e.kind==='model_input'&&e.payload.system.includes('来源')));assert.ok(trace.events.some(e=>e.kind==='stage_result'&&e.payload.outcome==='no_new_memory'));assert.equal(trace.calls[0].state,'succeeded');assert.ok(trace.events.every(e=>e.sources.length===1));
 const next=await memory.start('second');await memory.waitForIdle();assert.equal(next.total,0);assert.equal(model.calls,2);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('已预约发送后未知回执保守占用原目标，手动继续和换轮次均不重发',async t=>{
 const f=await fixture(t);await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;const model=modelPort(()=>memory.accounting,async()=>{throw new Error('synthetic unknown');});memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const first=await memory.start('unknown');await memory.waitForIdle();assert.equal((await memory.read(first.runId)).unknown,1);assert.equal(model.calls,1);
 await memory.continue(first.runId);await memory.waitForIdle();assert.equal(model.calls,1);
 const second=await memory.start('unknown-next');await memory.waitForIdle();assert.equal((await memory.read(second.runId)).unknown,1);assert.equal(model.calls,1);assert.equal((await memory.read(first.runId)).inputs[0].itemId,(await memory.read(second.runId)).inputs[0].itemId);
});
test('普通暂停允许在途小批完成，继续沿原任务只处理剩余固定目标',async t=>{
 const f=await fixture(t);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:21},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let entered,release;const ready=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);let memory;
 const model=modelPort(()=>memory.accounting,async request=>{if(model.calls===1){entered();await waiting;}return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const run=await memory.start('pause');await ready;await memory.pause(run.runId);release();await memory.waitForIdle();const paused=await memory.read(run.runId);assert.equal(paused.state,'paused');assert.equal(paused.succeeded,20);assert.equal(model.calls,1);
 await memory.continue(run.runId);await memory.waitForIdle();const done=await memory.read(run.runId);assert.equal(done.succeeded,21);assert.equal(model.calls,2);assert.deepEqual(done.tasks.map(t=>t.taskId),run.tasks.map(t=>t.taskId));assert.equal(done.laterStages,'pending');
});
test('取消一个联系人立即拒绝其迟到产物，其他已选联系人继续且不复活旧任务',async t=>{
 const f=await fixture(t);for(const c of f.saved)await f.service.synchronize(c.contact_id);await f.contacts.setReading(false);
 const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let entered,release;const ready=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);let memory;
 const model=modelPort(()=>memory.accounting,async request=>{if(model.calls===1){entered(JSON.parse(request.user).messages[0].message_id);await waiting;}return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 const run=await memory.start('cancel-one');const message=await ready;const contact=run.inputs.find(i=>i.messageId===message).contactId;const binding=f.saved.find(c=>c.contact_id===contact);await f.contacts.revoke(contact,binding.binding_id,binding.selection_generation);release();await memory.waitForIdle();
 const done=await memory.read(run.runId);assert.equal(done.succeeded,1);assert.equal(done.tasks.find(t=>t.contactId===contact).state,'revoked');assert.equal(done.tasks.find(t=>t.contactId&&t.contactId!==contact).state,'succeeded');assert.equal(done.tasks.find(t=>t.scopeKind==='self').state,'revoked');assert.equal(model.calls,2);
 await assert.rejects(memory.trace(done.tasks.find(t=>t.contactId===contact).taskId));
});
test('旧失败轮继续不重做另一轮已成功目标，也不把新轮成功改写为旧轮成功',async t=>{
 const f=await fixture(t);await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;const port=modelPort(()=>memory.accounting);let first=true;const prepare=port.prepare;port.prepare=async(...args)=>{if(first){first=false;throw Object.assign(new Error('synthetic-known-config'),{code:'extraction_model_unconfigured'});}return prepare(...args);};memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.start('old-known-failure');await memory.waitForIdle();assert.equal(port.calls,0);const next=await memory.start('new-success');await memory.waitForIdle();assert.equal((await memory.read(next.runId)).succeeded,1);assert.equal(port.calls,1);
 await memory.continue(old.runId);await memory.waitForIdle();assert.equal(port.calls,1);const after=await memory.read(old.runId);assert.equal(after.succeeded,0);assert.equal(after.tasks.find(t=>t.scopeKind==='contact').errorCode,'targets_completed_elsewhere');
});
test('晚到早时间消息的实际载荷和完整追踪presentation顺序一致',async t=>{
 const f=await fixture(t);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sentAt:'1700000002000'}),record('2',{sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;memory=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>memory.accounting));t.after(()=>memory.close());
 const run=await memory.start('actual-order');await memory.waitForIdle();const trace=await memory.trace(run.tasks.find(t=>t.scopeKind==='contact').taskId);const input=trace.events.find(e=>e.kind==='model_input');const actual=JSON.parse(input.payload.user).messages.map(m=>m.message_id);const tracked=input.inputNos.map(n=>run.inputs.find(i=>i.inputNo===n).messageId);assert.deepEqual(tracked,actual);assert.notDeepEqual(actual,run.inputs.map(i=>i.messageId));
});
test('已知模型回执至阶段提交之间仍占用同一目标，另一轮不能并发重复效果',async t=>{
 const f=await fixture(t);await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;const port=modelPort(()=>memory.accounting);const invoke=port.invoke;let entered,release;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r);port.invoke=async(...args)=>{const result=await invoke(...args);if(port.calls===1){entered();await pending;}return result;};memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const first=await memory.start('known-before-commit');await ready;
 let second;
 try{
  second=await memory.start('concurrent-same-target');
  // 正式步骤按 FIFO 串行；闸门关闭期间核对没有第二次物理调用，不等待排队轮次先结束。
  assert.equal(port.calls,1);
  assert.ok((await memory.read(second.runId)).tasks.some(task=>task.state==='pending'));
 }finally{release();}
 await memory.waitForIdle();assert.equal(port.calls,1);assert.equal((await memory.read(first.runId)).succeeded,1);assert.equal((await memory.read(second.runId)).succeeded,0);
 await memory.continue(second.runId);await memory.waitForIdle();assert.equal(port.calls,1);
});
test('公共供应商认证失败保存可识别原因并暂停整轮，不把两位联系人的资料重复出站',async t=>{
 const f=await fixture(t);for(const c of f.saved)await f.service.synchronize(c.contact_id);await f.contacts.setReading(false);const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;const port=modelPort(()=>memory.accounting);let calls=0;
 port.invoke=async(request,i)=>{calls++;const {randomUUID}=await import('node:crypto');const receipt={attempt_id:i.attemptId,permit_id:randomUUID(),request_id:i.requestId,...i.scope,provider:'synthetic',model:'synthetic',called_at:new Date().toISOString(),latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null},input_budget:{measurement_id:'synthetic-measurement',measurement_kind:'approximate',input_tokens:10,max_output_tokens:16,context_window_tokens:100100,safety_margin_tokens:16,request_sha256:'a'.repeat(64),serialized_bytes:Buffer.byteLength(request.user)}};await memory.accounting.reserve(receipt,i.claim);await i.onReceipt({...receipt,outcome:'failed',dispatch:'response_observed'});throw Object.assign(new Error('不记录供应商异常原文'),{code:'extraction_model_call_failed',provider_failure:{code:'AUTHENTICATION_ERROR',status:401}});};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());const run=await memory.start('shared-model-failure');await memory.waitForIdle();const after=await memory.read(run.runId);assert.equal(after.state,'paused');assert.equal(calls,1);assert.equal(after.succeeded,0);const failed=after.tasks.find(t=>t.state==='failed');assert.equal(failed.errorCode,'extraction_model_authentication_failed');const trace=await memory.trace(failed.taskId);assert.deepEqual(trace.events.find(e=>e.kind==='model_failure').payload,{code:'extraction_model_call_failed',providerCode:'AUTHENTICATION_ERROR',status:401,transport_category:null,stage:null,elapsed_ms:null,request_bytes:null,image_count:0});assert.doesNotMatch(JSON.stringify(trace),/不记录供应商异常原文/);
});
test('未勾选联系人已有文字、非文字占位与未核验记录均不进入手动固定目标',async t=>{
 const f=await fixture(t);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('2',{kind:'voice',text:'非文字不能提取'}),record(null)],completedPartitions:['shard-a'],exhausted:true});for(const c of f.saved)await f.service.synchronize(c.contact_id);const excluded=f.saved[1];await f.contacts.revoke(excluded.contact_id,excluded.binding_id,excluded.selection_generation);await f.contacts.setReading(false);const {modelPort}=await import('./fixtures/memory-sqlite/support.mjs');let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const run=await memory.start('selected-text-only');await memory.waitForIdle();assert.equal(run.total,1);assert.ok(run.inputs.every(i=>i.contactId===f.saved[0].contact_id));assert.equal(port.calls,1);assert.equal((await memory.read(run.runId)).succeeded,1);assert.equal((await f.service.read(excluded.contact_id)).messages.filter(m=>m.kind==='text').length,1,'取消选择保留已保存资料，但不能扩大本轮处理');
});
