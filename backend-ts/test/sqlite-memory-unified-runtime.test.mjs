import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {createSqliteMemoryRuntime} from '../src/memory/sqlite/runtime.ts';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

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
