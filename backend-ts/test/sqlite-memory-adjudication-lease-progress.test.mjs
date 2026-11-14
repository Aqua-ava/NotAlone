import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';

test('多页裁决持续取得已知成功进展时整组续期，总耗时超过五分钟仍完整采纳',async t=>{
 const f=await adjudicationFixture(t);
 for(let index=0;index<9;index++)await f.management.decide({requestKey:`lease-progress-parent-${index}`,action:'manual',scope:f.scope,body:`独立合成长期事项${index}。`});
 const normal=adjudicationSupplier();let progress=0;
 f.setRespond(async(request,input)=>{
  await f.storage.execute('fixture.ageAdjudicationLeases',{ownerId:f.owner,milliseconds:120000});progress++;
  return normal(request,input);
 });
 await f.extract(['我长期偏好合成园艺。'],{publish:true});
 const view=await f.read(),trace=await f.trace();
 assert.equal(progress,4,'两页裁决及各自关系核验必须全部实际执行');
 assert.equal(view.memories.length,10,'持续有效进展不能在最终采纳时因首步骤租约过期而丢弃全部成功结果');
 assert.equal(view.candidates.length,0);assert.ok(trace.steps.every(step=>step.state==='succeeded'));
 assert.equal(trace.calls.length,4);assert.ok(trace.calls.every(call=>call.state==='succeeded'&&call.settlement_state==='settled'));
 assert.equal(trace.events.filter(event=>event.kind==='adjudication_lease_progress').length,4);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同一成功progress幂等且不重复续命，续期不缩短已有较远租约',async t=>{
 const f=await adjudicationFixture(t);await f.management.decide({requestKey:'lease-idempotent-parent',action:'manual',scope:f.scope,body:'独立合成长期资料。'});
 const execute=f.storage.execute.bind(f.storage);let checked=false;
 f.storage.execute=async(name,input,...rest)=>{
  if(name==='memoryAdjudication.renew'&&!checked){
   checked=true;
   await execute('fixture.alterAdjudicationLease',{ownerId:f.owner,attemptId:input.attemptIds[0],fault:'future'});
   const before=await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds:input.attemptIds});
   const result=await execute(name,input,...rest);assert.equal(result.renewed,true);
   assert.deepEqual(await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds:input.attemptIds}),before,'不能缩短已有较远租期');
   await execute('fixture.ageAdjudicationLeases',{ownerId:f.owner,milliseconds:60000});
   const aged=await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds:input.attemptIds});
   assert.equal((await execute(name,input,...rest)).renewed,false);
   assert.deepEqual(await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds:input.attemptIds}),aged,'相同旧成功调用不能再次延长租期');
   return result;
  }
  return execute(name,input,...rest);
 };
 await f.extract(['我长期偏好合成园艺。'],{publish:true});assert.equal(checked,true);
 assert.equal((await f.read()).memories.length,2);assert.equal(f.calls.length,2);
});

for(const fault of ['expired','runtime','generation','control','paused','unknown','sealed','source','incomplete'])test(`整组续期拒绝${fault}且不延长任何成员`,async t=>{
 const f=await adjudicationFixture(t);await f.management.decide({requestKey:`lease-guard-parent-${fault}`,action:'manual',scope:f.scope,body:'独立合成长期资料。'});
 const execute=f.storage.execute.bind(f.storage);let checked=false;
 f.storage.execute=async(name,input,...rest)=>{
  if(name==='memoryAdjudication.renew'&&input.attemptIds.length===2&&!checked){
   checked=true;const prior=structuredClone(input);
   if(fault==='incomplete')input={...input,attemptIds:input.attemptIds.slice(1)};
   else await execute('fixture.alterAdjudicationLease',{ownerId:f.owner,attemptId:input.attemptIds[0],fault});
   const before=await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds:prior.attemptIds});
   let rejected;
   try{await execute(name,input,...rest);}catch(error){rejected=error;}
   assert.ok(rejected,'失效或不完整组不得续期');
   assert.deepEqual(await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds:prior.attemptIds}),before,'整组校验失败不能留下部分续期');
   throw rejected;
  }
  return execute(name,input,...rest);
 };
 await f.extract(['我长期偏好合成园艺。'],{publish:true});assert.equal(checked,true);
 const view=await f.read(),trace=await f.trace();
 assert.equal(view.memories.length,1);assert.ok(trace.steps.every(step=>step.state!=='succeeded'));
 assert.equal(trace.events.filter(event=>event.kind==='adjudication_lease_progress').length,1,'失败的第二次续期不能写进展事件');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同owner同task的其他候选执行组不能借本次成功调用续期',async t=>{
 const f=await adjudicationFixture(t);await f.management.decide({requestKey:'lease-cross-group-parent',action:'manual',scope:f.scope,body:'独立合成长期资料。'});
 const execute=f.storage.execute.bind(f.storage);let checked=false;
 f.storage.execute=async(name,input,...rest)=>{
  if(name==='memoryAdjudication.renew'&&!checked){
   checked=true;const trace=await f.trace(),candidateId=trace.events.find(event=>event.kind==='adjudication_basis').payload.candidateId;
   const other=(await f.read()).candidates.find(candidate=>candidate.id!==candidateId);assert.ok(other);
   const foreign=await execute('memoryAdjudication.claim',{ownerId:f.owner,candidateId:other.id});assert.ok(foreign);
   const attemptIds=[...input.attemptIds,foreign.attemptId],before=await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds});
   await assert.rejects(execute(name,{...input,attemptIds},...rest),{code:'memory_adjudication_stale'});
   assert.deepEqual(await execute('fixture.adjudicationLeaseState',{ownerId:f.owner,attemptIds}),before);
   await execute('memoryAdjudication.fail',{ownerId:f.owner,attemptIds:[foreign.attemptId],code:'synthetic_foreign_group'});
  }
  return execute(name,input,...rest);
 };
 await f.extract(['我长期偏好合成园艺。','我长期保留合成茶饮。'],{publish:true});assert.equal(checked,true);
 assert.equal((await f.read()).memories.length,2,'排除其他组后原合法组仍可正常推进');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
