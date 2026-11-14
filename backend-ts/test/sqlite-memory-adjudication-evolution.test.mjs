import test from 'node:test';
import assert from 'node:assert/strict';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';

const healthy=async f=>assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
const diagnostic=async f=>JSON.stringify({failures:f.failures,results:(await f.trace()).events.filter(event=>event.kind==='adjudication_result').map(event=>event.payload)});

/** 日期、阶段及逐字证据都来自本次正式提取窗口；只替换供应商返回，不直接写入候选或记忆。 */
function verifiedEventSupplier(f){
 f.setExtractionTransform(memory=>{
  const source=f.normal.sources.get(memory.source_message_ids[0]);
  if(!source.text.includes('骑行'))return;
  const expression='2023-11-14T10:00:00+08:00',stageWord=source.text.includes('计划')?'计划':'完成';
  const ref=word=>({message_id:source.message_id,char_start:source.text.indexOf(word),char_end:source.text.indexOf(word)+word.length});
  memory.event={version:2,stage:stageWord==='计划'?'planned':'occurred',stage_evidence:[ref(stageWord)],
   occurrence_start:expression,occurrence_end:null,occurrence_evidence:[ref(expression)],
   occurrence_precision:'instant',occurrence_expression:expression,anchor_message_id:source.message_id};
 });
 const respond=f.normal.respond;
 f.normal.respond=async(request,input)=>{
  const result=await respond({...request,validateOutput:async()=>{}},input);
  if(request.purpose==='extraction')return result;
  const payload=JSON.parse(request.user),value=JSON.parse(result.blocks[0].arguments);
  for(const [index,candidate] of payload.candidates.entries())if(candidate.event){
   const source=f.normal.sources.get(candidate.source_message_ids[0]);
   value.results[index].event_verification={stage_verdict:'supported',occurrence_verdict:'supported',
    stage_evidence:[{message_id:source.message_id,quote:source.text.includes('计划')?'计划':'完成'}],
    occurrence_evidence:[{message_id:source.message_id,quote:'2023-11-14T10:00:00+08:00'}]};
  }
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 };
}

function verifiedConditionSupplier(f){
 f.setExtractionTransform(memory=>{
  const source=f.normal.sources.get(memory.source_message_ids[0]);
  const text=source.text.includes('周末')?'只有周末有空时':'只在平日晚间有空时';
  const start=source.text.indexOf(text);
  memory.conditions={version:1,items:[{text,evidence:[{message_id:source.message_id,char_start:start,char_end:start+text.length}]}]};
 });
 const respond=f.normal.respond;
 f.normal.respond=async(request,input)=>{
  const result=await respond({...request,validateOutput:async()=>{}},input);
  if(request.purpose==='extraction')return result;
  const payload=JSON.parse(request.user),value=JSON.parse(result.blocks[0].arguments);
  for(const [index,candidate] of payload.candidates.entries())if(candidate.conditions)
   value.results[index].condition_verification=candidate.conditions.items.map((item,index)=>({index,verdict:'supported',evidence:item.evidence}));
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 };
}

function conditionUpdateSupplier({supported=true}={}){
 const respond=adjudicationSupplier({action:'update'});
 return async(request,input)=>{
  const result=await respond({...request,validateOutput:async()=>{}},input),value=JSON.parse(result.blocks[0].arguments);
  if(request.purpose==='adjudication')value.decisions[0].relation.condition_changed=true;
  if(request.purpose==='relation_verification'){value.results[0].condition_changed=true;value.results[0].supported=supported;}
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 };
}

test('一条旧记忆和新补充可自动合并，保留双方来源、历史版本并可恢复',async t=>{
 const f=await adjudicationFixture(t);
 await f.extract(['我周末会骑车。'],{publish:true});
 const original=(await f.read()).memories[0];
 const mergedText='联系人周末会骑车，周六上午走河岸路线。';
 f.calls.length=0;f.setRespond(adjudicationSupplier({action:'merge',mergedText}));
 const runId=await f.extract(['我周六上午骑车走河岸路线。'],{publish:true});

 const merged=await f.read();
 assert.equal(merged.candidates.length,0,await diagnostic(f));
 assert.equal(merged.memories.length,1);
 const memory=merged.memories[0];
 assert.equal(memory.id,original.id);
 assert.equal(memory.current.versionNo,'2');
 assert.equal(memory.current.body,mergedText);
 assert.equal(memory.current.adoptionMode,'auto');
 assert.equal(memory.versions.find(version=>version.versionNo==='1').body,original.current.body);
 assert.deepEqual(new Set(memory.current.sources.map(source=>source.quote)),new Set(['我周末会骑车。','我周六上午骑车走河岸路线。']));
 assert.deepEqual(f.calls.map(call=>call.purpose),['adjudication','relation_verification','merge_verification']);

 await f.adjudication.publishRun(runId,f.contactId);
 assert.equal(f.calls.length,3,'同一已采纳候选不会再次调用模型');
 assert.deepEqual(await f.read(),merged);
 await f.management.decide({requestKey:'restore-single-parent-merge',action:'restore',memoryId:memory.id,
  expectedVersionNo:'2',expectedHeadRevision:memory.headRevision,restoredFromVersionNo:'1',expectedMergedParents:[]});
 const restored=(await f.read()).memories[0];
 assert.equal(restored.current.versionNo,'3');
 assert.equal(restored.current.body,original.current.body);
 assert.deepEqual(restored.current.sources.map(source=>source.quote),original.current.sources.map(source=>source.quote));
 await healthy(f);
});

test('来源明确的新有效期可自动更新，并由后续正式裁决读到新版本时间',async t=>{
 const f=await adjudicationFixture(t);
 f.setExtractionTransform(memory=>{memory.valid_at=memory.text.includes('2020')?'2020-01-01T00:00:00+08:00':memory.text.includes('2021')?'2021-01-01T00:00:00+08:00':null;});
 await f.extract(['我从2020年1月1日起长期住在高雄。'],{publish:true});
 const original=(await f.read()).memories[0];
 f.calls.length=0;f.setRespond(adjudicationSupplier({action:'update'}));
 await f.extract(['我从2021年1月1日起长期住在台南。'],{publish:true});

 const request=f.calls.find(call=>call.purpose==='adjudication').payload;
 assert.equal(request.new_memories[0].candidate.valid_at,'2021-01-01T00:00:00+08:00');
 assert.equal(request.existing_memories[0].valid_at,'2020-01-01T00:00:00+08:00');
 const updated=(await f.read()).memories[0];
 assert.equal(updated.id,original.id);
 assert.equal(updated.current.versionNo,'2',await diagnostic(f));
 assert.equal(updated.current.body,'联系人从2021年1月1日起长期住在台南。');
 assert.equal(updated.current.adoptionMode,'auto');
 assert.equal(updated.current.timeStatus,'eligible');
 assert.equal((await f.read()).candidates.length,0);

 f.calls.length=0;f.setRespond(adjudicationSupplier());
 await f.extract(['我长期偏好合成的其他活动。'],{publish:true});
 const later=f.calls.find(call=>call.purpose==='adjudication').payload.existing_memories.find(memory=>memory.memory_id===original.id);
 assert.equal(later.valid_at,'2021-01-01T00:00:00+08:00','后续正式模型输入沿新版本使用来源核实的有效期');
 await healthy(f);
});

test('同一事件从计划推进到已发生可自动更新，并保留原阶段与来源历史',async t=>{
 const f=await adjudicationFixture(t);verifiedEventSupplier(f);
 await f.extract(['我计划在2023-11-14T10:00:00+08:00参加骑行。'],{publish:true});
 const original=(await f.read()).memories[0];
 f.calls.length=0;f.setRespond(adjudicationSupplier({action:'update'}));
 await f.extract(['我已经在2023-11-14T10:00:00+08:00完成骑行。'],{publish:true});

 const request=f.calls.find(call=>call.purpose==='adjudication').payload;
 assert.equal(request.existing_memories[0].event.stage,'planned','旧计划须实际通过来源时间核验并进入比较池');
 assert.equal(request.new_memories[0].candidate.event.stage,'occurred','新进展须实际通过来源时间核验');
 assert.equal(request.new_memories[0].candidate.event.version,2);
 assert.equal(request.new_memories[0].candidate.event.occurrence_precision,'instant');
 const updated=(await f.read()).memories[0];
 assert.equal(updated.id,original.id);
 assert.equal(updated.current.versionNo,'2',await diagnostic(f));
 assert.equal(updated.current.body,'联系人已经在2023-11-14T10:00:00+08:00完成骑行。');
 assert.equal(updated.current.formationKind,'change');
 assert.equal(updated.versions.find(version=>version.versionNo==='1').body,original.current.body);
 assert.ok(updated.current.sources.some(source=>source.quote==='我已经在2023-11-14T10:00:00+08:00完成骑行。'));
 assert.equal((await f.read()).candidates.length,0);

 f.calls.length=0;f.setExtractionTransform(null);f.setRespond(adjudicationSupplier());
 await f.extract(['我长期保留一项无关的合成资料。'],{publish:true});
 const later=f.calls.find(call=>call.purpose==='adjudication').payload.existing_memories.find(memory=>memory.memory_id===original.id);
 assert.equal(later.event.stage,'occurred','后续正式裁决按新版本阶段比对，不回退到旧计划');
 assert.equal(later.event.occurrence_start,'2023-11-14T10:00:00+08:00');
 await healthy(f);
});

test('正常事件演化仍不能自动覆盖人工保护版本',async t=>{
 const f=await adjudicationFixture(t);verifiedEventSupplier(f);
 await f.extract(['我计划在2023-11-14T10:00:00+08:00参加骑行。'],{publish:true});
 const original=(await f.read()).memories[0];
 await f.management.decide({requestKey:'protect-event-evolution',action:'protect',memoryId:original.id,
  expectedVersionNo:'1',expectedHeadRevision:original.headRevision});
 f.setRespond(adjudicationSupplier({action:'update'}));
 await f.extract(['我已经在2023-11-14T10:00:00+08:00完成骑行。'],{publish:true});

 const view=await f.read();
 assert.equal(view.memories.length,1);
 assert.equal(view.memories[0].id,original.id);
 assert.equal(view.memories[0].current.versionNo,'1');
 assert.equal(view.memories[0].current.body,original.current.body);
 assert.equal(view.memories[0].manualProtection,true);
 assert.equal(view.candidates.length,1);
 assert.equal(view.candidates[0].pendingReason,'memory_protected');
 await healthy(f);
});

test('恢复事件旧版本后，后续正式裁决读回原计划阶段与时刻',async t=>{
 const f=await adjudicationFixture(t);verifiedEventSupplier(f);
 await f.extract(['我计划在2023-11-14T10:00:00+08:00参加骑行。'],{publish:true});
 const original=(await f.read()).memories[0];
 f.setRespond(adjudicationSupplier({action:'update'}));
 await f.extract(['我已经在2023-11-14T10:00:00+08:00完成骑行。'],{publish:true});
 const updated=(await f.read()).memories[0];
 assert.equal(updated.current.versionNo,'2');
 await f.management.decide({requestKey:'restore-event-before-probe',action:'restore',memoryId:updated.id,
  expectedVersionNo:'2',expectedHeadRevision:updated.headRevision,restoredFromVersionNo:'1',expectedMergedParents:[]});
 const restored=(await f.read()).memories[0];
 assert.equal(restored.current.versionNo,'3');
 assert.equal(restored.current.body,original.current.body);

 f.calls.length=0;f.setExtractionTransform(null);f.setRespond(adjudicationSupplier());
 await f.extract(['我长期保留另一项独立的合成资料。'],{publish:true});
 const later=f.calls.find(call=>call.purpose==='adjudication').payload.existing_memories.find(memory=>memory.memory_id===original.id);
 assert.equal(later.revision,'3');
 assert.equal(later.event?.stage,'planned','恢复正文时必须一起恢复原版本已核验的事件阶段，不能遗失结构化事实');
 assert.equal(later.event.occurrence_start,'2023-11-14T10:00:00+08:00');
 await healthy(f);
});

test('一条旧记忆和新事件进展可自动合并为保留前后阶段的完整叙述',async t=>{
 const f=await adjudicationFixture(t);verifiedEventSupplier(f);
 await f.extract(['我计划在2023-11-14T10:00:00+08:00参加骑行。'],{publish:true});
 const original=(await f.read()).memories[0];
 const mergedText='联系人原计划在2023-11-14T10:00:00+08:00参加骑行，后来确认已经完成该次骑行。';
 const respond=adjudicationSupplier({action:'merge',mergedText});
 f.calls.length=0;f.setRespond(async(request,input)=>{
  const result=await respond({...request,validateOutput:async()=>{}},input),value=JSON.parse(result.blocks[0].arguments);
  if(request.purpose==='adjudication')Object.assign(value.decisions[0].relation,{kind:'state_change',claim_changed:true});
  if(request.purpose==='relation_verification')value.results[0].claim_changed=true;
  const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(value)}];
  await request.validateOutput(blocks);return {blocks};
 });
 await f.extract(['我已经在2023-11-14T10:00:00+08:00完成骑行。'],{publish:true});

 const request=f.calls.find(call=>call.purpose==='adjudication').payload;
 assert.equal(request.existing_memories[0].event.stage,'planned');
 assert.equal(request.new_memories[0].candidate.event.stage,'occurred');
 const view=await f.read(),memory=view.memories[0];
 assert.equal(view.candidates.length,0,await diagnostic(f));
 assert.equal(view.memories.length,1);
 assert.equal(memory.id,original.id);
 assert.equal(memory.current.versionNo,'2');
 assert.equal(memory.current.body,mergedText);
 assert.equal(memory.current.adoptionMode,'auto');
 assert.equal(memory.versions.find(version=>version.versionNo==='1').body,original.current.body);
 assert.deepEqual(new Set(memory.current.sources.map(source=>source.quote)),new Set([
  '我计划在2023-11-14T10:00:00+08:00参加骑行。','我已经在2023-11-14T10:00:00+08:00完成骑行。']));
 assert.deepEqual(f.calls.map(call=>call.purpose),['adjudication','relation_verification','merge_verification']);
 await healthy(f);
});

for(const supported of [true,false])test(`来源核实的条件变化${supported?'可自动更新并供后续裁决使用':'在独立核验不支持时保留待定'}`,async t=>{
 const f=await adjudicationFixture(t);verifiedConditionSupplier(f);
 await f.extract(['我只有周末有空时才参加合成活动。'],{publish:true});
 const original=(await f.read()).memories[0];
 f.calls.length=0;f.setRespond(conditionUpdateSupplier({supported}));
 await f.extract(['我现在只在平日晚间有空时参加合成活动。'],{publish:true});

 const request=f.calls.find(call=>call.purpose==='adjudication').payload;
 assert.equal(request.existing_memories[0].conditions.items[0].text,'只有周末有空时');
 assert.equal(request.existing_memories[0].conditions.items[0].source_supported,true);
 assert.equal(request.new_memories[0].candidate.conditions.items[0].text,'只在平日晚间有空时');
 assert.equal(request.new_memories[0].candidate.conditions.items[0].source_supported,true);
 const view=await f.read(),memory=view.memories[0];
 assert.equal(memory.id,original.id);
 if(!supported){
  assert.equal(memory.current.versionNo,'1');
  assert.equal(memory.current.body,original.current.body);
  assert.equal(view.candidates.length,1);
  assert.equal(view.candidates[0].pendingReason,'memory_relation_unsupported');
 }else{
  assert.equal(memory.current.versionNo,'2',await diagnostic(f));
  assert.equal(memory.current.body,'联系人现在只在平日晚间有空时参加合成活动。');
  assert.equal(memory.current.adoptionMode,'auto');
  assert.equal(memory.versions.find(version=>version.versionNo==='1').body,original.current.body);
  assert.equal(view.candidates.length,0);

  f.calls.length=0;f.setExtractionTransform(null);f.setRespond(adjudicationSupplier());
  await f.extract(['我长期保留另一项独立资料。'],{publish:true});
  const later=f.calls.find(call=>call.purpose==='adjudication').payload.existing_memories.find(parent=>parent.memory_id===original.id);
  assert.equal(later.conditions.items[0].text,'只在平日晚间有空时');
  assert.equal(later.conditions.items[0].source_supported,true);
 }
 await healthy(f);
});
