import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';

const adjudicationSteps=trace=>trace.steps.filter(s=>s.kind==='adjudication');
const unresolved=trace=>adjudicationSteps(trace).map(s=>s.state).filter(state=>state!=='succeeded');
/** 先存一条正式资料，再让同一轮两个新候选都需要真实裁决；第一次发送后无回执。 */
async function unknownRun(t){
 const f=await adjudicationFixture(t);
 await f.extract(['我长期保留合成事项1。'],{publish:true});f.calls.length=0;
 f.setRespond(async()=>{throw new Error('合成裁决发送后无回执');});
 const runId=await f.extract(['我新增合成长期资料甲。','我新增合成长期资料乙。']);
 await f.adjudication.publishRun(runId);
 return {f,runId};
}

test('一次未知回执后同轮其余候选停止领取，不再制造无调用记录的失败尝试',async t=>{
 const {f,runId}=await unknownRun(t);
 assert.equal(f.calls.length,1,'未知之后不得再发出新请求');
 let trace=await f.trace();
 assert.deepEqual(unresolved(trace),['unknown'],'其余候选不得变成失败尝试');
 assert.equal(f.failures.filter(x=>x.action==='memoryAdjudication.prepareCall').length,0,'不得再撞占位唯一索引');
 assert.deepEqual(trace.items.filter(i=>i.effect_kind==='adjudication').map(i=>i.state),['unknown']);
 await f.adjudication.publishRun(runId);
 const stepsBefore=adjudicationSteps(trace).length;
 trace=await f.trace();assert.equal(adjudicationSteps(trace).length,stepsBefore,'重复发布不得累积失败尝试');assert.equal(f.calls.length,1);
 const view=await f.extraction.read(runId);
 assert.equal(view.status,'blocked');assert.equal(view.statusReason,'model_receipt_unknown');
 assert.ok(view.actions.includes('abandon_unknown'),'裁决类未知应提供放弃动作');
});

test('放弃未知裁决调用：账本成本保持未知、占位释放，并重新裁决全部候选',async t=>{
 const {f,runId}=await unknownRun(t);
 const before=await f.extraction.read(runId),receiptBefore=(await f.trace()).calls[0].receipt;
 await assert.rejects(f.extraction.abandonUnknown(runId,before.controlVersion+1,randomUUID()),{code:'memory_extraction_control_conflict'});
 assert.equal((await f.trace()).calls[0].state,'unknown','版本过期时不得改动');
 const run=await f.extraction.abandonUnknown(runId,before.controlVersion,randomUUID());
 assert.ok(run.controlVersion>before.controlVersion);
 let trace=await f.trace();
 const call=trace.calls[0];
 assert.equal(call.state,'failed');assert.equal(call.error_code,'unknown_abandoned');
 assert.equal(call.settlement_state,'unknown','放弃重试不等于确认未计费');assert.deepEqual(call.receipt,receiptBefore,'回执原样保留');assert.equal(call.operation_state,'failed');
 assert.equal(trace.items.filter(i=>i.state==='unknown').length,0);
 const event=trace.events.find(e=>e.kind==='adjudication_unknown_abandoned');
 assert.ok(event);assert.equal(event.payload.actor,'user');assert.deepEqual(event.payload.call_ids,[call.id]);
 assert.equal(trace.steps.filter(s=>s.state==='unknown').length,0);
 const after=await f.extraction.read(runId);
 assert.notEqual(after.statusReason,'model_receipt_unknown');assert.ok(!after.actions.includes('abandon_unknown'));
 f.setRespond(adjudicationSupplier());await f.extraction.waitForIdle(runId);await f.adjudication.publishRun(runId);
 const view=await f.read();
 assert.equal(view.memories.filter(m=>m.state==='active').length,3,'原有1条加两个候选各自采纳');
 assert.equal(f.calls.filter(c=>c.purpose==='adjudication').length,3,'放弃的那次不重发，两个候选各重新裁决一次');
 trace=await f.trace();assert.equal(trace.steps.filter(s=>s.state==='unknown').length,0);
});

test('只有裁决类未知可放弃：提取核验未知同时存在时拒绝，且不改动任何调用',async t=>{
 const {f,runId}=await unknownRun(t);
 await f.storage.execute('fixture.markExtractionStepUnknown',{ownerId:f.owner,runId});
 const view=await f.extraction.read(runId);
 assert.ok(!view.actions.includes('abandon_unknown'));
 await assert.rejects(f.extraction.abandonUnknown(runId,view.controlVersion,randomUUID()),{code:'memory_extraction_control_conflict'});
 const trace=await f.trace();assert.equal(trace.calls[0].state,'unknown');assert.equal(trace.items.filter(i=>i.state==='unknown').length>0,true);
});

test('失败原因保留稳定错误码与供应商失败快照，不带上游消息',async t=>{
 const f=await adjudicationFixture(t);
 await f.extract(['我长期保留合成事项1。'],{publish:true});
 f.setRespond(async()=>{throw Object.assign(new Error('上游消息含敏感内容'),{code:'extraction_model_call_failed',provider_failure:{name:'LlmError',code:'http_error',status:503,message:'不应落库'}});});
 const runId=await f.extract(['我新增合成长期资料。']);await f.adjudication.publishRun(runId);
 const trace=await f.trace();
 const step=trace.steps.find(s=>s.kind==='adjudication'&&s.attempt_state!=='succeeded');
 assert.equal(step.error_code,'extraction_model_call_failed');
 const event=trace.events.find(e=>e.kind==='adjudication_failure');
 assert.deepEqual(event.payload,{code:'extraction_model_call_failed',provider_failure:{name:'LlmError',code:'http_error',status:503}});
});

test('已成功裁决且依据未变的候选，控制修订推进后不重复裁决；依据变化才重新裁决',async t=>{
 const f=await adjudicationFixture(t);
 await f.extract(['我长期保留合成事项1。'],{publish:true});
 const first=(await f.read()).memories[0];
 await f.management.decide({requestKey:'withdraw-for-rerun',action:'withdraw',memoryId:first.id,expectedVersionNo:'1',expectedHeadRevision:first.headRevision});
 f.setRespond(adjudicationSupplier({action:'update',select:parents=>parents.filter(p=>p.memory_id===first.id)}));
 const runId=await f.extract(['我声称要改变旧事项。']);await f.adjudication.publishRun(runId);
 assert.ok((await f.read()).candidates.some(c=>c.state==='pending'),'前置：候选因保护停在待处理');
 const callsBefore=f.calls.length,stepsBefore=adjudicationSteps(await f.trace()).length;
 assert.ok(callsBefore>0);
 // 用真实控制动作推进整轮修订：暂停后继续。
 const paused=await f.extraction.pause(runId,(await f.extraction.read(runId)).controlVersion,randomUUID());
 await f.extraction.continue(runId,paused.controlVersion,randomUUID());await f.extraction.waitForIdle(runId);
 await f.adjudication.publishRun(runId);
 assert.equal(f.calls.length,callsBefore,'依据未变，不得重复发送模型请求');
 assert.equal(adjudicationSteps(await f.trace()).length,stepsBefore,'不新增裁决尝试');
 // 同范围记忆发生变化后依据即不同，必须重新裁决。
 await f.management.decide({requestKey:'manual-after-decision',action:'manual',scope:f.scope,body:'依据变化后新增的人工资料'});
 const again=await f.extraction.pause(runId,(await f.extraction.read(runId)).controlVersion,randomUUID());
 await f.extraction.continue(runId,again.controlVersion,randomUUID());await f.extraction.waitForIdle(runId);
 await f.adjudication.publishRun(runId);
 assert.ok(f.calls.length>callsBefore,'依据变化后应重新裁决');
});
