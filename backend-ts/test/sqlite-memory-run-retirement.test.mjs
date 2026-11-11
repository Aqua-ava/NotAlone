import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

test('已知失败且占位已释放的运行允许新历史轮领取原目标',async t=>{
 const f=await fixture(t);const contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory,fail=true;const port=modelPort(()=>memory.accounting),prepare=port.prepare;
 port.prepare=async(...args)=>{if(fail)throw Object.assign(Error('合成确定失败'),{code:'extraction_model_purpose_invalid'});return prepare(...args);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const first=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(first.run.runId);
 assert.equal((await memory.readContact(contactId)).run.state,'failed');fail=false;
 const second=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(second.run.runId);
 assert.notEqual(second.run.runId,first.run.runId);assert.equal((await memory.read(second.run.runId)).succeeded,1);assert.equal(port.calls,1);
});

const registryModule=new URL('./fixtures/memory-sqlite/run-retirement-registry.mjs',import.meta.url).href;
test('范围代次已变的暂停运行经产品退休释放目标，成功历史保留',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory,fail=true;const port=modelPort(()=>memory.accounting),prepare=port.prepare;
 port.prepare=async(...args)=>{if(fail)throw Object.assign(Error('合成确定失败'),{code:'extraction_model_purpose_invalid'});return prepare(...args);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),1);
 assert.equal((await memory.read(old.run.runId)).state,'revoked');assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),0);
 fail=false;const next=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(next.run.runId);
 assert.equal((await memory.read(next.run.runId)).succeeded,1);assert.equal(port.calls,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('范围失效但存在未知调用的暂停运行不能退休或借新历史轮重发',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting,async()=>{throw Object.assign(Error('合成未知回执'),{code:'extraction_model_call_failed'});});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),0);
 assert.equal((await memory.read(old.run.runId)).state,'paused');await assert.rejects(memory.startHistory(contactId,randomUUID()),{code:'memory_extraction_history_blocked'});assert.equal(port.calls,1);
});

test('合法用户暂停不会因新资料或退休扫描自动解除',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting);port.prepare=async()=>{throw Object.assign(Error('合成确定失败'),{code:'extraction_model_purpose_invalid'});};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId,stale:false});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),0);assert.equal((await memory.read(old.run.runId)).state,'paused');
});

test('仅owner反馈快照永久失配的暂停运行也会退休并释放原目标',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory,fail=true;const port=modelPort(()=>memory.accounting),prepare=port.prepare;
 port.prepare=async(...args)=>{if(fail)throw Object.assign(Error('合成确定失败'),{code:'extraction_model_purpose_invalid'});return prepare(...args);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId,stale:false,ownerFeedbackStale:true});
 await assert.rejects(f.storage.execute('fixture.assertRunInputs',{ownerId:owner,runId:old.run.runId}),{code:'memory_extraction_scope_stale'});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),1);
 assert.equal((await memory.read(old.run.runId)).state,'revoked');
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),0);
 fail=false;const next=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(next.run.runId);
 assert.equal((await memory.read(next.run.runId)).succeeded,1);assert.equal(port.calls,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('owner快照失配退休保留已有成功步骤和回执历史',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 const history=await f.storage.execute('fixture.runSuccessfulHistory',{ownerId:owner,runId:old.run.runId});assert.ok(history.steps.length);assert.ok(history.attempts.length);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId,stale:false,ownerFeedbackStale:true});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),1);
 assert.deepEqual(await f.storage.execute('fixture.runSuccessfulHistory',{ownerId:owner,runId:old.run.runId}),history);
 assert.equal(port.calls,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('owner反馈失配但调用仍未知时保留暂停和未知保护',async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting,async()=>{throw Object.assign(Error('合成未知回执'),{code:'extraction_model_call_failed'});});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId,stale:false,ownerFeedbackStale:true});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),0);
 assert.equal((await memory.read(old.run.runId)).state,'paused');assert.equal(port.calls,1);
});

test('过期暂停运行退休后新L1可交接真实文档流程的L2和L3',async t=>{
 const {documentFixture}=await import('./fixtures/memory-documents/support.mjs');
 const f=await documentFixture(t,{registryModule,laterScheduling:true});let fail=true;const prepare=f.extractionPort.prepare;
 f.extractionPort.prepare=async(...args)=>{if(fail)throw Object.assign(Error('合成确定失败'),{code:'extraction_model_purpose_invalid'});return prepare(...args);};
 const old=await f.extraction.startHistory(f.contactId,randomUUID());await f.extraction.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:f.owner,contactId:f.contactId,runId:old.run.runId});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:f.owner,now:Date.now()}),1);fail=false;
 const next=await f.extraction.startHistory(f.contactId,randomUUID());await f.extraction.waitForIdle(next.run.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},schedule=await f.documents.readSchedule(scope);
 assert.ok(schedule.scene?.dueAt);await f.documents.runDueStages(schedule.scene.dueAt);
 assert.deepEqual([...new Set(f.calls.map(call=>call.claim.step_name))].sort(),['document_profile','document_scene']);
 assert.equal((await f.extraction.read(next.run.runId)).state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const hold of [{state:'prepared',settlement:'reserved'},{state:'sending',settlement:'reserved'},{state:'unknown',settlement:'unknown'},{state:'failed',settlement:'reserved'},{state:'failed',settlement:'unknown'}])test(`退休前复核完整调用链的${hold.state}/${hold.settlement}阻碍`,async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const old=await memory.startHistory(contactId,randomUUID());await memory.waitForIdle(old.run.runId);
 await f.storage.execute('fixture.stalePausedRun',{ownerId:owner,contactId,runId:old.run.runId,hold});
 assert.equal(await f.storage.execute('fixture.retireStaleRuns',{ownerId:owner,now:Date.now()}),0);assert.equal((await memory.read(old.run.runId)).state,'paused');assert.equal(port.calls,1);
});
