import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

async function append(f,contactId,rows){
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),pageNo=coverage.incremental.pagesAccepted;
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),
  page:{target:f.target.descriptor,cursorIn:`tail-${pageNo+1}`,cursorOut:`tail-${pageNo+2}`,caughtUp:true,records:rows},at:Date.now(),runtimeToken:f.storage.status.runtimeId});
}
async function setup(t,{failure,registryModule}={}){
 const f=await fixture(t,registryModule?{registryModule}:{}),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'})],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 await append(f,contactId,[record('2',{sender:'owner',text:'我长期偏好合成绿茶。'})]);
 let memory;const model=modelPort(()=>memory.accounting,failure==='unknown'?async()=>{throw Error('synthetic unknown receipt');}:supplier().respond);
 if(failure==='known')model.prepare=async()=>{throw Object.assign(Error('synthetic known failure'),{code:'extraction_model_bad_request'});};
 memory=new SqliteMemoryExtraction(f.storage,owner,model);t.after(()=>memory.close());
 return {f,contactId,memory,model};
}

test('本人候选等待决定时新联系人增量仍可独立提取，既有候选保持待决定',async t=>{
 const {f,contactId,memory,model}=await setup(t);
 const first=await memory.start('pending-owner-candidate');await memory.waitForIdle(first.runId);
 await new SqliteMemoryManagement(f.storage,owner).importRun(first.runId);
 const original=await memory.read(first.runId);assert.equal(original.succeeded,2);assert.ok(original.candidates.length>0);
 assert.ok(original.tasks.some(task=>task.scopeKind==='self'&&task.state==='awaiting_decision'));
 await append(f,contactId,[record('3',{text:'我每周参加合成读书会。'})]);
 const now=Date.now()+31*60_000,queue=await memory.readSchedule(now);
 assert.equal(queue.pending,1);assert.equal(queue.blockedContacts,0,'待决定候选不能把已完成提取的联系人堵住');
 assert.deepEqual(await memory.dueContacts(now),[contactId]);
 const next=await memory.startContact(contactId,'new-incremental-after-owner-candidate',now);await memory.waitForIdle(next.runId);
 assert.equal((await memory.read(next.runId)).total,1);assert.equal((await memory.read(next.runId)).succeeded,1);
 assert.equal((await memory.read(first.runId)).candidates.length,original.candidates.length,'新提取不自动决定旧候选');
 assert.equal(model.calls,4,'原两条及新增一条各使用正常提取与核验，不重发原窗口');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const state of ['failed','unknown'])test(`主题整理${state}保留原状态但不阻挡新增文字提取`,async t=>{
 const {f,contactId,memory}=await setup(t,{registryModule:new URL('./fixtures/memory-documents/later-schedule-registry.mjs',import.meta.url).href});
 const first=await memory.start(`document-${state}-isolation`);await memory.waitForIdle(first.runId);
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(first.runId);
 const scope={scopeKind:'contact',contactId},candidate=(await management.read(scope)).candidates[0];
 await management.decide({requestKey:`accept-before-document-${state}`,action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const documents=new SqliteMemoryDocuments(f.storage,owner,undefined,new ActiveHolders());t.after(()=>documents.close());
 await documents.scheduleMemoryChange(scope);
 await f.storage.execute('fixture.laterScheduleFailure',{ownerId:owner,scopeKey:contactId,state});
 assert.equal((await documents.readSchedule(scope)).scene.state,state);
 await append(f,contactId,[record('3')]);
 const now=Date.now()+31*60_000;
 assert.equal((await memory.readSchedule(now)).blockedContacts,0);
 assert.deepEqual(await memory.dueContacts(now),[contactId]);
 assert.equal((await documents.readSchedule(scope)).scene.state,state,'新L1不伪造后续阶段已恢复');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const failure of ['known','unknown'])test(`真实L1${failure}仍保留恢复门，不能借新增量绕过`,async t=>{
 const {f,contactId,memory,model}=await setup(t,{failure});
 const first=await memory.start(`l1-${failure}-stays-blocked`);await memory.waitForIdle(first.runId);
 const before=model.calls;await append(f,contactId,[record('3')]);
 const now=Date.now()+31*60_000;
 assert.equal((await memory.readSchedule(now)).blockedContacts,1);
 assert.deepEqual(await memory.dueContacts(now),[]);assert.equal(model.calls,before);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
