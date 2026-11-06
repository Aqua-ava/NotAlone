import test from 'node:test';
import assert from 'node:assert/strict';
import {ambiguitySignal,unconfirmedAmbiguity,AMBIGUITY_UNCONFIRMED} from '../src/memory/extraction/ambiguity-guard.ts';
import {adjudicationFixture} from './fixtures/memory-management/adjudication-support.mjs';

/** 数量词省略单位：独立数字没有单位/量词，邻近也没有类别词时命中。 */
test('独立数字缺少单位时命中数量歧义',()=>{
 assert.deepEqual(ambiguitySignal({text:'联系人的弟弟换工作了，联系人称他（弟弟）是 3000；用户问过工资多少、房贷压力大不大。'}),{rule:'quantity_without_unit',token:'3000'});
 assert.deepEqual(ambiguitySignal({text:'联系人称能多赚点。'}),{rule:'quantity_without_unit',token:'多赚点'});
 assert.deepEqual(ambiguitySignal({text:'最后给了三千。'}),{rule:'quantity_without_unit',token:'三千'});
});

test('数字有单位、邻近类别词或属于固定数字时不算数量歧义',()=>{
 assert.equal(ambiguitySignal({text:'联系人称他弟弟新工作的月薪是 3000 元。'}),null);
 assert.equal(ambiguitySignal({text:'联系人称月薪 3000，没说具体发放时间。'}),null);
 assert.equal(ambiguitySignal({text:'联系人称一个月 3000 元。'}),null);
 assert.equal(ambiguitySignal({text:'用户本人从 985 院校筛选到最后。'}),null);
 assert.equal(ambiguitySignal({text:'联系人长期保留合成事项0。'}),null);
 assert.equal(ambiguitySignal({text:'用户本人计划在 2026 年完成换工作。'}),null);
});

test('代词在正文里没有唯一所指时命中指代歧义',()=>{
 assert.deepEqual(ambiguitySignal({text:'联系人称先给他了。'}),{rule:'unresolved_reference',token:'他'});
 assert.deepEqual(ambiguitySignal({text:'联系人称那个已经处理好了。'}),{rule:'unresolved_reference',token:'那个'});
});

test('指代已消解或指示词后接具体名词时不算歧义',()=>{
 assert.equal(ambiguitySignal({text:'联系人称他（弟弟）是 3000 元。'}),null);
 assert.equal(ambiguitySignal({text:'联系人和用户本人上周去了那家店，觉得味道一般。'}),null);
 assert.equal(ambiguitySignal({text:'联系人认为其他方案都还行。'}),null);
});

test('解释字段保留了原话代词且正文出现多个人物时命中指代歧义',()=>{
 assert.deepEqual(ambiguitySignal({text:'联系人的哥哥上周来借钱，朋友那边也催联系人，联系人称先把钱给哥哥了。',
  interpretationReason:'联系人自述哥哥上周来借钱、朋友催款，并称先给他了。'}),{rule:'unresolved_reference',token:'他'});
});

test('alternatives 非空时不触发兜底',()=>{
 assert.equal(unconfirmedAmbiguity({text:'联系人称能多赚点。',alternatives:['可能指行业收入，也可能指兼职收入']}),null);
 assert.deepEqual(unconfirmedAmbiguity({text:'联系人称能多赚点。',alternatives:[]}),{rule:'quantity_without_unit',token:'多赚点'});
});

async function seed(f){await f.extract(['我保留一条合成长期事项。'],{publish:true});f.calls.length=0;}

test('裁决领取前：真两读且 alternatives 为空时降级为待确认，不发起裁决调用',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 f.setExtractionTransform(memory=>{memory.text='联系人的弟弟换工作了，联系人称他（弟弟）是 3000；用户问过工资多少、房贷压力大不大。';});
 await f.extract(['我弟弟最近换了工作。'],{publish:true});
 const view=await f.read();
 assert.equal(view.memories.length,1,'命中兜底时不得自动采纳成记忆');
 const candidate=view.candidates.find(candidate=>(candidate.body??'').includes('3000'));
 assert.ok(candidate,JSON.stringify(view.candidates.map(c=>({body:c.body,reason:c.pendingReason}))));
 assert.equal(candidate.state,'pending');
 assert.equal(candidate.pendingStage,'decision_pending');
 assert.equal(candidate.pendingReason,AMBIGUITY_UNCONFIRMED);
 assert.deepEqual(f.calls.filter(call=>!['extraction','verification'].includes(call.purpose)),[],'兜底命中后不得为此候选发起裁决或关系核验调用');
});

test('细节缺失但合并已补全的数量不降级，仍按原逻辑自动采纳',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 f.setExtractionTransform(memory=>{memory.text='联系人称他弟弟新工作的月薪是 3000 元，用户问过工资和房贷。';});
 await f.extract(['我弟弟换了工作，月薪说了。'],{publish:true});
 const view=await f.read();
 assert.equal(view.memories.length,2);
 assert.ok(!view.candidates.some(candidate=>candidate.state==='pending'&&candidate.pendingReason===AMBIGUITY_UNCONFIRMED));
});

test('alternatives 非空时不降级，保持原逻辑并在采纳事件里保留标注',async t=>{
 const f=await adjudicationFixture(t);
 f.setExtractionTransform(memory=>{memory.text='联系人的弟弟换工作了，联系人称他（弟弟）是 3000；用户问过工资多少、房贷压力大不大。';memory.alternatives=['“他是 3000”可能指弟弟的工资，也可能指弟弟的房贷'];});
 await f.extract(['我弟弟最近换了工作。'],{publish:true});
 const view=await f.read();
 assert.equal(view.memories.length,1);
 const latest=(await f.trace()).events.filter(event=>event.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,null);
 assert.deepEqual(latest.payload.adopted_with_alternatives,['“他是 3000”可能指弟弟的工资，也可能指弟弟的房贷']);
});

test('发布入口同样降级：系统自动采纳遇到未标注易歧义结构时保持待确认',async t=>{
 const f=await adjudicationFixture(t);
 f.setExtractionTransform(memory=>{memory.text='联系人称他弟弟换工作了，联系人称他（弟弟）是 3000；用户问过工资多少、房贷压力大不大。';});
 const runId=await f.extract(['我弟弟最近换了工作。']);
 await f.management.publishRun(runId);
 const view=await f.read();
 assert.equal(view.memories.length,0,'自动采纳入口命中兜底时不得写记忆');
 const candidate=view.candidates.find(candidate=>(candidate.body??'').includes('3000'));
 assert.ok(candidate,JSON.stringify(view.candidates.map(c=>({body:c.body,reason:c.pendingReason}))));
 assert.equal(candidate.pendingReason,AMBIGUITY_UNCONFIRMED);
});

test('用户手动采纳不受兜底影响：system=false 仍按原逻辑写入',async t=>{
 const f=await adjudicationFixture(t);
 f.setExtractionTransform(memory=>{memory.text='联系人称他弟弟换工作了，联系人称他（弟弟）是 3000；用户问过工资多少、房贷压力大不大。';});
 const runId=await f.extract(['我弟弟最近换了工作。']);
 const before=await f.read();
 const candidate=before.candidates.find(candidate=>(candidate.body??'').includes('3000'));
 assert.ok(candidate,JSON.stringify(before.candidates.map(c=>({body:c.body,reason:c.pendingReason}))));
 assert.equal(before.memories.length,0);
 await f.management.decide({requestKey:`manual-accept-${runId}`,action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const after=await f.read();
 assert.equal(after.memories.length,1,'用户手动采纳不得被兜底拦截');
 assert.equal(after.memories[0].current.body,candidate.body);
});

test('普通无歧义候选不受兜底影响，仍自动采纳',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 await f.extract(['我补充一条与既有合成事项无关的事实。'],{publish:true});
 const view=await f.read();
 assert.equal(view.memories.length,2);
 assert.ok(!view.candidates.some(candidate=>candidate.pendingReason===AMBIGUITY_UNCONFIRMED));
});
