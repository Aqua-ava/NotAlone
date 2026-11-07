import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,restart} from './sqlite-clear-support.mjs';
import {recoveryReader} from './fixtures/history/recertify-reader.mjs';

test('来源事实并表后正常同步、原地恢复及重启均保持同一绑定和消息',async t=>{
 const reader=recoveryReader();const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/source-proof-integration-registry.mjs',import.meta.url).href});
 const snapshot=()=>f.current.storage.execute('fixture.sourceProofSnapshot',{ownerId:owner,contactId:f.contactA});
 await f.current.history.synchronize(f.contactA);const original=await snapshot();assert.equal(original.proofs[0].state,'ok');assert.equal(original.retiredTables.length,0);
 const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});assert.equal((await snapshot()).proofs[0].state,'needs_confirmation');
 reader.state.pageRecords.push(record('shard-a','2'));reader.state.readIds=[];f.channel=reader.create();await restart(f,t);await f.current.history.synchronize(f.contactA);
 const after=await snapshot();assert.equal(after.proofs[0].state,'ok');assert.equal(after.proofs.length,1);assert.equal(after.retiredTables.length,0);assert.equal(after.bindings.length,1);assert.equal(after.bindings[0].id,original.bindings[0].id);assert.equal(after.messages.length,2);assert.deepEqual(reader.state.readIds,['2']);
 assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});



test('整联系人删除同时清除来源事实和进程内守卫，不留下联系人定位',async t=>{
 const reader=recoveryReader();const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/source-proof-integration-registry.mjs',import.meta.url).href});await f.current.history.synchronize(f.contactA);
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'delete-source-proof-contact',scope:{kind:'contact',contactId:f.contactA}});assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 const state=await f.current.storage.execute('fixture.sourceProofSnapshot',{ownerId:owner,contactId:f.contactA});assert.deepEqual(state.proofs,[]);assert.equal(state.guard,null);assert.deepEqual(state.messages,[]);
});

test('普通守卫释放只改变易失状态，不能单凭旧渠道模式新增待确认',async t=>{
 const reader=recoveryReader();reader.state.reportOverride={continuity:'synthetic-generation-1'};
 const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/source-proof-integration-registry.mjs',import.meta.url).href});await f.current.history.synchronize(f.contactA);await f.current.history.stop(f.contactA);
 const state=await f.current.storage.execute('fixture.sourceProofSnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(state.proofs[0].state,'ok');assert.equal(state.messages.length,1);
});
