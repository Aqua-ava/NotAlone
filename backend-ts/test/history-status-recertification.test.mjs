import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
async function setup(t){
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/status-recertification-registry.mjs',import.meta.url).href});
 const [a,b]=f.saved;await f.service.synchronize(a.contact_id);
 await f.storage.execute('fixture.statusFallback',{ownerId:owner,contactId:b.contact_id,bindingId:b.binding_id});
 const change=input=>f.storage.execute('fixture.statusRecertification',{ownerId:owner,contactId:a.contact_id,bindingId:a.binding_id,...input});
 const scopes=(contactId,saved)=>f.storage.execute('fixture.statusScopes',{ownerId:owner,contactId,saved});
 async function expect(allowed){
  for(const saved of [false,true]){
   assert.deepEqual((await scopes(undefined,saved)).map(r=>r.contact_id).sort(),allowed.map(x=>x.contact_id).sort());
   for(const binding of [a,b])assert.equal((await scopes(binding.contact_id,saved)).length,allowed.includes(binding)?1:0);
  }
 }
 return {...f,a,b,change,expect};
}
for(const state of ['running','failed','interrupted','completed'])test(`状态覆盖保留${state}认证资格，现代目标和连续性回退使用相同边界`,async t=>{
 const f=await setup(t);await f.expect([f.a,f.b]);
 await f.change({state});await f.expect(state==='completed'?[f.a,f.b]:[f.b]);
 const coverage=await f.service.coverage(f.a.contact_id);assert.equal(coverage.messageCount,state==='completed'?2:0);
 await f.change({state,contactId:f.b.contact_id,bindingId:f.b.binding_id});await f.expect(state==='completed'?[f.a,f.b]:[f.a]);
});
test('同本人跨联系人错误认证记录仍阻断其指向绑定，不能靠联系人过滤放行',async t=>{
 const f=await setup(t);await f.change({state:'failed',contactId:f.b.contact_id,bindingId:f.a.binding_id});await f.expect([f.b]);
 await f.change({state:'completed',contactId:f.b.contact_id,bindingId:f.a.binding_id});await f.expect([f.a,f.b]);
});
test('其他本人相同绑定字符串及空绑定不能污染当前覆盖',async t=>{
 const f=await setup(t);await f.change({state:'failed',ownerId:'00000000-0000-4000-8000-000000000101',contactId:'00000000-0000-4000-8000-000000000102',otherOwner:true});await f.expect([f.a,f.b]);
 await f.change({state:'interrupted',bindingId:null});await f.expect([f.a,f.b]);
});
