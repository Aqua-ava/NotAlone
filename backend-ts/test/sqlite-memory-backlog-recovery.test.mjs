import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const registryModule=new URL('./fixtures/memory-sqlite/backlog-registry.mjs',import.meta.url).href;
async function failed(t,unknown=false){
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);let memory,preparations=0;
 const port=modelPort(()=>memory.accounting,async()=>{throw Error('synthetic unknown response');});
 if(!unknown)port.prepare=async()=>{preparations++;throw Object.assign(Error('synthetic known failure'),{code:'extraction_model_bad_request'});};
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 const run=await memory.start('known-failure-backlog');await memory.waitForIdle(run.runId);
 return {...f,memory,run,get preparations(){return preparations;}};
}

test('已知L1失败只领取一次自动恢复，resume_no持久阻止再次领取',async t=>{
 const f=await failed(t),runs=await f.storage.execute('memoryExtraction.recoverableBacklog',{ownerId:owner});
 assert.deepEqual(runs,[{runId:f.run.runId,controlVersion:0}]);
 const claimed=await f.storage.execute('memoryExtraction.autoContinue',{ownerId:owner,...runs[0]});assert.equal(claimed.runId,f.run.runId);
 assert.deepEqual(await f.storage.execute('memoryExtraction.recoverableBacklog',{ownerId:owner}),[]);
 assert.equal(await f.storage.execute('memoryExtraction.autoContinue',{ownerId:owner,...runs[0]}),null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('扫描后发生暂停时自动恢复原子复验拒绝领取，保留旧暂停',async t=>{
 const f=await failed(t),[run]=await f.storage.execute('memoryExtraction.recoverableBacklog',{ownerId:owner});assert.ok(run);
 await f.storage.execute('fixture.backlogPause',{ownerId:owner,runId:f.run.runId});
 assert.equal(await f.storage.execute('memoryExtraction.autoContinue',{ownerId:owner,...run}),null);
 assert.equal((await f.memory.read(f.run.runId)).state,'paused');
 assert.deepEqual(await f.storage.execute('memoryExtraction.recoverableBacklog',{ownerId:owner}),[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实未知调用不进入积压自动恢复，也不消耗新的模型调用',async t=>{
 const f=await failed(t,true);assert.ok((await f.memory.read(f.run.runId)).unknown>0);
 assert.deepEqual(await f.storage.execute('memoryExtraction.recoverableBacklog',{ownerId:owner}),[]);
 assert.equal(await f.storage.execute('memoryExtraction.autoContinue',{ownerId:owner,runId:f.run.runId,controlVersion:0}),null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const stalePolicy of [false,true])test(`服务恢复${stalePolicy?'旧源码策略后继':'当前策略原轮'}失败后，重开数据库也不会重置自动次数`,async t=>{
 const f=await failed(t);assert.equal(f.preparations,1);
 if(stalePolicy)await f.storage.execute('fixture.backlogStalePolicy',{ownerId:owner,runId:f.run.runId});
 assert.equal(await f.memory.recoverBacklog(),1);
 const current=await f.memory.read();
 assert.equal(current.state,'failed');assert.equal(f.preparations,2,'已知失败只允许一次自动尝试');
 if(stalePolicy)assert.notEqual(current.runId,f.run.runId,'旧策略必须使用正常恢复后继，不修改原固定输入');
 else assert.equal(current.runId,f.run.runId,'当前策略沿用原轮次和固定输入');
 assert.equal(await f.memory.recoverBacklog(),0);assert.equal(f.preparations,2);
 const databaseId=f.storage.status.databaseId;await f.memory.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule});
 let restored,called=0;const port=modelPort(()=>restored.accounting);port.prepare=async()=>{called++;throw Error('不能再次自动重试');};
 restored=new SqliteMemoryExtraction(storage,owner,port);t.after(async()=>{await restored.close();await storage.close();});
 assert.equal(await restored.recoverBacklog(),0);assert.equal(called,0);
 assert.equal((await restored.read()).runId,current.runId);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
