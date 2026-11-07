import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {recoveryReader,normalCapabilities} from './fixtures/history/recertify-reader.mjs';

for(const checkedPartitions of [undefined,['shard-a','shard-b'],['shard-a','shard-b','shard-c']])for(const durable of [false,true]){
 test(`原地恢复完成后干净重启，元数据重验接上水位且不新增绑定围栏（checked=${checkedPartitions?.length??0},durable=${durable}）`,{timeout:10000},async t=>{
  const reader=recoveryReader();reader.state.targetOverride={checkedPartitions};reader.state.reportOverride={capabilities:{...normalCapabilities,durableIncremental:durable?'supported':'unsupported',durableHistory:durable?'supported':'unsupported'}};
  const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recertify-restart-registry.mjs',import.meta.url).href});
  const snapshot=()=>f.current.storage.execute('fixture.recertifyRestartSnapshot',{ownerId:owner,contactId:f.contactA});
  await f.current.history.synchronize(f.contactA);const original=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token:original});
  const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,reader.create,f.current.holders,{stopHistory:id=>f.current.history.stop(id)});t.after(()=>service.close());
  const done=await service.recertify(f.contactA,{requestKey:'synthetic-restart'});assert.equal(done.state,'completed',JSON.stringify(done));await service.close();
  const repaired=await snapshot();assert.equal(repaired.fences.length,0);assert.equal(repaired.bindings.length,1);assert.equal(repaired.operations[0].new_binding_id,null);assert.equal(repaired.guards[0].state,'lost');assert.deepEqual(JSON.parse(repaired.scopes[0].tables_json).checkedPartitions,checkedPartitions);
  f.channel=reader.create();await restart(f,t);const restarted=await snapshot();assert.notEqual(restarted.runtime.runtime_id,repaired.runtime.runtime_id);assert.equal(restarted.fences.length,0);assert.deepEqual(restarted.guards,[],'Worker重启不恢复任何易失守卫');assert.equal(restarted.proofs.length,1);assert.equal(restarted.proofs[0].state,'ok');assert.deepEqual(restarted.legacyTables,[]);
  reader.state.pageRecords.push(record('shard-a','2'));reader.state.readIds=[];const inspectCalls=reader.state.inspectCalls;
  await f.current.history.synchronize(f.contactA);const after=await snapshot();assert.equal(after.fences.length,0);assert.equal(after.bindings.length,1);assert.equal(after.guards[0].runtime_id,after.runtime.runtime_id);assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,original.binding_id);
  assert.ok(reader.state.inspectCalls>inspectCalls);assert.deepEqual(reader.state.readIds,['2']);assert.equal((await f.current.history.readChat(f.contactA)).messages.length,2);assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
}
