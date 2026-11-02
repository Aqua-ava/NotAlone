import test from 'node:test';
import assert from 'node:assert/strict';
import {readExtractionToolArguments} from '../src/memory/extraction/arguments.ts';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';
const name='DirectMemoryExtractionOutput',id='33333333-3333-4333-8333-333333333333';
const window={owner_id:'11111111-1111-4111-8111-111111111111',contact_id:'22222222-2222-4222-8222-222222222222',target_message_ids:[id],messages:[{message_id:id,sender:'contact',occurred_at:null,text:'合成来源。',text_representation:'text'}]};
async function run(blocks){
 const events=[],calls=[];
 const result=await runExtractionFlow({window,signal:new AbortController().signal,max_retries:0,requireCurrent:async()=>{},record:async e=>events.push(e),
  invoke:async request=>{calls.push(request.purpose);await request.validateOutput(blocks);return {blocks};}});
 return {result,events,calls};
}

test('仅提取入口显式归一唯一文本JSON，原始JSON与围栏JSON均走原解码器',async()=>{
 for(const text of ['{"scenes":[]}','```json\n{"scenes":[]}\n```']){
  const blocks=[{type:'text',text}],output=await run(blocks);
  assert.equal(output.result.failure_kind,null);assert.equal(output.result.extraction_completed,true);assert.deepEqual(output.calls,['extraction']);
  assert.equal(output.events.find(e=>e.stage==='extraction_return').payload.repaired,true);
  assert.deepEqual(readExtractionToolArguments(blocks,name,{repair:true,allow_text_json:true}),{value:{scenes:[]},repaired:true});
 }
});

test('默认reader及来源核验仍要求具名工具，不把文本输出全局放行',()=>{
 const blocks=[{type:'text',text:'{"results":[]}'}];
 assert.throws(()=>readExtractionToolArguments(blocks,'SourceVerificationOutput',{repair:true}),{code:'extraction_arguments_invalid'});
 assert.throws(()=>readExtractionToolArguments([{type:'text',text:'{"scenes":[]}'}],name,{repair:true}),{code:'extraction_arguments_invalid'});
});

test('多个文本、错名工具、已有工具以及非文本附加块不触发文本回退',()=>{
 const text={type:'text',text:'{"scenes":[]}'},read=blocks=>readExtractionToolArguments(blocks,name,{repair:true,allow_text_json:true});
 for(const blocks of [[text,text],[text,{type:'image',data:'synthetic'}],[text,{type:'tool-call',name:'WrongTool',arguments:'{}'}],[text,{type:'tool-call',name,arguments:'BROKEN'}]])assert.throws(()=>read(blocks),{code:'extraction_arguments_invalid'});
 assert.deepEqual(read([{type:'reasoning',text:'合成推理'},text]),{value:{scenes:[]},repaired:true});
});

test('文本归一仍拒绝重复键、截断、根数组和缺失scenes，不猜补字段',async()=>{
 for(const text of ['{"scenes":[],"scenes":[]}','{"scenes":[','[]','{}']){
  const output=await run([{type:'text',text}]);assert.equal(output.result.failure_kind,'invalid_output');assert.deepEqual(output.result.accepted,[]);
 }
});

test('文本JSON中的越界来源仍逐项拒绝，不增加候选或来源权限',async()=>{
 const fact={text:'合成事实',subject:'contact',category:'common_fact',topic:'other',source_message_ids:['44444444-4444-4444-8444-444444444444'],confidence:0.8,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成理由',event:null,conditions:null};
 const output=await run([{type:'text',text:JSON.stringify({scenes:[{scene_name:'合成',memories:[fact]}]})}]);
 assert.equal(output.result.failure_kind,null);assert.equal(output.result.rejected_count,1);assert.deepEqual(output.result.accepted,[]);assert.deepEqual(output.calls,['extraction']);
});
