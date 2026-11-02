import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

const deferred=()=>Promise.withResolvers();

test('大历史轮每二十条让出执行权，新增量和裁决共用串行执行队列',async t=>{
 const f=await fixture(t),[a,b]=f.saved.map(row=>row.contact_id);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:Array.from({length:61},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(a);await f.service.synchronize(b);
 const coverage=await f.service.coverage(b),token=await f.contacts.eligibility(b),now=Date.now();
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),
  page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:Array.from({length:50},(_,i)=>record(String(i+100)))},at:now,runtimeToken:f.storage.status.runtimeId});
 const entered=deferred(),release=deferred(),events=[];let active=0,maxActive=0,first=true,memory;
 const port=modelPort(()=>memory.accounting,async(request,input)=>{
  active++;maxActive=Math.max(maxActive,active);events.push(input.scope.contact_id===a?'history':'incremental');
  try{if(first){first=false;entered.resolve();await release.promise;}return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};}
  finally{active--;}
 });
 const followup=async runId=>{active++;maxActive=Math.max(maxActive,active);events.push(`followup:${runId}`);try{await new Promise(resolve=>setImmediate(resolve));}finally{active--;}};
 memory=new SqliteMemoryExtraction(f.storage,owner,port,undefined,followup);t.after(async()=>{release.resolve();await memory.close();});
 const history=await memory.startHistory(a,randomUUID());await entered.promise;
 const incremental=await memory.startContact(b,randomUUID(),now);assert.ok(incremental);
 await memory.read(incremental.runId);await memory.read(incremental.runId);
 const waiting=await memory.read(incremental.runId);
 assert.equal(waiting.tasks.find(task=>task.scopeKind==='contact').state,'pending','历史首批未结算时增量不可并发领取');
 release.resolve();
 await memory.waitForIdle();
 assert.equal(maxActive,1,'模型步骤和后续裁决不能并发争抢本人版本');
 assert.ok(events.indexOf('incremental')<events.indexOf('history',1),'新增量须在历史第二批之前取得执行权');
 assert.equal((await memory.read(history.run.runId)).succeeded,61);
 assert.equal((await memory.read(incremental.runId)).succeeded,50);
 assert.equal(events.filter(event=>event.startsWith('followup:')).length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('自动恢复可只登记原轮续跑，不等整轮结束才允许增量调度启动',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 const entered=deferred(),release=deferred();let memory,first=true;
 const port=modelPort(()=>memory.accounting,async request=>{entered.resolve();await release.promise;return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});
 const prepare=port.prepare;port.prepare=async(...args)=>{if(first){first=false;throw Object.assign(Error('合成已知失败'),{code:'extraction_model_bad_request'});}return prepare(...args);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{release.resolve();await memory.close();});
 const original=await memory.start('fair-recovery-original');await memory.waitForIdle(original.runId);
 assert.equal((await memory.read(original.runId)).state,'failed');
 const result=await Promise.race([memory.recoverBacklog({wait:false}).then(count=>({kind:'registered',count})),entered.promise.then(()=>({kind:'model-started'}))]);
 assert.deepEqual(result,{kind:'registered',count:1},'登记恢复应在恢复轮模型完成前返回');
 await entered.promise;release.resolve();await memory.waitForIdle(original.runId);
 const done=await memory.read(original.runId);assert.equal(done.succeeded,1);assert.equal(done.runId,original.runId);
 assert.equal(port.calls,1,'沿用原轮与既有预算，已知未发送失败只做一次正常调用');
});

test('同联系人历史步骤之间允许到期新增量建轮，历史固定目标不重复处理',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:Array.from({length:61},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 const between=deferred(),release=deferred(),execute=f.storage.execute.bind(f.storage);let claims=0,memory;
 f.storage.execute=async(name,...args)=>{if(name==='memoryExtraction.claim'&&++claims===2){between.resolve();await release.promise;}return execute(name,...args);};
 const events=[],port=modelPort(()=>memory.accounting,async request=>{events.push(request.user);return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{release.resolve();await memory.close();f.storage.execute=execute;});
 const history=await memory.startHistory(contactId,randomUUID());await between.promise;
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),now=Date.now();
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:Array.from({length:50},(_,i)=>record(String(i+100)))},at:now,runtimeToken:f.storage.status.runtimeId});
 const incremental=await memory.startContact(contactId,randomUUID(),now);assert.ok(incremental,'未完历史的纯进度不能挡住同联系人到期增量');
 assert.equal(incremental.total,50);assert.deepEqual(await memory.dueHistoryContacts(now),[],'历史仍不可重复建轮');
 release.resolve();await memory.waitForIdle();
 assert.equal((await memory.read(history.run.runId)).total,61);assert.equal((await memory.read(history.run.runId)).succeeded,61);
 assert.equal((await memory.read(incremental.runId)).succeeded,50);assert.equal(port.calls,7,'历史四步与增量三步各仅调用一次');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const boundary of ['unknown','paused','failed'])test(`历史${boundary}仍阻止同联系人新增量，不重放或绕过旧状态`,async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:Array.from({length:61},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 const between=deferred(),release=deferred(),execute=f.storage.execute.bind(f.storage);let claims=0,memory;
 if(boundary==='paused')f.storage.execute=async(name,...args)=>{if(name==='memoryExtraction.claim'&&++claims===2){between.resolve();await release.promise;}return execute(name,...args);};
 const port=modelPort(()=>memory.accounting,async request=>{if(boundary==='unknown')throw Error('合成未知响应');return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};});
 if(boundary==='failed')port.prepare=async()=>{throw Object.assign(Error('合成已知失败'),{code:'extraction_model_bad_request'});};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(async()=>{release.resolve();await memory.close();f.storage.execute=execute;});
 const history=await memory.startHistory(contactId,randomUUID());
 if(boundary==='paused'){await between.promise;const current=await memory.read(history.run.runId);await memory.pause(history.run.runId,current.controlVersion,randomUUID());}
 else await memory.waitForIdle(history.run.runId);
 const before=await memory.read(history.run.runId),calls=port.calls;
 if(boundary==='unknown')assert.equal(before.unknown,20);
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),now=Date.now();
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:Array.from({length:50},(_,i)=>record(String(i+100)))},at:now,runtimeToken:f.storage.status.runtimeId});
 assert.equal(await memory.startContact(contactId,randomUUID(),now),null);
 assert.equal(port.calls,calls);assert.equal((await memory.read(history.run.runId)).state,before.state);
 release.resolve();await memory.waitForIdle();assert.equal(port.calls,calls);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('历史每步结算自动检查同联系人增量，不依赖恰好命中短暂步骤空隙',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:Array.from({length:61},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contactId);
 const entered=deferred(),release=deferred(),events=[],started=[];let first=true,memory,active=0,maxActive=0;
 const port=modelPort(()=>memory.accounting,async(request,input)=>{active++;maxActive=Math.max(maxActive,active);events.push(input.claim.task_id);try{if(first){first=false;entered.resolve();await release.promise;}return {blocks:[{type:'tool-call',name:request.tool.name,arguments:'{"scenes":[]}'}]};}finally{active--;}});
 const admitIncremental=async()=>{for(const id of await memory.dueContacts()){const run=await memory.startContact(id,randomUUID());if(run)started.push(run);}};
 memory=new SqliteMemoryExtraction(f.storage,owner,port,undefined,undefined,undefined,admitIncremental);
 t.after(async()=>{release.resolve();await memory.close();});
 const history=await memory.startHistory(contactId,randomUUID());await entered.promise;
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),now=Date.now();
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:Array.from({length:50},(_,i)=>record(String(i+100)))},at:now,runtimeToken:f.storage.status.runtimeId});
 assert.deepEqual(await memory.dueContacts(),[],'真实在途历史步骤不能被新轮绕过');
 release.resolve();await memory.waitForIdle(history.run.runId);await memory.waitForIdle();
 assert.equal(started.length,1,'历史结算后的正常回调必须自动完成增量准入');
 const historyTask=history.run.tasks.find(task=>task.scopeKind==='contact').taskId,incrementalTask=started[0].tasks.find(task=>task.scopeKind==='contact').taskId;
 assert.ok(events.indexOf(incrementalTask)<events.lastIndexOf(historyTask),'新增量必须在整批历史结束前执行');
 assert.equal((await memory.read(started[0].runId)).succeeded,50);assert.equal((await memory.read(history.run.runId)).succeeded,61);assert.equal(maxActive,1);assert.equal(port.calls,7);
});
