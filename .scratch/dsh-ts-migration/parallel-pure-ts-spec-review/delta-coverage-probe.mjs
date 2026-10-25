/** 不断言提示文本，直接对比两版本的确定性候选结果；无真实调用或资料。 */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.env.NOTALONE_SPEC_DELTA_SOURCE;
if(!root)throw new Error('需要小delta私有双快照');
const before=await import(pathToFileURL(`${root}/base/backend-ts/src/extraction-flow.ts`).href);
const after=await import(pathToFileURL(`${root}/candidate/backend-ts/src/extraction-flow.ts`).href);
const owner='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222';
const question='33333333-3333-4333-8333-333333333333',answer='44444444-4444-4444-8444-444444444444';
const cases=[
 {name:'declared-question-omitted',text:'联系人需要调整安排。',messages:[
  {message_id:question,sender:'self',occurred_at:null,text:'合成：你说的是谁？'},
  {message_id:answer,sender:'contact',occurred_at:null,text:'合成：那个人需要调整安排。'}],sources:[question,answer],cited:[answer],expected:[1,0]},
 {name:'explicit-single-source',text:'联系人住在南区。',messages:[
  {message_id:answer,sender:'contact',occurred_at:null,text:'合成：我住在南区。'}],sources:[answer],cited:[answer],expected:[1,1]},
 {name:'complete-question-answer',text:'联系人住在南区。',messages:[
  {message_id:question,sender:'self',occurred_at:null,text:'合成：你住在哪一片？'},
  {message_id:answer,sender:'contact',occurred_at:null,text:'合成：南区。'}],sources:[question,answer],cited:[question,answer],expected:[1,1]},
 {name:'single-source-semantic-error-still-not-fixed',text:'联系人需要调整安排。',messages:[
  {message_id:answer,sender:'contact',occurred_at:null,text:'合成：同事需要调整安排。'}],sources:[answer],cited:[answer],expected:[1,1]},
];
const results=[];
for(const scenario of cases){
 const counts=[],modes=[],traces=[];
 for(const module of [before,after]){
  const events=[],fact={text:scenario.text,category:'common_fact',subject:'contact',topic:'other',source_message_ids:scenario.sources,confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成可复验主张。',event:null,conditions:null};
  const result=await module.runExtractionFlow({window:{owner_id:owner,contact_id:contact,target_message_ids:[answer],messages:scenario.messages},signal:new AbortController().signal,max_retries:0,retry_delay_ms:0,requireCurrent:async()=>{},record:async event=>events.push(event),
   invoke:async request=>({blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(request.purpose==='extraction'?{scenes:[{scene_name:'合成资料',memories:[fact]}]}:{results:[{candidate_index:0,verdict:'supported',issues:[],evidence:scenario.cited.map(id=>({message_id:id,quote:scenario.messages.find(message=>message.message_id===id).text}))}]})}]}),
  });
  assert.equal(result.failure_kind,null);assert.equal(result.extraction_completed,true);
  const event=events.find(event=>event.stage==='verification').payload;
  counts.push(result.accepted.length);modes.push(event.before.source_dependency_mode);traces.push({verdict:event.result.verdict,issues:event.result.issues,disposition:event.disposition,model_verdict:event.result.model_verdict});
 }
 assert.deepEqual(counts,scenario.expected);assert.deepEqual(modes,['any','any']);
 results.push({name:scenario.name,before_accepted:counts[0],after_accepted:counts[1],source_dependency_mode_unchanged:true,before_trace:traces[0],after_trace:traces[1]});
}
assert.deepEqual(results[0].after_trace.issues,['insufficient_evidence']);
console.log(JSON.stringify({base:'ff45f2ec296c4cead326d2ab6f3cf7770c9396ab',candidate:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64',physical_requests:0,synthetic_only:true,semantic_quality_not_approved:true,cases:results},null,2));
