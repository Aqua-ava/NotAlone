import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {profilePublicationFixture} from './fixtures/memory-documents/profile-publication-support.mjs';

/** 走正常阶段路径：画像阶段已保存，随后发布被合成故障中断。 */
async function savedFixture(t,count=2){
 const f=await profilePublicationFixture(t,{initialSceneCount:count});
 const stages=(await f.documents.readTask(f.taskId)).stages;
 assert.equal(stages.find(s=>s.kind==='profile').status,'succeeded');
 return f;
}
const args=(f,stage)=>({ownerId:f.owner,taskId:f.taskId,runId:f.runId,stage});

test('发布与结清共享基础记忆的来源核验不随文档数重复，完整发布所有文档',{timeout:20000},async t=>{
 const results=[];
 for(const count of [2,8]){
  const f=await savedFixture(t,count),calls=f.modelCalls.length,published=await f.storage.execute('fixture.profilePublicationMetrics',args(f,'publish'));
  assert.equal(published.result.outcome,'completed');const current=await f.documents.read({scopeKind:'contact',contactId:f.a});
  assert.equal(current.documents.filter(d=>d.kind==='scene').length,count);assert.equal(current.documents.length,count+1,'共享核验不能截断发布集合');
  const settled=await f.storage.execute('fixture.profilePublicationMetrics',args(f,'settle'));assert.equal(settled.result,true);
  assert.equal(f.modelCalls.length,calls);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
  results.push({documents:count+1,publish:published.semanticSourceChecks,settle:settled.semanticSourceChecks,publishQueries:published.queries,settleQueries:settled.queries});
 }
 t.diagnostic(JSON.stringify(results));assert.ok(results[0].publish>0);assert.ok(results[0].settle>0);
 assert.equal(results[1].publish,results[0].publish,'相同L1只做一次完整语义来源核验');assert.equal(results[1].settle,results[0].settle);
});

test('发布与结清的读取缓存在首个写入之前销毁',{timeout:20000},async t=>{
 for(const stage of ['publish','settle'])await t.test(stage,async t=>{
  const f=await savedFixture(t);if(stage==='settle')await f.storage.execute('fixture.profilePublicationMetrics',args(f,'publish'));
  const calls=f.modelCalls.length;await assert.rejects(f.storage.execute('fixture.profilePublicationMemoBoundary',args(f,stage)),{code:'fixture_memo_boundary_safe'});
  assert.equal(f.modelCalls.length,calls);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
  const recovered=await f.storage.execute('fixture.profilePublicationMetrics',args(f,stage));assert.equal(stage==='publish'?recovered.result.outcome:recovered.result,stage==='publish'?'completed':true,'注入事务整体回滚，未残留来源修订或发布写入');
 });
});

test('成功发布后的下一动作重新检查撤权和清除，不沿用来源缓存',{timeout:20000},async t=>{
 for(const kind of ['revoke','delete'])await t.test(kind,async t=>{
  const f=await savedFixture(t),scope={scopeKind:'contact',contactId:f.a};await f.storage.execute('fixture.profilePublicationMetrics',args(f,'publish'));await f.storage.execute('fixture.profilePublicationMetrics',args(f,'settle'));
  const calls=f.modelCalls.length;
  if(kind==='revoke'){const binding=f.saved.find(b=>b.contact_id===f.a);await f.contacts.revoke(f.a,binding.binding_id,binding.selection_generation);await assert.rejects(f.storage.execute('fixture.profilePublicationMetrics',args(f,'settle')));}
  else {const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.a}});assert.equal((await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId})).state,'completed');await assert.rejects(f.storage.execute('fixture.profilePublicationMetrics',args(f,'settle')),{code:'memory_scope_stale'});}
  await assert.rejects(f.storage.execute('fixture.profilePublicationMetrics',args(f,'publish')));assert.equal(f.modelCalls.length,calls);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});
