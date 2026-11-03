import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';

const healthy=async f=>assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
const active=view=>view.memories.filter(m=>m.state==='active');
const diagnostic=async f=>{const trace=await f.trace();return JSON.stringify({failures:f.failures,steps:trace.steps.map(s=>({kind:s.kind,state:s.state,error:s.error_code})),calls:trace.calls.map(c=>({purpose:c.purpose,state:c.state,operationState:c.operation_state})),results:trace.events.filter(e=>e.kind==='adjudication_result').map(e=>e.payload)});};
async function seed(f,count=1){await f.extract(Array.from({length:count},(_,index)=>`我长期保留合成事项${index+1}。`),{publish:true});return (await f.read()).memories;}

test('07两条真实新事实逐候选冻结：首条空池add，第二条独立关系须两次真实记账',async t=>{
 const f=await adjudicationFixture(t),runId=await f.extract(['我长期住在高雄。','我长期偏好绿茶。']);await f.adjudication.publishRun(runId);
 const view=await f.read();assert.equal(view.memories.length,2);assert.equal(view.candidates.length,0);const originals=view.memories.flatMap(m=>m.versions.flatMap(v=>v.originalCandidates??[]));assert.equal(originals.length,2);assert.ok(originals.every(c=>c.state==='adopted'&&c.verificationState==='verified'));assert.ok(view.memories.every(m=>m.current.adoptionMode==='auto'));
 assert.deepEqual(f.calls.map(c=>c.purpose),['adjudication','relation_verification']);
 const trace=await f.trace();assert.equal(trace.calls.length,2);assert.ok(trace.calls.every(c=>c.state==='succeeded'&&c.settlement_state==='settled'&&c.operation_state==='applied'&&c.receipt.outcome==='succeeded'));
 assert.deepEqual(trace.steps.map(s=>s.kind).sort(),['adjudication','adjudication','relation_verification'].sort());
 const before=JSON.stringify(view);await f.adjudication.publishRun(runId);assert.equal(JSON.stringify(await f.read()),before);assert.equal(f.calls.length,2);await healthy(f);
});

test('真实update形成auto v2，人工保护CAS与restore新增v3均保留逐版本来源',async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期住在高雄。'],{publish:true});const original=(await f.read()).memories[0];
 f.setRespond(adjudicationSupplier({action:'update'}));await f.extract(['我现在长期住在台南。'],{publish:true});
 let memory=(await f.read()).memories[0];assert.equal((await f.read()).memories.length,1);assert.equal(memory.id,original.id);assert.equal(memory.current.versionNo,'2');assert.equal(memory.current.body,'联系人现在长期住在台南。');assert.equal(memory.current.adoptionMode,'auto');assert.equal(memory.current.formationKind,'change');
 const restore={requestKey:'restore-pipeline',action:'restore',memoryId:memory.id,expectedVersionNo:'2',expectedHeadRevision:memory.headRevision,restoredFromVersionNo:'1',expectedMergedParents:[]};
 await f.management.decide({requestKey:'protect-pipeline',action:'protect',memoryId:memory.id,expectedVersionNo:'2',expectedHeadRevision:memory.headRevision});
 await assert.rejects(f.management.decide(restore),{code:'memory_head_conflict'});memory=(await f.read()).memories[0];await assert.rejects(f.management.decide({...restore,expectedHeadRevision:memory.headRevision}),{code:'memory_protected'});
 await f.management.decide({requestKey:'unprotect-pipeline',action:'unprotect',memoryId:memory.id,expectedVersionNo:'2',expectedHeadRevision:memory.headRevision});memory=(await f.read()).memories[0];await f.management.decide({...restore,expectedHeadRevision:memory.headRevision});
 memory=(await f.read()).memories[0];assert.equal(memory.current.versionNo,'3');assert.equal(memory.current.previousVersionNo,'2');assert.equal(memory.current.restoredFromVersionNo,'1');assert.equal(memory.current.body,original.current.body);assert.equal(memory.current.adoptionMode,'auto');assert.equal(memory.versions[1].body,'联系人现在长期住在台南。');assert.deepEqual(f.calls.map(c=>c.purpose),['adjudication','relation_verification']);await healthy(f);
});

test('关系核验途中人工protect使迟到update失效，不能新建身份绕过保护',async t=>{
 const f=await adjudicationFixture(t);await seed(f);const original=(await f.read()).memories[0],normal=adjudicationSupplier({action:'update'});
 f.setRespond(async(request,input)=>{if(request.purpose==='relation_verification'){const memory=(await f.read()).memories[0];await f.management.decide({requestKey:'protect-during-verification',action:'protect',memoryId:memory.id,expectedVersionNo:'1',expectedHeadRevision:memory.headRevision});}return normal(request,input);});
 await f.extract(['我后来变更了合成事项。'],{publish:true});const view=await f.read();assert.equal(view.memories.length,1);assert.equal(view.memories[0].id,original.id);assert.equal(view.memories[0].current.versionNo,'1');assert.equal(view.memories[0].manualProtection,true);assert.ok(view.candidates.some(c=>c.state==='pending'));
 const trace=await f.trace();assert.ok(trace.steps.some(s=>s.state==='failed'),await diagnostic(f));assert.equal(trace.decisions.filter(d=>d.action==='auto_update').length,0);await healthy(f);
});

test('真实裁决未知回执保守占用，同run发布与重建runtime均不重发',async t=>{
 const f=await adjudicationFixture(t);await seed(f);f.setRespond(async()=>{throw new Error('合成裁决发送后无回执');});
 const runId=await f.extract(['我新增合成长期资料。']);await f.adjudication.publishRun(runId);assert.equal(f.calls.length,1);await f.adjudication.publishRun(runId);
 const recovered=f.newRuntime();await recovered.initialize();await recovered.publishRun(runId);await f.extraction.continue(runId);await f.extraction.waitForIdle();await recovered.publishRun(runId);assert.equal(f.calls.length,1);
 const trace=await f.trace();assert.equal(trace.calls[0].state,'unknown');assert.equal(trace.calls[0].settlement_state,'unknown');assert.equal(trace.calls[0].operation_state,'unknown');assert.ok(trace.calls[0].reserved_budget_units>0n);assert.equal((await f.read()).memories.length,1);await healthy(f);
});

test('65条人工资料分页为9页18次真实调用，冻结同scope修订且全部完成前不得采纳',async t=>{
 const f=await adjudicationFixture(t);for(let index=0;index<65;index++)await f.management.decide({requestKey:`manual-pool-${index}`,action:'manual',scope:f.scope,body:`独立人工资料${index}`});
 const normal=adjudicationSupplier();let during=0;
 f.setRespond(async(request,input)=>{assert.equal((await f.read()).memories.length,65);during++;return normal(request,input);});
 await f.extract(['我长期偏好另一项合成活动。'],{publish:true});assert.equal(during,18,await diagnostic(f));assert.equal(f.calls.length,18);const view=await f.read();assert.equal(view.memories.length,66);
 const added=view.memories.find(m=>m.current.body==='联系人长期偏好另一项合成活动。');assert.equal(added.current.verificationState,'verified');assert.deepEqual(added.current.sources.map(s=>s.quote),['我长期偏好另一项合成活动。']);
 const pages=f.calls.filter(c=>c.purpose==='adjudication').map(c=>c.payload.existing_memories);assert.deepEqual(pages.map(p=>p.length),[8,8,8,8,8,8,8,8,1]);assert.equal(new Set(pages.flatMap(p=>p.map(m=>m.memory_id))).size,65);
 const trace=await f.trace();assert.equal(trace.steps.length,18);assert.equal(new Set(trace.steps.map(s=>String(s.accepted_memory_revision))).size,1);assert.ok(trace.steps.every(s=>s.state==='succeeded'));assert.equal(trace.calls.filter(c=>c.operation_state==='applied').length,18);await healthy(f);
 for(const event of trace.events.filter(e=>e.kind==='adjudication_input'||e.kind==='adjudication_output')){
  const input=trace.events.find(e=>e.step_attempt_id===event.step_attempt_id&&e.kind==='adjudication_input'),payload=JSON.parse(input.payload.user);
  const expectedMemoryIds=input.payload.purpose==='adjudication'?payload.existing_memories.map(m=>m.memory_id):payload[0].sources.prior.map(m=>m.memory_id);
  const actual=trace.eventInputs.filter(i=>i.event_id===event.id);
  assert.deepEqual(actual.filter(i=>i.kind==='memory').map(i=>i.memory_id).sort(),expectedMemoryIds.sort());
  const expectedMessages=input.payload.purpose==='adjudication'?payload.new_memories[0].source_texts:payload[0].sources.candidate;
  assert.deepEqual(actual.filter(i=>i.kind==='message').map(i=>i.message_id).sort(),expectedMessages.map(m=>m.message_id).sort());assert.equal(actual.filter(i=>i.kind==='candidate').length,1);
 }
 for(const event of trace.events.filter(e=>e.kind==='adjudication_basis')){
  assert.equal(event.payload.parents.length,65);assert.equal(event.payload.item.similar.length,65);assert.equal(trace.eventInputs.filter(i=>i.event_id===event.id&&i.kind==='memory').length,65);
 }
});

test('撤回父资料仍参与比对：独立add允许新增，related update不得复活旧身份',async t=>{
 const f=await adjudicationFixture(t);await seed(f);const first=(await f.read()).memories[0];await f.management.decide({requestKey:'withdraw-old',action:'withdraw',memoryId:first.id,expectedVersionNo:'1',expectedHeadRevision:first.headRevision});
 await f.extract(['我长期偏好另一项活动。'],{publish:true});let view=await f.read();assert.equal(view.memories.length,2);assert.equal(active(view).length,1);assert.equal(view.memories.find(m=>m.id===first.id).current,null);
 f.setRespond(adjudicationSupplier({action:'update',select:parents=>parents.filter(p=>p.memory_id===first.id)}));await f.extract(['我声称要改变旧事项。'],{publish:true});
 view=await f.read();assert.equal(view.memories.length,2);assert.equal(view.memories.find(m=>m.id===first.id).current,null);assert.ok(view.candidates.some(c=>c.state==='pending'));assert.equal((await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1).payload.reason,'memory_protected');await healthy(f);
});

test('跨页未知结果不能把前页独立结论提交为新增',async t=>{
 const f=await adjudicationFixture(t);for(let i=0;i<9;i++)await f.management.decide({requestKey:`unknown-page-parent-${i}`,action:'manual',scope:f.scope,body:`独立人工资料${i}`});
 const normal=adjudicationSupplier();let count=0;f.setRespond(async(request,input)=>{if(++count===3)throw new Error('第二页发送未知');return normal(request,input);});
 const runId=await f.extract(['我长期保留新活动。']);await f.adjudication.publishRun(runId);assert.equal(f.calls.length,3,await diagnostic(f));assert.equal((await f.read()).memories.length,9);assert.equal((await f.read()).candidates[0].state,'pending');await f.adjudication.publishRun(runId);assert.equal(f.calls.length,3);assert.equal((await f.trace()).calls.at(-1).state,'unknown');await healthy(f);
});

test('跨页有多个update目标时保持待决定，不更新也不新增',async t=>{
 const f=await adjudicationFixture(t);await seed(f,9);const original=(await f.read()).memories.map(m=>({id:m.id,version:m.current.versionNo}));f.calls.length=0;
 f.setRespond(adjudicationSupplier({action:'update'}));await f.extract(['我后来改变多项合成事项。'],{publish:true});const view=await f.read();assert.deepEqual(view.memories.map(m=>({id:m.id,version:m.current.versionNo})),original);assert.equal(f.calls.length,4,await diagnostic(f));
 assert.equal((await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1).payload.reason,'memory_multiple_targets_pending');await healthy(f);
});

for(const count of [2,8])test(`真实merge独立核验${count}个auto父资料并能整组恢复与幂等重试`,async t=>{
 const f=await adjudicationFixture(t);await seed(f,count);const before=await f.read();f.calls.length=0;const mergedText='联系人完整保留各项合成长期资料。';f.setRespond(adjudicationSupplier({action:'merge',mergedText}));await f.extract(['我补充说明这些合成事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,count);assert.equal(active(view).length,1);const primary=active(view)[0];assert.equal(primary.current.body,mergedText);assert.equal(primary.current.versionNo,'2');assert.equal(primary.current.adoptionMode,'auto');assert.equal(primary.current.sources.length,count+1);assert.equal(view.memories.filter(m=>m.state==='withdrawn').length,count-1);
 assert.deepEqual(f.calls.map(c=>c.purpose),['adjudication','relation_verification','merge_verification']);const trace=await f.trace(),result=trace.events.filter(e=>e.kind==='adjudication_result').at(-1).payload;assert.deepEqual(new Set(result.parentMemoryIds),new Set(before.memories.map(m=>m.id)));assert.equal(result.reason,null);assert.equal(trace.decisions.filter(d=>d.action==='auto_retire').length,count-1);
 assert.equal(primary.current.mergeParents.length,count-1);assert.equal(primary.current.mergeParentCount,count);
 const request={requestKey:`restore-merged-${count}`,action:'restore',memoryId:primary.id,expectedVersionNo:'2',expectedHeadRevision:primary.headRevision,restoredFromVersionNo:'1',expectedMergedParents:primary.current.mergeParents};
 const restored=await f.management.decide(request),after=await f.read();assert.equal(active(after).length,count);
 for(const old of before.memories){const memory=after.memories.find(m=>m.id===old.id);assert.equal(memory.current.body,old.current.body);assert.equal(memory.current.versionNo,memory.id===primary.id?'3':'2');assert.equal(memory.current.formationKind,'restore');assert.equal(memory.current.restoredFromVersionNo,'1');}
 assert.deepEqual(await f.management.decide(request),restored);assert.deepEqual(await f.read(),after);await healthy(f);
});

for(const action of ['protect','unprotect'])test(`合并父资料保护后旧恢复冲突，${action==='protect'?'持续保护时整组回滚':'解除并刷新可整组恢复和幂等重试'}`,async t=>{
 const f=await adjudicationFixture(t),original=await seed(f,2);f.setRespond(adjudicationSupplier({action:'merge'}));await f.extract(['我补充两项资料之间的关系。'],{publish:true});
 const merged=await f.read(),primary=active(merged)[0];let secondary=merged.memories.find(m=>m.state==='withdrawn');assert.ok(secondary);
 const oldRequest={requestKey:`old-group-restore-${action}`,action:'restore',memoryId:primary.id,expectedVersionNo:'2',expectedHeadRevision:primary.headRevision,restoredFromVersionNo:'1',expectedMergedParents:primary.current.mergeParents};
 await f.management.decide({requestKey:`protect-retired-${action}`,action:'protect',memoryId:secondary.id,expectedVersionNo:'1',expectedHeadRevision:secondary.headRevision});
 let before=await f.read();await assert.rejects(f.management.decide(oldRequest),{code:'memory_head_conflict'});assert.deepEqual(await f.read(),before);
 if(action==='unprotect'){
  secondary=before.memories.find(m=>m.id===secondary.id);await f.management.decide({requestKey:'unprotect-retired-fresh',action:'unprotect',memoryId:secondary.id,expectedVersionNo:'1',expectedHeadRevision:secondary.headRevision});
  before=await f.read();await assert.rejects(f.management.decide(oldRequest),{code:'memory_head_conflict'});assert.deepEqual(await f.read(),before);
 }
 const fresh=before.memories.find(m=>m.id===primary.id),request={...oldRequest,requestKey:`fresh-group-restore-${action}`,expectedMergedParents:fresh.current.mergeParents};
 assert.notDeepEqual(request.expectedMergedParents,oldRequest.expectedMergedParents);
 if(action==='protect'){await assert.rejects(f.management.decide(request),{code:'memory_protected'});assert.deepEqual(await f.read(),before);}
 else {const result=await f.management.decide(request),after=await f.read();assert.equal(active(after).length,2);for(const prior of original)assert.equal(after.memories.find(m=>m.id===prior.id).current.body,prior.current.body);assert.deepEqual(await f.management.decide(request),result);assert.deepEqual(await f.read(),after);}
 await healthy(f);
});
