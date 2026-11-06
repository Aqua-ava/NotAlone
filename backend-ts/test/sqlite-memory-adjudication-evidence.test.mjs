import test from 'node:test';import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier,owner} from './fixtures/memory-management/adjudication-support.mjs';
import {AMBIGUITY_NOTE} from '../src/memory/extraction/bounded.ts';
const seed=async(f,count=1)=>{await f.extract(Array.from({length:count},(_,i)=>`我长期保留合成事项${i}。`),{publish:true});f.calls.length=0;};
const modify=(result,tool,transform)=>{const value=JSON.parse(result.blocks[0].arguments);transform(value);return {blocks:[{type:'tool-call',name:tool,arguments:JSON.stringify(value)}]};};
for(const side of ['new','old'])test(`关系核验仅引用${side==='new'?'新':'旧'}来源不得发布更新`,async t=>{
 const f=await adjudicationFixture(t);await seed(f);const normal=adjudicationSupplier({action:'update'});
 f.setRespond(async(request,input)=>{const result=await normal(request,input);if(request.purpose!=='relation_verification')return result;const payload=JSON.parse(request.user)[0],source=side==='new'?payload.sources.candidate:payload.sources.prior.flatMap(p=>p.sources);return modify(result,request.tool.name,value=>{value.results[0].evidence=source.map(s=>({message_id:s.message_id,quote:s.text}));});});
 await f.extract(['我现在改变该合成事项。'],{publish:true});const view=await f.read();assert.equal(view.memories.length,1);assert.equal(view.memories[0].current.versionNo,'1');assert.ok(view.candidates.some(c=>c.state==='pending'));assert.equal((await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1).payload.reason,'memory_relation_pending');
});

test('独立关系仅引用候选来源即可自动采纳，不要求覆盖无关旧记忆原文',async t=>{
 const f=await adjudicationFixture(t);await seed(f);const normal=adjudicationSupplier({action:'add'});
 f.setRespond(async(request,input)=>{const result=await normal(request,input);if(request.purpose!=='relation_verification')return result;const payload=JSON.parse(request.user)[0];return modify(result,request.tool.name,value=>{value.results[0].evidence=payload.sources.candidate.map(s=>({message_id:s.message_id,quote:s.text}));});});
 await f.extract(['我补充一条与既有合成事项无关的新事实。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,2);
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,null);assert.equal(latest.payload.action,'auto_accept');assert.deepEqual(latest.payload.parentMemoryIds,[]);
});

test('同义重复的旧记忆判 noop 时自动跳过并记录 skipped_duplicate',async t=>{
 const f=await adjudicationFixture(t);await seed(f);const normal=adjudicationSupplier({action:'noop'});
 f.setRespond(async(request,input)=>normal(request,input));
 // 候选正文的信息量（长度代理）不高于旧记忆，模型判无增量时自动 noop。
 await f.extract(['我更新了合成的事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,1);
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,null);assert.equal(latest.payload.action,'auto_noop');assert.equal(latest.payload.parentMemoryIds.length,1);
 const skipped=(await f.trace()).events.filter(e=>e.kind==='skipped_duplicate').at(-1);
 assert.ok(skipped&&Array.isArray(skipped.payload.newSources)&&skipped.payload.newSources.length===1,JSON.stringify(skipped?.payload));
});

test('受保护的旧记忆判 duplicate 时仍待确认',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 const memory=(await f.read()).memories[0];
 await f.management.decide({requestKey:'adjudication-protect-duplicate',action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 const normal=adjudicationSupplier({action:'noop'});
 f.setRespond(async(request,input)=>normal(request,input));
 await f.extract(['我更新了另一项合成事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,1);
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,'memory_duplicate_pending');
});

test('keep 声称补充关系时通过关系核验即可自动并存',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 const normal=adjudicationSupplier({action:'keep',kind:'supplement'});
 f.setRespond(async(request,input)=>normal(request,input));
 await f.extract(['我补充一条既有的合成事项背景。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,2);
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,null);assert.equal(latest.payload.action,'auto_accept');
});

test('add 声称补充关系时仍待确认',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 const normal=adjudicationSupplier({action:'add',kind:'supplement'});
 f.setRespond(async(request,input)=>{const result=await normal(request,input);if(request.purpose!=='relation_verification')return result;const payload=JSON.parse(request.user)[0];return modify(result,request.tool.name,value=>{value.results[0].evidence=payload.sources.candidate.map(s=>({message_id:s.message_id,quote:s.text}));});});
 await f.extract(['我新增一项补充性质的合成事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,1);
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,'memory_relation_pending');
});

test('合并核验仅引用新候选，缺任一选定父的来源时不得合并',async t=>{
 const f=await adjudicationFixture(t);await seed(f,2);const normal=adjudicationSupplier({action:'merge'}),before=(await f.read()).memories;
 f.setRespond(async(request,input)=>{const result=await normal(request,input);if(request.purpose!=='merge_verification')return result;const payload=JSON.parse(request.user).candidate_and_parents;return modify(result,request.tool.name,value=>{value.evidence=payload.sources.candidate.map(s=>({message_id:s.message_id,quote:s.text}));});});
 await f.extract(['我补充上述事项。'],{publish:true});assert.deepEqual((await f.read()).memories,before);assert.equal((await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1).payload.reason,'memory_merge_pending');
});

test('部分父合并只核验所选父，未选C的引句不能成为隐含依据',async t=>{
 const f=await adjudicationFixture(t);await seed(f,3);const original=(await f.read()).memories,selected=original.slice(0,2).map(m=>m.id),unselected=original[2],normal=adjudicationSupplier({action:'merge',select:parents=>parents.filter(p=>selected.includes(p.memory_id))});let requestParents=[];
 f.setRespond(async(request,input)=>{const result=await normal(request,input);if(request.purpose!=='merge_verification')return result;const payload=JSON.parse(request.user).candidate_and_parents;requestParents=payload.sources.prior.map(p=>p.memory_id);return modify(result,request.tool.name,value=>{value.evidence.push(...unselected.current.sources.map(s=>({message_id:s.messageId,quote:s.quote})));});});
 await f.extract(['我补充所选两项。'],{publish:true});assert.deepEqual(new Set(requestParents),new Set(selected));assert.deepEqual((await f.read()).memories,original);assert.equal((await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1).payload.reason,'memory_merge_pending');
});

test('alternatives 自由文本不再拦截，采纳事件记录 adopted_with_alternatives',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 f.setExtractionTransform(memory=>{memory.alternatives=['该动作用到工具，本窗未提到具体对象。'];});
 await f.extract(['我补充一条带未写细节的合成事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,2);
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,null);assert.equal(latest.payload.action,'auto_accept');
 assert.deepEqual(latest.payload.adopted_with_alternatives,['该动作用到工具，本窗未提到具体对象。']);
});

test('alternatives 全为未决指代标注时仍待确认',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 f.setExtractionTransform(memory=>{memory.alternatives=[AMBIGUITY_NOTE];});
 await f.extract(['我提到那个合成的安排。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,1);
 assert.ok(view.candidates.some(c=>c.state==='pending'));
 assert.ok((await f.trace()).events.filter(e=>e.kind==='adjudication_result').length<2,'冻结门槛失败时不得产生新的裁决结果');
});

test('事件标注未核实时丢弃标注正文继续，核验结果记 time_unverified',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 f.setExtractionTransform(memory=>{memory.event={version:1,stage:'planned',stage_evidence:[],occurrence_start:null,occurrence_end:null,occurrence_evidence:[]};});
 await f.extract(['我计划近期完成一项合成事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,2);
 const contract=(await f.storage.execute('fixture.extractionTrace',{ownerId:owner})).filter(e=>e.kind==='verification_contract').at(-1);
 assert.ok(contract.payload.results[0].time_unverified,JSON.stringify(contract.payload));
 const latest=(await f.trace()).events.filter(e=>e.kind==='adjudication_result').at(-1);
 assert.equal(latest.payload.reason,null);assert.equal(latest.payload.action,'auto_accept');
});

test('条件无来源支持的候选在核验层被拒，不进入采纳',async t=>{
 const f=await adjudicationFixture(t);await seed(f);
 f.setExtractionTransform(memory=>{memory.conditions={version:1,items:[{text:'若无其他安排则维持',evidence:[]}]};});
 await f.extract(['我在条件允许时完成一项合成事项。'],{publish:true});
 const view=await f.read();assert.equal(view.memories.length,1);
 assert.ok(!view.candidates.some(c=>c.state==='pending'),JSON.stringify(await f.read()));
});
