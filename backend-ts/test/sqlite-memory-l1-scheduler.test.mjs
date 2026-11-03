import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryL1Scheduler} from '../src/memory/sqlite/scheduler.ts';

async function incrementalFixture(t,{at,records=[record('2')]}={}){
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),capturedAt=at??Date.now();
 assert.ok(coverage.incremental.goalId,JSON.stringify(coverage.incremental));
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),
  page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records},at:capturedAt,runtimeToken:f.storage.status.runtimeId});
 const memory=new SqliteMemoryExtraction(f.storage,owner,{prepare:async()=>{throw new Error('not invoked');},invoke:async()=>{throw new Error('not invoked');}});
 t.after(()=>memory.close());return {f,contactId,memory,at:capturedAt};
}
async function appendIncrementalPage(f,contactId,{records,at=Date.now()}={}){
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),pageNo=coverage.incremental.pagesAccepted;
 const cursorIn=`tail-${pageNo+1}`,cursorOut=`tail-${pageNo+2}`;
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),
  page:{target:f.target.descriptor,cursorIn,cursorOut,caughtUp:true,records},at,runtimeToken:f.storage.status.runtimeId});
 return at;
}

test('显式初始化只处理历史，新增增量保留独立调度',async t=>{
 const {f,contactId,memory:readOnly}=await incrementalFixture(t);await readOnly.close();
 let memory;const port=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const view=await memory.startHistory(contactId,randomUUID());assert.equal(view.run.total,1);await memory.waitForIdle(view.run.runId);
 assert.equal((await memory.readContact(contactId)).run.succeeded,1);assert.equal((await memory.readSchedule()).pending,1);assert.equal(port.calls,1);
});

test('只对首次增量来源计数；静默十分钟后进入联系人自己的待处理队列',async t=>{
 const {f,contactId,memory,at}=await incrementalFixture(t);
 const schedule=await memory.readSchedule(at+9*60_000);assert.equal(schedule.pending,1);
 const own=await memory.readContact(contactId),other=await memory.readContact(f.saved[1].contact_id);
 assert.equal(own.queue.pending,1);assert.equal(other.queue.pending,0);
 assert.deepEqual(await memory.dueContacts(at+9*60_000),[]);
 assert.equal(await memory.nextDueAt(at+9*60_000),at+10*60_000);
 assert.deepEqual(await memory.dueContacts(at+10*60_000),[contactId]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('增量页重见首次历史消息时仍不作为新的增量目标',async t=>{
 const {f,contactId,memory,at}=await incrementalFixture(t,{records:[record('1')]});
 // 历史内容仍在内容摘要中，不能因此成为新的增量目标。
 assert.deepEqual(await memory.readSchedule(at+7*60*60_000),{pending:0,nextDueAt:null,blockedContacts:0,content:[{kind:'text',pending:1,unavailable:0}]});
 assert.deepEqual(await memory.dueContacts(at+7*60*60_000),[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('五十条增量目标可立即触发；最旧目标满六小时也能触发',async t=>{
 const at=Date.now(),volume=await incrementalFixture(t,{at,records:Array.from({length:50},(_,index)=>record(String(index+10)))});
 assert.deepEqual(await volume.memory.dueContacts(at),[volume.contactId]);

 const current=Date.now(),aged=await incrementalFixture(t,{at:current-6*60*60_000});
 await appendIncrementalPage(aged.f,aged.contactId,{records:[record('3')],at:current});
 assert.deepEqual(await aged.memory.dueContacts(current),[aged.contactId]);
});

test('后续成功的L1提取解除旧失败门，但联系人冷却仍生效',async t=>{
 const {f,contactId,memory:unused}=await incrementalFixture(t);await unused.close();
 let memory,first=true;const port=modelPort(()=>memory.accounting),prepare=port.prepare;
 port.prepare=async(...args)=>{if(first){first=false;throw Object.assign(new Error('synthetic-known-failure'),{code:'extraction_model_bad_request'});}return prepare(...args);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const failed=await memory.start('first-known-failure');await memory.waitForIdle(failed.runId);assert.equal((await memory.read(failed.runId)).state,'failed');
 const recovered=await memory.start('later-success');await memory.waitForIdle(recovered.runId);assert.equal((await memory.read(recovered.runId)).succeeded,2);
 const acceptedAt=Date.now()-7*60*60_000;await appendIncrementalPage(f,contactId,{records:[record('3')],at:acceptedAt});
 assert.equal((await memory.readSchedule(Date.now())).pending,1);
 assert.deepEqual(await memory.dueContacts(Date.now()+30*60_000),[contactId]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('启动立即扫描并只保留一个最早到期计时器；关闭后不再建轮',async()=>{
 let now=1_000,dueAt=1_100,nextTimer=0,startedResolve,scanResolve;
 const started=new Promise(resolve=>{startedResolve=resolve}),scanDone=new Promise(resolve=>{scanResolve=resolve}),timers=new Map(),runs=[];
 const scheduler=new SqliteMemoryL1Scheduler({
  nextDueAt:async()=>{if(runs.length){scanResolve();return null;}return dueAt;},
  dueContacts:async current=>current>=dueAt?['contact-a']:[],
  startContact:async(contactId,requestKey,current)=>{runs.push({contactId,requestKey,current});dueAt=null;startedResolve();return {runId:'run-a'};},
 },{now:()=>now,setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id)});
 await scheduler.start();assert.equal(timers.size,1);assert.equal([...timers.values()][0].delay,100);
 now=1_100;const [timerId,timer]=[...timers.entries()][0];timers.delete(timerId);timer.callback();await started;await scanDone;
 assert.equal(runs.length,1);assert.equal(runs[0].contactId,'contact-a');assert.equal(timers.size,0);
 await scheduler.close();
});

test('L1结算后关闭会留下可恢复的后续登记，不重跑L1',async t=>{
 const {f,contactId}=await incrementalFixture(t),base=modelPort(()=>memory.accounting);let memory,callbacks=0,closing;
 memory=new SqliteMemoryExtraction(f.storage,owner,base,new (await import('../src/storage/sqlite/deletion/holders.ts')).ActiveHolders(),async()=>{callbacks++;});
 const execute=f.storage.execute.bind(f.storage);let intercepted=false;
 f.storage.execute=async(action,...args)=>{
  const result=await execute(action,...args);
  if(action==='memoryExtraction.settleRun'&&!intercepted){intercepted=true;closing=memory.close();}
  return result;
 };
 const first=await memory.start('settle-close-race');await memory.waitForIdle(first.runId);await closing;
 f.storage.execute=execute;
 assert.equal(callbacks,0,'关闭发生在L1结算与后续回调之间');assert.equal(base.calls,1);
 const persisted=await execute('memoryExtraction.pendingFollowups',{ownerId:owner});assert.deepEqual(persisted,[first.runId]);
 let resumed=0;const recovered=new SqliteMemoryExtraction(f.storage,owner,base,undefined,async runId=>{assert.equal(runId,first.runId);resumed++;await f.storage.execute('memoryDocuments.enrollRun',{ownerId:owner,runId});});
 t.after(()=>recovered.close());assert.equal(await recovered.resumeFollowups(),1);await recovered.waitForIdle(first.runId);
 assert.equal(resumed,1);assert.equal(base.calls,1,'恢复只执行后续回调，不重新调用提取模型');
 assert.equal((await recovered.read(first.runId)).state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('未知回执和用户暂停不会进入后续自动恢复',async t=>{
 const unknownFixture=await incrementalFixture(t);await unknownFixture.memory.close();let unknownFollowups=0;
 let unknownMemory;const unknownPort=modelPort(()=>unknownMemory.accounting,async()=>{throw new Error('synthetic unknown result');});
 unknownMemory=new SqliteMemoryExtraction(unknownFixture.f.storage,owner,unknownPort,undefined,async()=>{unknownFollowups++;});t.after(()=>unknownMemory.close());
 const unknownRun=await unknownMemory.start('followup-unknown');await unknownMemory.waitForIdle(unknownRun.runId);
 const initialUnknownFollowups=unknownFollowups;
 assert.equal((await unknownMemory.read(unknownRun.runId)).unknown,2);assert.equal(await unknownMemory.resumeFollowups(),0);assert.equal(unknownFollowups,initialUnknownFollowups,'恢复操作不再调用后续hook');
 await unknownMemory.close();let recoveredUnknownFollowups=0;
 const unknownRecovered=new SqliteMemoryExtraction(unknownFixture.f.storage,owner,unknownPort,undefined,async()=>{recoveredUnknownFollowups++;});t.after(()=>unknownRecovered.close());
 assert.equal(await unknownRecovered.resumeFollowups(),0);assert.equal(unknownPort.calls,1);assert.equal(recoveredUnknownFollowups,0);

 const pausedFixture=await incrementalFixture(t);await pausedFixture.memory.close();let enteredResolve,releaseResolve,pausedFollowups=0;
 const entered=new Promise(resolve=>enteredResolve=resolve),waiting=new Promise(resolve=>releaseResolve=resolve);
 let pausedMemory;const pausedPort=modelPort(()=>pausedMemory.accounting);const invoke=pausedPort.invoke;
 pausedPort.invoke=async(...args)=>{const result=await invoke(...args);if(pausedPort.calls===1){enteredResolve();await waiting;}return result;};
 pausedMemory=new SqliteMemoryExtraction(pausedFixture.f.storage,owner,pausedPort,undefined,async()=>{pausedFollowups++;});t.after(()=>pausedMemory.close());
 const pausedRun=await pausedMemory.start('followup-paused');await entered;await pausedMemory.pause(pausedRun.runId);releaseResolve();await pausedMemory.waitForIdle(pausedRun.runId);
 const initialPausedFollowups=pausedFollowups;
 assert.equal((await pausedMemory.read(pausedRun.runId)).state,'paused');assert.equal(await pausedMemory.resumeFollowups(),0);assert.equal(pausedFollowups,initialPausedFollowups);
 await pausedMemory.close();const pausedRecovered=new SqliteMemoryExtraction(pausedFixture.f.storage,owner,pausedPort,undefined,async()=>{pausedFollowups++;});t.after(()=>pausedRecovered.close());
 assert.equal(await pausedRecovered.resumeFollowups(),0);assert.equal(pausedPort.calls,1);assert.equal(pausedFollowups,initialPausedFollowups);
 assert.deepEqual(await unknownFixture.f.storage.check(),{integrity:'ok',foreignKeys:'ok'});assert.deepEqual(await pausedFixture.f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
