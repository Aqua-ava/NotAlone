import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

test('历史导入完成后自动分批补齐，增量独立且成功目标不重做',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 const history=Array.from({length:61},(_,i)=>record(String(i+1)));
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:history,completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const at=Date.now(),coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId);
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:[record('100')]},at,runtimeToken:f.storage.status.runtimeId});
 assert.deepEqual(await memory.dueHistoryContacts(at),[contactId]);
 const first=await memory.startHistoryBatch(contactId,randomUUID(),at);assert.equal(first.total,50);await memory.waitForIdle(first.runId);
 assert.equal((await memory.read(first.runId)).succeeded,50);
 assert.equal((await memory.readSchedule(at)).pending,1,'新文字仍留在增量队列');
 const second=await memory.startHistoryBatch(contactId,randomUUID(),at+1);assert.equal(second.total,11);await memory.waitForIdle(second.runId);
 assert.deepEqual(await memory.dueHistoryContacts(at+2),[]);
 assert.equal(await memory.startHistoryBatch(contactId,randomUUID(),at+2),null);
 assert.deepEqual(await memory.dueContacts(at+10*60_000),[contactId],'历史批次不能触发增量30分钟冷却');
 const incremental=await memory.startContact(contactId,randomUUID(),at+10*60_000);assert.equal(incremental.total,1);await memory.waitForIdle(incremental.runId);
 assert.equal((await memory.read(incremental.runId)).succeeded,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('未完成的历史导入不提前提取；恢复到终页后自动可领取',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>{if(cursor)throw Error('synthetic-import-interrupted');return {target:target.descriptor,cursorIn:null,cursorOut:'page-2',records:[record('1')],completedPartitions:[],exhausted:false};};
 await assert.rejects(f.service.synchronize(contactId));
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 assert.deepEqual(await memory.dueHistoryContacts(),[]);assert.equal(port.calls,0);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('2')],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 assert.deepEqual(await memory.dueHistoryContacts(),[contactId]);
 const run=await memory.startHistoryBatch(contactId,randomUUID());assert.equal(run.total,2);await memory.waitForIdle(run.runId);
 assert.equal((await memory.read(run.runId)).succeeded,2);
});

test('领取来源失证且续证无效时记录失败，不留下无执行者的运行轮次',async t=>{
 const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 const execute=f.storage.execute.bind(f.storage);let renewals=0;
 f.storage.execute=async(name,...args)=>{if(name==='memoryExtraction.claim')throw new StorageFailure('history_source_not_available');return execute(name,...args);};
 let memory;memory=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>memory.accounting),undefined,undefined,async()=>{renewals++;});
 t.after(async()=>{await memory.close();f.storage.execute=execute;});
 const run=await memory.startHistoryBatch(contactId,randomUUID());await memory.waitForIdle(run.runId);
 const result=await memory.read(run.runId);assert.equal(result.state,'failed');assert.equal(result.tasks.find(t=>t.scopeKind==='contact').errorCode,'history_source_not_available');assert.equal(renewals,1);
});

test('模型已返回时提交续证沿用同一结果，不重复调用模型',async t=>{
 const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 const execute=f.storage.execute.bind(f.storage);let renewals=0,first=true;
 f.storage.execute=async(name,...args)=>{if(name==='memoryExtraction.finish'&&first){first=false;throw new StorageFailure('history_source_not_available');}return execute(name,...args);};
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port,undefined,undefined,async()=>{renewals++;});
 t.after(async()=>{await memory.close();f.storage.execute=execute;});
 const run=await memory.startHistoryBatch(contactId,randomUUID());await memory.waitForIdle(run.runId);
 assert.equal((await memory.read(run.runId)).succeeded,1);assert.equal(renewals,1);assert.equal(port.calls,1);
});

test('启用前旧增量归历史补齐，启用后新文字仍归增量',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-sqlite/backlog-registry.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId);
 const append=async(n)=>f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:`tail-${n}`,cursorOut:`tail-${n+1}`,caughtUp:true,records:[record(String(n+1))]},at:Date.now(),runtimeToken:f.storage.status.runtimeId});
 await append(1);await f.storage.execute('fixture.memoryBaseline',{});await append(2);
 let memory;memory=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>memory.accounting));t.after(()=>memory.close());
 assert.equal((await memory.readContact(contactId)).queue.history.pending,2);assert.equal((await memory.readSchedule()).pending,1);
 const run=await memory.startHistoryBatch(contactId,randomUUID());assert.equal(run.total,2);await memory.waitForIdle(run.runId);
 assert.equal((await memory.read(run.runId)).succeeded,2);assert.equal((await memory.readSchedule()).pending,1);
});

test('模型拒绝输出保留原调用和来源关联，不生成成功输出或记忆候选',async t=>{
 const {ExtractionModelError}=await import('../src/memory/extraction/model.ts');
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory;const blocks=[{type:'tool-call',name:'DirectMemoryExtractionOutput',arguments:'{"scenes":[SYNTHETIC_BROKEN'}];
 const base=modelPort(()=>memory.accounting,async()=>({blocks}));
 const port={prepare:base.prepare,close:base.close,invoke:async(request,input)=>{const result=await base.invoke(request,input);throw new ExtractionModelError('extraction_model_validation_failed',null,null,result.blocks);}};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const run=await memory.startHistoryBatch(contactId,randomUUID());await memory.waitForIdle(run.runId);
 const view=await memory.read(run.runId);assert.equal(view.state,'failed');assert.equal(view.candidates.length,0);
 const trace=await memory.trace(view.tasks.find(t=>t.scopeKind==='contact').taskId),rejected=trace.events.find(e=>e.kind==='model_output_rejected');
 assert.ok(rejected);assert.deepEqual(rejected.payload.blocks,blocks);assert.equal(rejected.payload.truncated,false);assert.ok(rejected.callId);assert.equal(rejected.sources.length,1);
 assert.equal(rejected.sources[0].contactId,contactId);assert.equal(trace.events.some(e=>e.kind==='model_output'),false);
});
