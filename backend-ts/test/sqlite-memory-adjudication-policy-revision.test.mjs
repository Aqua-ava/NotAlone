import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

test('旧策略已完成但技术不一致的候选通过单联系人完整收尾重核，同策略重复请求不重发',async t=>{
 const f=await adjudicationFixture(t);
 await f.extract(['我长期保留合成背景。'],{publish:true});
 f.setRespond(adjudicationSupplier({action:'add',kind:'supplement'}));
 const runId=await f.extract(['我长期偏好合成园艺。']);await f.adjudication.publishRun(runId,f.contactId);
 const before=await f.trace();assert.equal(before.calls.length,2);assert.ok(before.steps.every(step=>step.state==='succeeded'));
 assert.equal((await f.read()).candidates[0].pendingReason,'memory_relation_inconsistent');
 const scopes=[{scopeKind:'contact',contactId:f.saved[1].contact_id},{scopeKind:'self',contactId:null}],management=new SqliteMemoryManagement(f.storage,f.owner);
 const untouched=await Promise.all(scopes.map(scope=>management.read(scope)));
 const completions=[];
 const completion=new SqliteMemoryExtraction(f.storage,f.owner,{invoke:async()=>{throw new Error('策略变更收尾不得重提取');}},undefined,async(id,contactIds,options)=>{
  completions.push({contactIds,onlyContactId:options?.onlyContactId});
  await f.adjudication.publishRun(id,options?.onlyContactId,{retryKnownFailures:options?.retryKnownFailures});
 });t.after(()=>completion.close());
 f.setRespond(adjudicationSupplier());
 await completion.completeContact(f.contactId);await completion.waitForIdle(runId);
 assert.equal(f.calls.length,2,'冻结策略未变化时沿用已完成结果，不反复外发');
 await f.storage.execute('fixture.oldAdjudicationPolicy',{ownerId:f.owner,runId});
 await completion.completeContact(f.contactId);await completion.waitForIdle(runId);
 assert.equal(f.calls.length,4,'新策略下正常重新裁决及独立关系核验');
 assert.equal((await f.read()).candidates.length,0);assert.equal((await f.read()).memories.length,2);
 const after=await f.trace();assert.deepEqual(after.calls.slice(0,before.calls.length),before.calls,'策略变化不改写旧回执或成本');
 await completion.completeContact(f.contactId);await completion.waitForIdle(runId);assert.equal(f.calls.length,4,'新策略结果也保持幂等');
 assert.ok(completions.every(item=>JSON.stringify(item.contactIds)===JSON.stringify([f.contactId])&&item.onlyContactId===f.contactId));
 assert.deepEqual(await Promise.all(scopes.map(scope=>management.read(scope))),untouched);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const mode of ['unknown','failed'])test(`策略变化不绕过${mode}的默认保护`,async t=>{
 const f=await adjudicationFixture(t);
 await f.management.decide({requestKey:`policy-guard-parent-${mode}`,action:'manual',scope:f.scope,body:'独立合成长期资料。'});
 let failFinish=mode==='failed';const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{
  if(failFinish&&name==='memoryAdjudication.finish')throw new StorageFailure('memory_adjudication_stale');
  return execute(name,input,...rest);
 };
 if(mode==='unknown')f.setRespond(async()=>{throw new Error('合成发送后回执未知');});
 const runId=await f.extract(['我长期偏好合成园艺。']);await f.adjudication.publishRun(runId,f.contactId);
 const original=await f.trace();
 assert.ok(original.steps.some(step=>step.state===mode));
 if(mode==='failed')assert.ok(original.calls.every(call=>call.state==='succeeded'&&call.settlement_state==='settled'));
 await f.storage.execute('fixture.oldAdjudicationPolicy',{ownerId:f.owner,runId});
 const before=await f.trace(),calls=f.calls.length;failFinish=false;f.setRespond(adjudicationSupplier());
 await f.adjudication.publishRun(runId,f.contactId);
 assert.equal(f.calls.length,calls,'新策略不能冒充恢复许可');assert.deepEqual(await f.trace(),before);
 assert.equal((await f.read()).memories.length,1);assert.equal((await f.read()).candidates.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
