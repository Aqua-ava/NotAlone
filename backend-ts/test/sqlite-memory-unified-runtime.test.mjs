import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {createSqliteMemoryRuntime} from '../src/memory/sqlite/runtime.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {randomUUID} from 'node:crypto';

test('正式记忆运行时只使用统一摘要入口，单联系人唤醒不全局扫描',{timeout:10_000},async t=>{
 const f=await fixture(t),calls=[];let runtime,resolve;
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{
  calls.push({name,contactIds:input?.contactIds});
  const result=await execute(name,input,...rest);
  if(name==='memoryExtraction.scanSchedule')resolve?.();
  return result;
 };
 t.after(()=>runtime?.close());
 runtime=await createSqliteMemoryRuntime({ctx:{},contentRegistry:createBuiltinMemoryContentRegistry(),storage:f.storage,ownerId:owner,userData:f.root,businessHome:f.root,infoPath:join(f.root,'info'),envFilePath:join(f.root,'unused.env'),environment:{},holders:new ActiveHolders(),authorize:()=>false,adjudicationEnabled:true});
 const scanned=new Promise(done=>{resolve=done;});runtime.startScheduling();
 let timer;
 const result=await Promise.race([scanned.then(()=>true),new Promise(done=>{timer=setTimeout(()=>done(false),1_000);})]).finally(()=>clearTimeout(timer));
 assert.equal(result,true,'生产装配必须使用scanSchedule，而非四次全局统计');
 assert.equal(calls.some(call=>['memoryExtraction.dueContacts','memoryExtraction.dueHistoryContacts','memoryExtraction.nextDueAt','memoryExtraction.nextHistoryDueAt'].includes(call.name)),false);
 calls.length=0;
 const targeted=new Promise(done=>{resolve=done;});runtime.wake(f.saved[0].contact_id);await targeted;
 assert.deepEqual(calls.filter(call=>call.name==='memoryExtraction.scanSchedule').map(call=>call.contactIds),[[f.saved[0].contact_id]]);
 assert.equal(calls.some(call=>call.name==='memoryExtraction.scheduleContacts'),false);
 await runtime.close();
});

test('manual运行时单联系人收尾保留登记但不自动领取全owner后续队列，正式启动后仍可唤醒',{timeout:10_000},async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);
 let runtime,onClaim;
 const claims=[],enrolled=[],execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{
  if(name==='memoryDocuments.claimDue'){claims.push(input);onClaim?.();}
  const result=await execute(name,input,...rest);
  if(name==='memoryDocuments.enrollRun')enrolled.push(input.runId);
  return result;
 };
 t.after(()=>runtime?.close());
 runtime=await createSqliteMemoryRuntime({ctx:{},contentRegistry:createBuiltinMemoryContentRegistry(),storage:f.storage,ownerId:owner,
  userData:f.root,businessHome:f.root,infoPath:join(f.root,'info'),envFilePath:join(f.root,'unused.env'),environment:{},
  holders:new ActiveHolders(),authorize:()=>false,adjudicationEnabled:true});
 // 未配置外部模型，仍经正式单联系人任务的技术性收尾触发后续登记；不替换运行时或SQLite动作。
 const run=await runtime.service.startHistory(contactId,randomUUID());await runtime.service.waitForIdle(run.run.runId);
 assert.deepEqual(enrolled,[run.run.runId],'manual仍执行持久后续登记');
 assert.equal(claims.length,0,'未调用startScheduling的manual实例不领取任何owner后续工作');

 const observeClaim=async trigger=>{
  const observed=new Promise(resolve=>{onClaim=resolve;});let timer;
  trigger();
  try{assert.equal(await Promise.race([observed.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]),true,'正式调度应能唤醒后续Worker');}
  finally{clearTimeout(timer);onClaim=undefined;}
 };
 await observeClaim(()=>runtime.startScheduling());
 const startedClaims=claims.length;await observeClaim(()=>runtime.wake(contactId));
 assert.ok(claims.length>startedClaims);assert.ok(claims.every(input=>input.ownerId===owner));
 await runtime.close();
});
