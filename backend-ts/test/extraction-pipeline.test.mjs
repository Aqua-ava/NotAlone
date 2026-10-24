import test from 'node:test';
import assert from 'node:assert/strict';
import {planExtractionBatches,runExtractionPipeline} from '../src/extraction-pipeline.ts';

const scope={owner_id:'owner',contact_id:'contact'};
const messages=Array.from({length:8},(_,i)=>({...scope,message_id:`message-${i}`,occurred_at:i===7?null:`2026-10-24T00:00:0${i}Z`,text:`合成${i}`}));
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('后批先完成提取时仍按原批序提交且上下文不计目标',async()=>{
 const plans=planExtractionBatches({scope,messages,target_message_ids:['message-2','message-3','message-4','message-5'],batch_size:2});
 assert.deepEqual(plans[0].window.messages.map(m=>m.message_id),['message-0','message-1','message-2','message-3']);
 assert.deepEqual(plans[1].window.target_message_ids,['message-4','message-5']);
 const first=defer(),secondReady=defer(),writes=[];
 const run=runExtractionPipeline({plans,concurrency:2,signal:new AbortController().signal,
  requireCurrent:async()=>{},extract:async plan=>{if(plan.index===0)await first.promise;else secondReady.resolve();return {facts:plan.window.target_message_ids};},
  commit:async(plan,value)=>{writes.push([plan.index,value.facts]);return {status:'succeeded',watermark:plan.next_watermark,processed_messages:plan.target_count};},
  stopped:async()=>{},
 });
 await secondReady.promise;assert.deepEqual(writes,[]);first.resolve();
 const result=await run;
 assert.deepEqual(writes,[[0,['message-2','message-3']],[1,['message-4','message-5']]]);
 assert.equal(result.processed_messages,4);assert.equal(result.watermark,'message-5');
});

test('保留原20目标/单侧20上下文上限，冻结计划不能被执行器改写身份',async()=>{
 assert.throws(()=>planExtractionBatches({scope,messages,target_message_ids:['message-1'],batch_size:21}),{code:'extraction_plan_invalid'});
 assert.throws(()=>planExtractionBatches({scope,messages,target_message_ids:['message-1'],context_before:21}),{code:'extraction_plan_invalid'});
 const plans=planExtractionBatches({scope,messages,target_message_ids:['message-1']});
 await runExtractionPipeline({plans,concurrency:1,signal:new AbortController().signal,requireCurrent:async()=>{},
  extract:async plan=>{assert.throws(()=>{plan.scope.contact_id='其他联系人';},TypeError);return null;},
  commit:async plan=>({status:'succeeded',watermark:plan.next_watermark,processed_messages:1}),stopped:async()=>{}});
});

test('失败水位保留已提交前批，后批在途实际排空后停止且不重复收尾失败批',async()=>{
 const plans=planExtractionBatches({scope,messages,target_message_ids:['message-1','message-2','message-3','message-4'],batch_size:1});
 const tail=defer(),entered=defer(),writes=[],stopped=[];let ended=false;
 const run=runExtractionPipeline({plans,concurrency:2,signal:new AbortController().signal,requireCurrent:async()=>{},
  extract:async plan=>{if(plan.index===2){entered.resolve();await tail.promise;}return plan.index;},
  commit:async plan=>{writes.push(plan.index);return {status:plan.index===1?'model_failed':'succeeded',watermark:plan.index===1?'message-1':plan.next_watermark,processed_messages:1};},
  stopped:async(plan,watermark)=>{stopped.push([plan.index,watermark]);}}).then(result=>{ended=true;return result;});
 await entered.promise;await Promise.resolve();assert.equal(ended,false);tail.resolve();
 const result=await run;assert.deepEqual(writes,[0,1]);assert.deepEqual(stopped,[[2,'message-1']]);
 assert.equal(result.status,'failed');assert.equal(result.watermark,'message-1');assert.equal(result.processed_messages,2);
});

test('提交前失去来源或租约资格时不采纳已返回的结果',async()=>{
 const plans=planExtractionBatches({scope,messages,target_message_ids:['message-1'],batch_size:1});
 const writes=[],stops=[];let checks=0;
 await assert.rejects(runExtractionPipeline({plans,concurrency:1,signal:new AbortController().signal,
  requireCurrent:async()=>{if(++checks===2)throw Object.assign(new Error('合成来源撤销'),{code:'source_stale'});},
  extract:async()=>({facts:['候选']}),commit:async()=>{writes.push(1);throw new Error('不应写入');},
  stopped:async(plan,watermark)=>{stops.push([plan.index,watermark]);}}),{code:'source_stale'});
 assert.deepEqual(writes,[]);assert.deepEqual(stops,[[0,null]]);
});
