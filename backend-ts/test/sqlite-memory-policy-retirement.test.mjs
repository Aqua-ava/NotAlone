import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

test('存量旧策略轮次继续执行明确拒绝，不改配置、不产生新模型调用',async t=>{
 const f=await fixture(t);await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 let calls=0;
 const memory=new SqliteMemoryExtraction(f.storage,owner,{prepare:async()=>{calls++;throw new Error('旧策略不能预约模型');},invoke:async()=>{calls++;throw new Error('旧策略不能调用模型');}});
 t.after(()=>memory.close());await memory.initialize();
 for(const [index,config] of [null,{version:1,mode:'legacy',rule_set_sha256:null},
  {version:1,mode:'bounded-runtime-v1',rule_set_sha256:'a'.repeat(64)}].entries()){
  const run=await f.storage.execute('memoryExtraction.start',{ownerId:owner,requestKey:`retired-config-${index}`,policyConfig:config});
  const before=await memory.read(run.runId);
  await assert.rejects(memory.continue(run.runId,0,`continue-retired-${index}`),{code:'extraction_runtime_config_retired'});
  assert.deepEqual(await f.storage.execute('memoryExtraction.readPolicy',{ownerId:owner,runId:run.runId}),config);
  const after=await memory.read(run.runId);
  assert.equal(after.state,before.state);assert.deepEqual(after.tasks,before.tasks);
 }
 assert.equal(calls,0);
});
