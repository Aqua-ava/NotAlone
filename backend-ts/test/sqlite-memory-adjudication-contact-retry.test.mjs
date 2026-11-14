import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

test('显式重试只恢复目标联系人的已知失败，成功回执及其他联系人和本人保持原样',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/adjudication-registry.mjs',import.meta.url).href});
 const [contactId,otherContactId]=f.saved.map(binding=>binding.contact_id),management=new SqliteMemoryManagement(f.storage,owner);
 const scopes=[{scopeKind:'contact',contactId},{scopeKind:'contact',contactId:otherContactId},{scopeKind:'self',contactId:null}];
 for(const [index,scope] of scopes.entries())await management.decide({requestKey:`synthetic-retry-pool-${index}`,action:'manual',scope,body:`合成长期资料${index}`});
 f.channel.page=async scope=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:[record('1',{text:scope.token.contact_id===contactId?'我长期喜欢合成绿茶。':'我长期喜欢合成红茶。'}),record('2',{sender:'owner',text:'我长期喜欢合成园艺。'})],
  completedPartitions:['shard-a'],exhausted:true});
 for(const id of [contactId,otherContactId])await f.service.synchronize(id);
 await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const run=await extraction.start('synthetic-contact-known-retry');await extraction.waitForIdle(run.runId);
 let failFinish=true;
 const observed={execute:async(name,input)=>{if(failFinish&&name==='memoryAdjudication.finish')throw new StorageFailure('memory_adjudication_stale');return f.storage.execute(name,input);}};
 const port=modelPort(()=>extraction.accounting,adjudicationSupplier()),adjudication=new SqliteMemoryAdjudication(observed,owner,port,new ActiveHolders());t.after(()=>adjudication.close());await adjudication.initialize();
 await adjudication.publishRun(run.runId);
 const before=await f.storage.execute('fixture.adjudicationTrace',{ownerId:owner}),version=(await extraction.read(run.runId)).controlVersion;
 assert.equal(before.calls.length,8,'四个候选各自已有裁决与核验成功回执');
 assert.ok(before.calls.every(call=>call.state==='succeeded'&&call.settlement_state==='settled'));
 const target=(await management.read(scopes[0])).candidates[0];
 const untouched=await Promise.all(scopes.slice(1).map(scope=>management.read(scope)));
 failFinish=false;
 await adjudication.publishRun(run.runId,contactId);
 assert.equal(port.calls,8,'默认单联系人发布不能盲目重发已知失败');
 const retried=await adjudication.publishRun(run.runId,contactId,{retryKnownFailures:true});
 assert.deepEqual(retried.candidateIds,[target.id]);
 assert.equal(port.calls,10,'显式恢复重新建立真实调用，不能冒充复用旧回执');
 const after=await f.storage.execute('fixture.adjudicationTrace',{ownerId:owner});
 assert.deepEqual(after.calls.slice(0,before.calls.length),before.calls,'旧调用、费用与回执不得改写');
 assert.deepEqual(await Promise.all(scopes.slice(1).map(scope=>management.read(scope))),untouched);
 assert.equal((await management.read(scopes[0])).candidates.length,0);
 assert.equal((await extraction.read(run.runId)).controlVersion,version,'不推进整轮或其他范围控制修订');
 await assert.rejects(adjudication.publishRun(run.runId,undefined,{retryKnownFailures:true}),{code:'memory_adjudication_scope_invalid'});
 const otherCandidate=untouched[0].candidates[0],selfCandidate=untouched[1].candidates[0];
 for(const candidate of [otherCandidate,selfCandidate])await assert.rejects(f.storage.execute('memoryAdjudication.claim',{ownerId:owner,candidateId:candidate.id,contactId,retryKnownFailures:true}),{code:'memory_adjudication_scope_invalid'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('显式联系人失败重试仍保护未知回执，不创建新尝试或调用',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期保留一项合成事项。'],{publish:true});f.calls.length=0;
 f.setRespond(async()=>{throw new Error('合成发送后无回执');});
 const runId=await f.extract(['我新增另一项合成长期安排。']);await f.adjudication.publishRun(runId,f.contactId);
 const before=await f.trace();f.setRespond(adjudicationSupplier());
 await f.adjudication.publishRun(runId,f.contactId,{retryKnownFailures:true});
 assert.deepEqual(await f.trace(),before);assert.equal(f.calls.length,1);
});

test('显式联系人失败重试仍遵守暂停门槛',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期保留一项合成事项。'],{publish:true});f.calls.length=0;
 const runId=await f.extract(['我新增另一项合成长期安排。']),prepare=f.port.prepare;
 f.port.prepare=async()=>{throw new StorageFailure('extraction_model_configuration_invalid');};
 await f.adjudication.publishRun(runId,f.contactId);f.port.prepare=prepare;
 const before=await f.trace();
 // 经正式控制动作恢复到待执行后暂停；已结束轮次的单独 pause 本来是幂等空操作。
 await f.storage.execute('memoryExtraction.control',{ownerId:f.owner,runId,action:'continue',actionVersion:(await f.extraction.read(runId)).controlVersion,operationId:randomUUID()});
 await f.extraction.pause(runId,(await f.extraction.read(runId)).controlVersion,randomUUID());
 assert.equal((await f.extraction.read(runId)).status,'paused');
 await f.adjudication.publishRun(runId,f.contactId,{retryKnownFailures:true});
 assert.deepEqual(await f.trace(),before);assert.equal(f.calls.length,0);
});

test('显式联系人失败重试不能把已放弃但费用仍未知的旧调用当作已结清',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期保留一项合成事项。'],{publish:true});f.calls.length=0;
 f.setRespond(async()=>{throw new Error('合成发送后无回执');});
 const runId=await f.extract(['我新增另一项合成长期安排。']);await f.adjudication.publishRun(runId,f.contactId);
 await f.extraction.abandonUnknown(runId,(await f.extraction.read(runId)).controlVersion,randomUUID());await f.extraction.waitForIdle(runId);
 const before=await f.trace();assert.equal(before.calls[0].state,'failed');assert.equal(before.calls[0].settlement_state,'unknown');
 f.setRespond(adjudicationSupplier());await f.adjudication.publishRun(runId,f.contactId,{retryKnownFailures:true});
 assert.deepEqual(await f.trace(),before);assert.equal(f.calls.length,1);
});

test('显式联系人失败重试不能恢复已撤销的读取来源',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期保留一项合成事项。'],{publish:true});f.calls.length=0;
 const runId=await f.extract(['我新增另一项合成长期安排。']),prepare=f.port.prepare;
 f.port.prepare=async()=>{throw new StorageFailure('extraction_model_configuration_invalid');};
 await f.adjudication.publishRun(runId,f.contactId);f.port.prepare=prepare;
 const binding=f.saved.find(item=>item.contact_id===f.contactId);await f.contacts.revoke(f.contactId,binding.binding_id,binding.selection_generation);
 const before=await f.trace();await f.adjudication.publishRun(runId,f.contactId,{retryKnownFailures:true});
 assert.deepEqual(await f.trace(),before);assert.equal(f.calls.length,0);
});
