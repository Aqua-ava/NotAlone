import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

test('首个积压联系人续证失败时仍能恢复后续联系人',async t=>{
 const f=await fixture(t),[first,second]=f.saved.map(s=>s.contact_id);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(first);await f.service.synchronize(second);
 let memory;const port=modelPort(()=>memory.accounting);port.prepare=async()=>{throw Object.assign(Error('synthetic-known-failure'),{code:'extraction_model_bad_request'});};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 for(const contact of [first,second]){const run=await memory.startHistoryBatch(contact,randomUUID());await memory.waitForIdle(run.runId);}
 assert.equal((await f.storage.execute('memoryExtraction.recoverableBacklog',{ownerId:owner})).length,2);
 await memory.close();
 const healthy=modelPort(()=>memory.accounting),renewals=[];
 memory=new SqliteMemoryExtraction(f.storage,owner,healthy,undefined,undefined,async contact=>{renewals.push(contact);if(contact===first)throw Error('synthetic-unavailable-first-source');});
 await memory.recoverBacklog();await memory.recoverBacklog();
 assert.ok(renewals.includes(second),'首个来源错误不能无限占据恢复队列队首');
 assert.equal((await memory.readContact(second)).run.succeeded,1);
});

test('退出前尚未发送模型的历史批在重新打开后可自动继续',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let memory,entered;const prepared=new Promise(resolve=>{entered=resolve});
 const waiting=modelPort(()=>memory.accounting);waiting.prepare=async(_request,input)=>{entered();await new Promise((resolve,reject)=>{if(input.signal.aborted)reject(input.signal.reason);else input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});};
 memory=new SqliteMemoryExtraction(f.storage,owner,waiting);t.after(()=>memory.close());
 const run=await memory.startHistoryBatch(contactId,randomUUID());await prepared;await memory.close();
 const healthy=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,healthy);await memory.initialize();
 const before=await memory.read(run.runId);assert.notEqual(before.calls.unknown,1,'退出发生在请求发送之前');
 assert.equal(await memory.recoverBacklog(),1,JSON.stringify({expect:'仅App退出中断的已知未发送批应自动恢复',state:before.state,reason:before.statusReason,tasks:before.tasks.map(t=>({state:t.state,errorCode:t.errorCode})),calls:before.calls}));
 await memory.waitForIdle();assert.equal((await memory.read(run.runId)).succeeded,1);
});

function waitForAbort(signal){return new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}

test('多次应用退出可持续续跑，安全中断不等于已知失败重试',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);let memory,run;
 t.after(()=>memory.close());
 for(let index=0;index<3;index++){
  let entered;const preparing=new Promise(resolve=>{entered=resolve}),port=modelPort(()=>memory.accounting);
  port.prepare=async(_request,input)=>{entered();await waitForAbort(input.signal);};
  memory=new SqliteMemoryExtraction(f.storage,owner,port);await memory.initialize();
  let recovering;
  if(index===0)run=await memory.startHistoryBatch(contactId,randomUUID());else recovering=memory.recoverBacklog();
  await preparing;await memory.close();if(recovering)assert.equal(await recovering,1);
 }
 const healthy=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,healthy);await memory.initialize();
 assert.equal(await memory.recoverBacklog(),1);assert.equal((await memory.read(run.runId)).succeeded,1);assert.equal(healthy.calls,1);
});

test('明确用户暂停后的退出不进入中断自动恢复',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);let memory,entered;
 t.after(()=>memory.close());const preparing=new Promise(resolve=>{entered=resolve}),port=modelPort(()=>memory.accounting);
 port.prepare=async(_request,input)=>{entered();await waitForAbort(input.signal);};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);const run=await memory.startHistoryBatch(contactId,randomUUID());await preparing;
 await memory.pause(run.runId);await memory.close();
 memory=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>memory.accounting));await memory.initialize();
 assert.equal((await memory.read(run.runId)).state,'paused');assert.equal(await memory.recoverBacklog(),0);
});

test('退出时已发送但没有回执的调用保持未知，不自动重发',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);let memory,entered;
 t.after(()=>memory.close());const sending=new Promise(resolve=>{entered=resolve});
 const port=modelPort(()=>memory.accounting,async(_request,input)=>{entered();await waitForAbort(input.signal);});
 memory=new SqliteMemoryExtraction(f.storage,owner,port);const run=await memory.startHistoryBatch(contactId,randomUUID());await sending;await memory.close();
 const healthy=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(f.storage,owner,healthy);await memory.initialize();
 assert.ok((await memory.read(run.runId)).unknown>0);assert.equal(await memory.recoverBacklog(),0);assert.equal(healthy.calls,0);
});
