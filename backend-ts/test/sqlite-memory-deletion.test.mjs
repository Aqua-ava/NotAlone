import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {randomUUID} from 'node:crypto';
import {measureSerializedMessages} from '../src/platform/models/model-input-budget.ts';
import {modelLedgerInputBudget} from '../src/platform/models/model-ledger.ts';

const registryModule=new URL('./fixtures/sqlite-memory-deletion/registry.mjs',import.meta.url).href;
function syntheticModel(accounting,options={}){
  const binding={provider:'synthetic',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'};
  const profile={context_window_tokens:1048576,safety_margin_tokens:4096};
  return {prepare:async()=>({provider:binding.provider,model:binding.model,configurationId:'synthetic-v1',
    maxInputTokens:1043968,maxOutputTokens:512,contextWindowTokens:1048576,safetyMarginTokens:4096}),
    invoke:async(request,input)=>{
      await input.requireCurrent();
      const body={model:binding.model,stream:true,max_tokens:512,temperature:0,thinking:{type:'disabled'},
        system:request.system,messages:[{role:'user',content:[{type:'text',text:request.user}]}],tools:[request.tool]};
      const receipt={attempt_id:input.attemptId,permit_id:randomUUID(),request_id:input.requestId,...input.scope,
        provider:binding.provider,model:binding.model,called_at:new Date().toISOString(),latency_ms:null,
        dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,
        input_budget:modelLedgerInputBudget(measureSerializedMessages(body,binding,profile)),
        cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
      await accounting().reserve(receipt,input.claim);
      await options.beforeReturn?.({request,input,receipt});
      const terminal={...receipt,dispatch:'response_observed',outcome:'succeeded',latency_ms:1,
        usage:{input_tokens:3,output_tokens:2,cache_read_tokens:null,cache_write_tokens:null}};
      await accounting().recordReserved(terminal);await input.onReceipt(terminal);
      return {blocks:[{type:'tool-call',id:randomUUID(),name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]};
    }};
}
test('正常来源删除清固定输入并撤销混合本人任务，保留另一联系人的固定任务',async t=>{
  const f=await fixture(t,{registryModule});
  for(const contact of f.saved)await f.service.synchronize(contact.contact_id);
  await f.contacts.setReading(false);
  let memory;memory=new SqliteMemoryExtraction(f.storage,owner,syntheticModel(()=>memory.accounting));t.after(()=>memory.close());
  const run=await memory.start('source-delete-run');
  await memory.waitForIdle();
  const processed=await memory.read(run.runId);assert.equal(processed.succeeded,2,JSON.stringify(processed.tasks));
  const deleted=run.inputs[0],kept=run.inputs.find(i=>i.contactId!==deleted.contactId);
  const holders=new ActiveHolders(),closed=[];
  for(const task of run.tasks)holders.register({key:`memory:${task.taskId}`,ownerId:owner,
    ...(task.scopeKind==='contact'?{contactId:task.contactId}:{coversAllContacts:true}),generation:0n,
    close:async()=>{closed.push(task.taskId);}});
  const deletion=new DeletionService(f.storage,holders,new ManagedFiles(f.root));
  const plan=await deletion.plan({ownerId:owner,requestKey:'source-delete',scope:{kind:'source',contactId:deleted.contactId,sourceId:deleted.recordId}});
  assert.equal(plan.state,'fenced');
  assert.equal(await f.storage.execute('deletion.requestAllowed',{ownerId:owner,namespace:'memoryExtraction.start',key:'source-delete-run'}),false);
  const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});
  assert.equal(done.state,'completed',JSON.stringify(done.checks));
  const after=await memory.read(run.runId);
  assert.deepEqual(after.inputs.map(i=>i.contactId),[kept.contactId]);
  assert.deepEqual(after.tasks.map(task=>task.scopeKind),['contact']);
  assert.equal(after.tasks[0].contactId,kept.contactId);assert.equal(after.tasks[0].state,'succeeded');
  await assert.rejects(memory.trace(run.tasks.find(task=>task.contactId===deleted.contactId).taskId),{code:'memory_extraction_not_found'});
  assert.ok((await memory.trace(after.tasks[0].taskId)).events.some(e=>e.kind==='model_input'));
  assert.equal(closed.length,2,'只排空受影响联系人和完整本人混合持有者');
  const retainedCalls=plan.targets.filter(t=>t.target?.domain==='memory_extraction'&&t.target.rowKind==='model_call').map(t=>t.target.key.id);
  assert.equal(retainedCalls.length,1);
  const contactPlan=await deletion.plan({ownerId:owner,requestKey:'contact-delete',scope:{kind:'contact',contactId:deleted.contactId}});
  assert.deepEqual(contactPlan.targets.filter(t=>t.target?.domain==='memory_extraction'&&t.target.rowKind==='model_call').map(t=>t.target.key.id),retainedCalls,
    '整联系人删除仍能通过保留范围找回此前来源删除后封存的无正文台账');
  assert.equal((await deletion.advance({ownerId:owner,operationId:contactPlan.operationId})).state,'completed');
  const accountPlan=await deletion.plan({ownerId:owner,requestKey:'account-delete',scope:{kind:'account'}});
  assert.equal((await deletion.advance({ownerId:owner,operationId:accountPlan.operationId})).state,'completed');
  assert.equal(await memory.read(),null);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('仅作实际前文的来源删除也清整窗证明，其他合法目标沿同一item重新核验',async t=>{
  const f=await fixture(t,{registryModule});for(const contact of f.saved)await f.service.synchronize(contact.contact_id);
  await f.contacts.setReading(false);
  let memory;memory=new SqliteMemoryExtraction(f.storage,owner,syntheticModel(()=>memory.accounting));t.after(()=>memory.close());
  const first=await memory.start('context-original');await memory.waitForIdle();
  const contactId=f.saved[0].contact_id,source=first.inputs.find(i=>i.contactId===contactId);
  await f.contacts.setReading(true);
  f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('3')],completedPartitions:['shard-a'],exhausted:true});
  await f.service.synchronize(contactId);await f.contacts.setReading(false);
  const second=await memory.start('context-second');await memory.waitForIdle();
  assert.equal(second.total,1);assert.equal(second.inputs.find(i=>i.recordId===source.recordId).role,'context');
  const target=second.inputs.find(i=>i.role==='target');
  const secondTask=second.tasks.find(t=>t.scopeKind==='contact');
  const trace=await memory.trace(secondTask.taskId);
  assert.ok(trace.events.some(event=>event.sources.some(s=>s.recordId===source.recordId)));
  const deletion=new DeletionService(f.storage,memory.holders,new ManagedFiles(f.root));
  const plan=await deletion.plan({ownerId:owner,requestKey:'context-delete',scope:{kind:'source',contactId,sourceId:source.recordId}});
  assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');
  await assert.rejects(memory.trace(secondTask.taskId),{code:'memory_extraction_not_found'});
  const next=await memory.start('context-new-proof');
  assert.equal(next.total,1);assert.equal(next.inputs.find(i=>i.role==='target').itemId,target.itemId);
  assert.equal(next.inputs.find(i=>i.role==='target').recordId,target.recordId);
  assert.equal(next.inputs.some(i=>i.recordId===source.recordId),false);
  await memory.waitForIdle();assert.equal((await memory.read(next.runId)).succeeded,1);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('来源删除等待真实活动任务退出，旧模型回调到达后不能恢复正文或提交成功',async t=>{
  const f=await fixture(t,{registryModule});for(const contact of f.saved)await f.service.synchronize(contact.contact_id);
  await f.contacts.setReading(false);
  let begin,release,first=true;
  const entered=new Promise(resolve=>begin=resolve),pending=new Promise(resolve=>release=resolve);
  let memory;memory=new SqliteMemoryExtraction(f.storage,owner,syntheticModel(()=>memory.accounting,{beforeReturn:async()=>{
    if(first){first=false;begin();await pending;}
  }}));t.after(()=>memory.close());
  const run=await memory.start('late-run');await entered;
  const source=run.inputs[0],task=run.tasks.find(t=>t.contactId===source.contactId);
  const deletion=new DeletionService(f.storage,memory.holders,new ManagedFiles(f.root),{drainTimeoutMs:20});
  const plan=await deletion.plan({ownerId:owner,requestKey:'late-delete',scope:{kind:'source',contactId:source.contactId,sourceId:source.recordId}});
  const blocked=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(blocked.state,'blocked');
  assert.ok(blocked.checks.some(check=>check.result.proof==='deletion_holder_timeout'));
  await assert.rejects(memory.trace(task.taskId),{code:'memory_extraction_not_found'});
  release();await memory.waitForIdle();
  const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
  await assert.rejects(memory.trace(task.taskId),{code:'memory_extraction_not_found'});
  const after=await memory.read(run.runId);assert.equal(after.succeeded,1);assert.equal(after.inputs.some(i=>i.recordId===source.recordId),false);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
