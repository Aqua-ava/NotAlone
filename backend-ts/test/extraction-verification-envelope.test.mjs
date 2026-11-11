import test from 'node:test';
import assert from 'node:assert/strict';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';
import {verificationPolicy,completeClaimRow} from './fixtures/complete-claim-response.mjs';
import {canonicalJSON} from '../src/memory/evidence/canonical-json.ts';

const owner='11111111-1111-4111-8111-111111111111';
const contact='22222222-2222-4222-8222-222222222222';
const message='33333333-3333-4333-8333-333333333333';
const window={owner_id:owner,contact_id:contact,messages:[
  {message_id:message,text:'PRIVATE_DIAGNOSTIC_SENTINEL',sender:'contact',occurred_at:'2024-02-01T00:00:00Z',text_representation:'text'},
],target_message_ids:[message]};
const fact={text:'PRIVATE_DIAGNOSTIC_SENTINEL',category:'relationship_note',subject:'contact',topic:'other',
  source_message_ids:[message],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',
  assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'PRIVATE_REASON_SENTINEL'};
const verificationRow=completeClaimRow(fact,{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'PRIVATE_DIAGNOSTIC_SENTINEL'}]},window);
const reply=(name,args)=>({blocks:[{type:'tool-call',name,arguments:args}],receipt:{outcome:'succeeded'}});

async function runWithVerificationReply(verificationBlocks){
  const events=[];
  const result=await runExtractionFlow({window,verificationPolicy,signal:new AbortController().signal,max_retries:0,retry_delay_ms:0,
    requireCurrent:async()=>{},record:async event=>{events.push(event);},
    invoke:async request=>{
      if(request.purpose==='extraction')
        return reply('DirectMemoryExtractionOutput',JSON.stringify({scenes:[{scene_name:'合成场景',memories:[fact]}]}));
      await request.validateOutput(verificationBlocks);
      return {blocks:verificationBlocks};
    },
  });
  return {result,events};
}

test('V验证闭包失败记录脱敏结构且不伪造verification_return',async()=>{
  const blocks=[{type:'tool-call',name:'SourceVerificationOutput',
    arguments:JSON.stringify({result:[verificationRow]})}];
  const {result,events}=await runWithVerificationReply(blocks);
  assert.equal(result.failure_kind,'invalid_output');
  assert.equal(events.some(event=>event.stage==='verification_return'),false);
  const event=events.find(event=>event.stage==='verification_validation_failure');
  assert.deepEqual(event?.payload,{
    failure_kind:'invalid_output',classification:'root_keys_mismatch',
    block_types:['tool-call'],tool_names:['SourceVerificationOutput'],
    arguments_parseable:true,json_root_type:'object',json_root_keys:['<other>'],
    results_type:'unavailable',results_count:null,
    rows:[{keys:['<other>','candidate_index','evidence','issues','verdict'],candidate_index:0,verdict:'supported',evidence_count:1}],
  });
  assert.equal(canonicalJSON(event?.payload).includes('PRIVATE_'),false);
});

test('V仅恢复可确定的JSON语法与顶层results包络',async()=>{
  const wrapped=JSON.stringify({results:[verificationRow]});
  for(const argumentsText of [
    wrapped,
    '```json\n'+wrapped+'\n```',
    ' {results":['+JSON.stringify(verificationRow)+'],} ',
    JSON.stringify([verificationRow]),
  ]){
    const {result,events}=await runWithVerificationReply([
      {type:'tool-call',name:'SourceVerificationOutput',arguments:argumentsText},
    ]);
    assert.equal(result.failure_kind,null);
    assert.equal(result.extraction_completed,true);
    assert.equal(result.accepted.length,1);
    assert.equal(events.some(event=>event.stage==='verification_validation_failure'),false);
  }
});

test('V缺call、错call与错误wrap仍失败并给出稳定分类',async()=>{
  const wrapped=JSON.stringify({results:[verificationRow]});
  for(const [expected,blocks,classification] of [
    ['missing_tool_call',[{type:'text',text:'PRIVATE_MODEL_TEXT'}],'missing_tool_call'],
    ['arguments_not_json',[{type:'tool-call',name:'SourceVerificationOutput',arguments:'{"results":['}],
      'arguments_not_json'],
    ['wrong_tool_name',[{type:'tool-call',name:'WrongVerificationOutput',arguments:wrapped}],'wrong_tool_name'],
    ['root_keys_mismatch',[{type:'tool-call',name:'SourceVerificationOutput',
      arguments:JSON.stringify({result:[verificationRow]})}],'root_keys_mismatch'],
    ['results_not_array',[{type:'tool-call',name:'SourceVerificationOutput',
      arguments:JSON.stringify({results:{0:verificationRow}})}],'results_not_array'],
  ]){
    const {result,events}=await runWithVerificationReply(blocks);
    assert.equal(result.failure_kind,'invalid_output',expected);
    assert.deepEqual(result.accepted,[],expected);
    const event=events.find(value=>value.stage==='verification_validation_failure');
    assert.equal(event?.payload.classification,classification,expected);
    assert.equal(canonicalJSON(event?.payload).includes('PRIVATE_'),false,expected);
  }
});

test('V合法包络中的非原文引文仍逐项拒绝而不写入候选',async()=>{
  const {result,events}=await runWithVerificationReply([
    {type:'tool-call',name:'SourceVerificationOutput',arguments:JSON.stringify({results:[{
      ...verificationRow,evidence:[{message_id:message,quote:'不在原消息中的引文'}],
    }]})},
  ]);
  assert.equal(result.failure_kind,null);
  assert.deepEqual(result.accepted,[]);
  assert.equal(result.rejected_count,1);
  assert.equal(events.some(event=>event.stage==='verification_validation_failure'),false);
  assert.equal(events.find(event=>event.stage==='verification')?.payload.disposition,'unsupported_rejected');
});

test('V失败诊断写入失败阻止本批且不伪装成模型不可用',async()=>{
  let calls=0;
  const blocks=[{type:'tool-call',name:'SourceVerificationOutput',
    arguments:JSON.stringify({result:[verificationRow]})}];
  await assert.rejects(runExtractionFlow({window,verificationPolicy,signal:new AbortController().signal,max_retries:0,retry_delay_ms:0,
    requireCurrent:async()=>{},
    record:async event=>{
      if(event.stage==='verification_validation_failure')
        throw Object.assign(new Error('合成追踪失败'),{code:'trace_write_failed'});
    },
    invoke:async request=>{
      calls++;
      if(request.purpose==='extraction')
        return reply('DirectMemoryExtractionOutput',JSON.stringify({scenes:[{scene_name:'合成场景',memories:[fact]}]}));
      await request.validateOutput(blocks);
      return {blocks};
    },
  }),{code:'trace_write_failed'});
  assert.equal(calls,2);
});
