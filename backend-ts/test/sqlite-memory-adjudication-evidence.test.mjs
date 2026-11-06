import test from 'node:test';import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
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
