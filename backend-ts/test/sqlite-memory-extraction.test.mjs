import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,owner,record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteMemoryExtraction } from '../src/memory/sqlite/service.ts';
const none={invoke:async()=>({blocks:[{type:'tool_use',id:'synthetic',name:'extract_relationship_memories',input:{scenes:[]}}]})};
test('关闭读取后原子冻结已勾选联系人全部合法文字，同请求只建立原轮次且后到消息不追加',async t=>{
 const f=await fixture(t);for(const c of f.saved)await f.service.synchronize(c.contact_id);
 await f.contacts.setReading(false);
 const memory=new SqliteMemoryExtraction(f.storage,owner,none);t.after(()=>memory.close());
 const first=await memory.start('fixed-request');assert.equal(first.total,2);assert.equal(first.inputs.length,2);assert.equal(first.tasks.filter(t=>t.scopeKind==='contact').length,2);
 assert.equal((await memory.start('fixed-request')).runId,first.runId);
 await f.contacts.setReading(true);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('3')],completedPartitions:['shard-a'],exhausted:true});
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
