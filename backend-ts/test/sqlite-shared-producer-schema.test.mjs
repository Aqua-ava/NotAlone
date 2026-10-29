import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
async function seeded(t){
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-sqlite/shared-producer-registry.mjs',import.meta.url).href});
 const contacts=[];for(const c of f.saved){await f.service.synchronize(c.contact_id);const message=(await f.service.read(c.contact_id)).messages.find(m=>m.kind==='text');contacts.push({contactId:c.contact_id,messageId:message.id,recordId:message.sourceRecordIds[0]});}
 return {...f,...await f.storage.execute('fixture.sharedSeed',{owner,contacts})};
}
test('同一真实Worker组合记忆与讨论producer、实际输入、来源及助手正文合同',async t=>{
 const f=await seeded(t);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.equal(await f.storage.execute('fixture.sharedViolation',{owner,a:f.a,b:f.b,m:f.m,kind:'seal_detach'}),true);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('共享调用拒绝跨请求和上下文、混合producer、越界输入及伪造助手正文',async t=>{
 const f=await seeded(t);
 for(const kind of ['operation_parent','reply_call_request','reply_call_context','event_call_attempt','event_mixed_producer','input_context','input_mixed','input_memory_reply','event_source','assistant_body','call_detach','event_move','foreign_owner_call']){
  await assert.rejects(f.storage.execute('fixture.sharedViolation',{owner,a:f.a,b:f.b,m:f.m,kind}),undefined,kind);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'},kind);
 }
});

test('成功执行指针拒绝缺失、非成功与跨owner执行，并允许05先清指针再删除',async t=>{
 const f=await seeded(t);
 for(const kind of ['running_attempt','missing_attempt','different_step_attempt','foreign_owner_attempt','insert_different_step_attempt','insert_foreign_owner_attempt','insert_missing_attempt','attempt_regression','attempt_delete']){
  await assert.rejects(f.storage.execute('fixture.sharedCompletion',{owner,m:f.m,kind}),undefined,kind);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'},kind);
 }
 assert.equal(await f.storage.execute('fixture.sharedCompletion',{owner,m:f.m,kind:'fenced_clear'}),true);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新执行复用同operation已知回执，事件直接保留真实call且不新增发送',async t=>{
 const f=await seeded(t);
 const reused=await f.storage.execute('fixture.sharedReuse',{owner,a:f.a,b:f.b,m:f.m,kind:'valid'});
 assert.equal(reused.before,3n);assert.equal(reused.after,3n);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('复用事件拒绝跨owner、别operation及未知回执，更新也不能换旧证明',async t=>{
 const f=await seeded(t);
 for(const kind of ['foreign_owner','other_operation','other_step','other_request','unknown','sealed','missing','both_calls','update_unknown','update_other_operation','update_missing']){
  await assert.rejects(f.storage.execute('fixture.sharedReuse',{owner,a:f.a,b:f.b,m:f.m,kind}),undefined,kind);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'},kind);
 }
});
