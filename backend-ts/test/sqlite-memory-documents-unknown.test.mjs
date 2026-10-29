import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unknownFixture} from './fixtures/memory-documents/unknown-support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

for(const stage of ['document_scene','document_profile'])test(`联系人${stage}未知后新输入不得重发同范围同效果，另一联系人仍能完成`,{timeout:20000},async t=>{
 const f=await unknownFixture(t,{unknownStage:stage});
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);
 const first=await f.extraction.start(`unknown-first-${stage}`);await f.extraction.waitForIdle(first.runId);
 const firstTask=(await f.extraction.read(first.runId)).tasks.find(task=>task.contactId===f.a),old=await f.documents.readTask(firstTask.taskId);
 assert.equal(old.stages.find(s=>s.kind===(stage==='document_scene'?'scene':'profile'))?.status,'unknown',JSON.stringify(old));
 assert.equal(f.calls.filter(call=>call.scope===f.a&&call.stage===stage).length,1);
 const occupied=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.state==='unknown'&&item.effect_kind===stage);
 assert.equal(occupied.state,'unknown');assert.equal(occupied.effect_kind,stage);
 await assert.rejects(f.storage.execute('fixture.duplicateEffect',{ownerId:f.owner,operationId:occupied.operation_id}),{code:'fixture_effect_scope_unique'},'活动范围唯一索引须在数据库层拒绝重复占用');
 await f.add(f.a,[f.record('2',{text:'我还长期喜欢合成烘焙。'})]);
 await f.add(f.b,[f.record('1',{text:'我长期喜欢合成游泳。'})]);
 const next=await f.extraction.start(`unknown-new-input-${stage}`);await f.extraction.waitForIdle(next.runId);
 const independent=await f.documents.read({scopeKind:'contact',contactId:f.b});
 assert.equal(independent.documents.length,2,'独立B范围不受A未知效果阻塞');
 const same=f.calls.filter(call=>call.scope===f.a&&call.stage===stage);
 assert.equal(same.length,1,`旧调用未知时新A任务不得重复${stage}物理发送：${JSON.stringify(same)}`);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('用户新轮复用成功提取但不能绕过未知文档效果锁',{timeout:20000},async t=>{
 const f=await unknownFixture(t,{});await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);
 const first=await f.extraction.start('unknown-retry-first');await f.extraction.waitForIdle(first.runId);
 const count=f.calls.length,next=await f.extraction.start('unknown-retry-no-new-message');await f.extraction.waitForIdle(next.runId);
 const run=await f.extraction.read(next.runId),task=run.tasks.find(item=>item.contactId===f.a),state=await f.documents.readTask(task.taskId);
 assert.equal(run.total,1);assert.equal(run.succeeded,1);assert.equal(state.errorCode,'document_model_unknown');
 assert.equal(f.calls.length,count,'新轮不能借复用已成功提取绕过未知效果锁');
 assert.notEqual(run.state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('本人主题调用未知后贡献联系人改变仍不得重发本人同效果，独立联系人可完成',{timeout:20000},async t=>{
 const f=await unknownFixture(t,{unknownScope:'self'});
 await f.add(f.a,[f.record('1',{sender:'owner',text:'我长期喜欢合成茶饮。'})]);
 const first=await f.extraction.start('unknown-owner-a');await f.extraction.waitForIdle(first.runId);
 const firstTask=(await f.extraction.read(first.runId)).tasks.find(task=>task.scopeKind==='self'),old=await f.documents.readTask(firstTask.taskId);
 assert.equal(old.stages.find(s=>s.kind==='scene')?.status,'unknown',JSON.stringify(old));
 const occupied=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.state==='unknown');
 assert.equal(occupied.scope_kind,'self');assert.equal(occupied.contact_id,null);
 await assert.rejects(f.storage.execute('fixture.duplicateEffect',{ownerId:f.owner,operationId:occupied.operation_id}),{code:'fixture_effect_scope_unique'});
 await f.add(f.a,[f.record('2',{text:'我长期喜欢合成拼图。'})]);
 await f.add(f.b,[f.record('1',{sender:'owner',text:'我长期喜欢合成散步。'}),f.record('2',{text:'我长期喜欢合成骑行。'})]);
 const next=await f.extraction.start('unknown-owner-b');await f.extraction.waitForIdle(next.runId);
 const task=(await f.extraction.read(next.runId)).tasks.find(item=>item.scopeKind==='self'),state=await f.documents.readTask(task.taskId);
 assert.equal(state.stages.find(item=>item.kind==='scene')?.errorCode,'document_model_unknown',JSON.stringify(state));
 const independent=await f.documents.read({scopeKind:'contact',contactId:f.b});
 assert.equal(independent.documents.length,2,'独立B范围可在本人未知时完成');
 const same=f.calls.filter(call=>call.scope===null&&call.stage==='document_scene');
 assert.equal(same.length,1,`本人unknown不能通过更换贡献联系人绕过：${JSON.stringify(same)}`);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

const settled=receipt=>({...receipt,dispatch:'response_observed',outcome:'succeeded',latency_ms:1,usage:{input_tokens:10,output_tokens:1,cache_read_tokens:null,cache_write_tokens:null}});

test('非封存的未知尝试已结束后收到真实成功回执，解除占用且旧结果不得提交',{timeout:20000},async t=>{
 const f=await unknownFixture(t,{});await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);
 const first=await f.extraction.start('unknown-late-success');await f.extraction.waitForIdle(first.runId);
 const receipt=settled(f.receipts[0]),before=await f.storage.execute('fixture.modelCall',{ownerId:f.owner,callId:receipt.attempt_id});
 assert.equal(before.state,'unknown');assert.equal(before.operation_state,'unknown');assert.ok(before.step_attempt_id);
 await assert.rejects(f.storage.execute('memoryDocuments.output',{ownerId:f.owner,attemptId:before.step_attempt_id,callId:receipt.attempt_id,blocks:[]}),{code:'document_attempt_stale'});
 await assert.rejects(f.extraction.accounting.recordReserved({...receipt,permit_id:randomUUID()}),{code:'memory_extraction_receipt_mismatch'});
 await assert.rejects(f.extraction.accounting.recordReserved({...receipt,input_budget:{...receipt.input_budget,max_output_tokens:receipt.input_budget.max_output_tokens-1}}),{code:'memory_extraction_receipt_mismatch'});
 assert.equal((await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id).state,'unknown','无法验证的回执不能解除占用');
 await f.extraction.accounting.recordReserved(receipt);
 const known=await f.storage.execute('fixture.modelCall',{ownerId:f.owner,callId:receipt.attempt_id});
 assert.equal(known.state,'succeeded');assert.equal(known.settlement_state,'settled');assert.equal(known.actual_budget_units,11n);assert.equal(known.reserved_budget_units,26n);
 assert.notEqual(known.operation_state,'sealed','模拟未被删除封存的原操作');
 const lock=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id);
 assert.equal(lock.state,'released','旧attempt已终止且不能提交，已知回执应解除效果占用');
 await assert.rejects(f.storage.execute('memoryDocuments.output',{ownerId:f.owner,attemptId:before.step_attempt_id,callId:receipt.attempt_id,blocks:[]}),{code:'document_attempt_stale'});
 await f.add(f.a,[f.record('2',{text:'我长期喜欢合成烘焙。'})]);
 const next=await f.extraction.start('new-input-after-late-success');await f.extraction.waitForIdle(next.runId);
 assert.ok(f.calls.filter(call=>call.scope===f.a&&call.stage==='document_scene').length>1,'确认结算后同范围新输入可由用户发起正常处理');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.a})).documents.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('已核验成功回执在输出落盘前保持活动效果占用',{timeout:20000},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let held=false;t.after(()=>release.resolve());
 const f=await unknownFixture(t,{unknownScope:'none',beforeCall:async({input})=>{if(input.scope.contact_id===f.a&&!held){held=true;entered.resolve();await release.promise;}}});
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);const run=await f.extraction.start('known-before-output');await entered.promise;
 const receipt=settled(f.receipts[0]);await f.storage.execute('memoryExtraction.receipt',{receipt});
 const active=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id);
 assert.equal(active.call_state,'succeeded');assert.equal(active.state,'sent','可提交的已知回执须保持占用直到实际输出落盘');
 release.resolve();await f.extraction.waitForIdle(run.runId);
 const after=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id);
 assert.equal(after.state,'released');assert.equal(after.actual_budget_units,11n);
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.a})).documents.length,2);
});

test('来源清理后未知占用仍阻断同效果；真实迟到结算只释放占用并记真实用量',{timeout:20000},async t=>{
 const f=await unknownFixture(t,{});await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);
 const source=(await f.service.read(f.a)).messages[0].sourceRecordIds[0],first=await f.extraction.start('unknown-delete-source');await f.extraction.waitForIdle(first.runId);
 const receipt=settled(f.receipts[0]),plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.a,sourceId:source}});
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 let lock=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id);
 assert.equal(lock.state,'unknown');assert.equal(lock.operation_state,'sealed');assert.equal(lock.memory_step_id,null);assert.equal(lock.reserved_budget_units,26n);assert.equal(lock.actual_budget_units,null);
 assert.equal(JSON.parse(lock.receipt).input_budget,undefined,'不能保留已删请求指纹');
 await f.add(f.a,[f.record('2',{text:'我长期喜欢合成烘焙。'})]);await f.add(f.b,[f.record('1',{text:'我长期喜欢合成游泳。'})]);
 const next=await f.extraction.start('unknown-after-source-delete');await f.extraction.waitForIdle(next.runId);
 assert.equal(f.calls.filter(call=>call.scope===f.a&&call.stage==='document_scene').length,1);
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.b})).documents.length,2);
 const wrongPermit={...receipt,permit_id:randomUUID()};await assert.rejects(f.storage.execute('memoryExtraction.receipt',{receipt:wrongPermit}),{code:'memory_extraction_receipt_mismatch'});
 await assert.rejects(f.storage.execute('memoryExtraction.receipt',{receipt:{...receipt,contact_id:f.b}}),{code:'memory_extraction_receipt_mismatch'});
 for(const changed of [{owner_id:randomUUID()},{request_id:randomUUID()},{provider:'synthetic-other'},{model:'synthetic-other'}])await assert.rejects(f.storage.execute('memoryExtraction.receipt',{receipt:{...receipt,...changed}}),{code:'memory_extraction_reservation_missing'});
 const wrongBudget={...receipt,input_budget:{...receipt.input_budget,max_output_tokens:receipt.input_budget.max_output_tokens-1}};
 await assert.rejects(f.storage.execute('memoryExtraction.receipt',{receipt:wrongBudget}),{code:'memory_extraction_receipt_mismatch'});
 await f.storage.execute('memoryExtraction.receipt',{receipt});await f.storage.execute('memoryExtraction.receipt',{receipt});
 lock=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id);
 assert.equal(lock.state,'released');assert.equal(lock.operation_state,'sealed');assert.equal(lock.call_state,'succeeded');assert.equal(lock.actual_budget_units,11n);assert.equal(lock.settlement_state,'settled');
 assert.equal(JSON.parse(lock.receipt).input_budget,undefined);assert.equal(lock.receipt.includes(receipt.input_budget.request_sha256),false,'迟到回执不能复活已删请求指纹');
 assert.deepEqual((await f.documents.read({scopeKind:'contact',contactId:f.a})).documents,[],'迟到结算不能发布被删正文');
 await f.add(f.a,[f.record('3',{text:'我长期喜欢合成象棋。'})]);
 const following=await f.extraction.start('known-after-source-delete');await f.extraction.waitForIdle(following.runId);
 assert.ok(f.calls.filter(call=>call.scope===f.a&&call.stage==='document_scene').length>1,'真实结算后，新来源可由用户发起新的独立处理');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.a})).documents.length,2);
 const contactPlan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.a}}),contactDone=await f.deletion.advance({ownerId:f.owner,operationId:contactPlan.operationId});
 assert.equal(contactDone.state,'completed',JSON.stringify(contactDone.checks));assert.ok(!(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).some(item=>item.call_id===receipt.attempt_id));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const outcome of ['succeeded','failed','unknown'])test(`删除fence后排空期间迟到${outcome}回执按真实结算处理`,{timeout:20000},async t=>{
 const entered=Promise.withResolvers(),aborted=Promise.withResolvers(),release=Promise.withResolvers();let invocation;t.after(()=>release.resolve());
 const f=await unknownFixture(t,{unknownScope:'none',beforeCall:async({input})=>{
  if(invocation)return;invocation=input;entered.resolve();
  if(!input.signal.aborted)await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));
  aborted.resolve();await release.promise;throw Error('合成调用完成排空');
 }});
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);const source=(await f.service.read(f.a)).messages[0].sourceRecordIds[0];
 const run=await f.extraction.start(`fenced-late-${outcome}`);await entered.promise;
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.a,sourceId:source}});
 let completed=false;const deleting=f.deletion.advance({ownerId:f.owner,operationId:plan.operationId}).then(value=>{completed=true;return value;});
 await aborted.promise;assert.equal(completed,false,'清理必须等待真正调用者排空');
 const reserved=f.receipts.find(item=>item.attempt_id===invocation.attemptId);
 const receipt=outcome==='unknown'?{...reserved,outcome:'unknown'}:{...settled(reserved),outcome};
 await invocation.onReceipt(receipt);
 const locked=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===receipt.attempt_id);
 assert.equal(locked.operation_state,'sealed');assert.ok(locked.commit_forbidden_at!==null);assert.equal(locked.reserved_budget_units,26n);
 assert.equal(locked.call_state,outcome);assert.equal(locked.state,outcome==='unknown'?'unknown':'released');
 assert.equal(locked.actual_budget_units,outcome==='unknown'?null:11n);assert.equal(locked.settlement_state,outcome==='unknown'?'unknown':'settled');
 await assert.rejects(f.storage.execute('memoryDocuments.output',{ownerId:f.owner,attemptId:invocation.claim.step_id,callId:receipt.attempt_id,blocks:[]}),{code:'document_attempt_stale'});
 release.resolve();await f.extraction.waitForIdle(run.runId);const done=await deleting;assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const after=await f.storage.execute('fixture.modelCall',{ownerId:f.owner,callId:receipt.attempt_id});assert.equal(after.state,outcome);assert.equal(after.operation_state,'sealed');
 assert.equal(after.reserved_budget_units,26n);assert.equal(after.actual_budget_units,outcome==='unknown'?null:11n);
 assert.equal(JSON.parse(after.receipt).input_budget,undefined);assert.equal(after.receipt.includes(reserved.input_budget.request_sha256),false);
 const scopes=await f.storage.execute('fixture.effectScopes',{ownerId:f.owner});
 assert.equal(scopes.some(item=>item.call_id===receipt.attempt_id&&item.state==='unknown'),outcome==='unknown');
 assert.deepEqual((await f.documents.read({scopeKind:'contact',contactId:f.a})).documents,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('unknown效果锁持久化跨Worker重启且数据库仍拒绝重复占用',{timeout:20000},async t=>{
 const f=await unknownFixture(t,{});await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);
 const run=await f.extraction.start('unknown-persist');await f.extraction.waitForIdle(run.runId);
 const databaseId=f.storage.status.databaseId,before=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.state==='unknown');
 await f.extraction.close();await f.adjudication.close();await f.documents.close();await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:new URL('./fixtures/memory-documents/unknown-registry.mjs',import.meta.url).href});
 try{
  const documents=new SqliteMemoryDocuments(reopened,f.owner,undefined,new ActiveHolders());await documents.initialize();
  const after=(await reopened.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.operation_id===before.operation_id);
  assert.equal(after.state,'unknown');assert.equal(after.call_state,'unknown');assert.equal(after.reserved_budget_units,before.reserved_budget_units);
  await assert.rejects(reopened.execute('fixture.duplicateEffect',{ownerId:f.owner,operationId:after.operation_id}),{code:'fixture_effect_scope_unique'});
  assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});await documents.close();
 }finally{await reopened.close();}
});

test('Worker重开恢复发送中调用为unknown并继续阻断同效果',{timeout:20000},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let invocation;t.after(()=>release.resolve());
 const f=await unknownFixture(t,{unknownScope:'none',beforeCall:async({input})=>{if(invocation)return;invocation=input;entered.resolve();await release.promise;throw Error('合成旧worker消失');}});
 await f.add(f.a,[f.record('1',{text:'我长期喜欢合成园艺。'})]);const run=await f.extraction.start('recover-sending');await entered.promise;
 const before=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===invocation.attemptId);assert.equal(before.state,'sent');assert.equal(before.call_state,'sending');
 const databaseId=f.storage.status.databaseId;await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:new URL('./fixtures/memory-documents/unknown-registry.mjs',import.meta.url).href});
 try{
  const documents=new SqliteMemoryDocuments(reopened,f.owner,undefined,new ActiveHolders());await documents.initialize();
  const after=(await reopened.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.call_id===invocation.attemptId);
  assert.equal(after.state,'unknown');assert.equal(after.call_state,'unknown');assert.equal(after.settlement_state,'unknown');assert.equal(after.reserved_budget_units,before.reserved_budget_units);
  await assert.rejects(reopened.execute('fixture.duplicateEffect',{ownerId:f.owner,operationId:after.operation_id}),{code:'fixture_effect_scope_unique'});
  release.resolve();await assert.rejects(f.extraction.waitForIdle(run.runId),{code:'worker_failed'});await documents.close();assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{release.resolve();await reopened.close();}
});

for(const kind of ['contact','account'])for(const unknownScope of ['contact','self'])test(`${kind}删除清除${unknownScope}未知效果锁与账本且无孤键`,{timeout:20000},async t=>{
 const f=await unknownFixture(t,{unknownScope});await f.add(f.a,[f.record('1',{sender:unknownScope==='self'?'owner':'contact',text:'我长期喜欢合成园艺。'})]);
 const run=await f.extraction.start(`delete-${kind}-${unknownScope}`);await f.extraction.waitForIdle(run.runId);
 const lock=(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).find(item=>item.state==='unknown');assert.ok(lock);
 const scope=kind==='contact'?{kind,contactId:f.a}:{kind};
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope}),done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});
 assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.equal(await f.storage.execute('fixture.modelCall',{ownerId:f.owner,callId:lock.call_id}),null);
 assert.ok(!(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner})).some(item=>item.operation_id===lock.operation_id));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
