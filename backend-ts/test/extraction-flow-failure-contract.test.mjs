import test from 'node:test';
import assert from 'node:assert/strict';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';
import {resolveExtractionPolicy} from '../src/memory/extraction/policy-version.ts';

const message='33333333-3333-4333-8333-333333333333',text='合成联系人喜欢绿茶。';
const window={owner_id:'11111111-1111-4111-8111-111111111111',contact_id:'22222222-2222-4222-8222-222222222222',
  target_message_ids:[message],messages:[{message_id:message,sender:'contact',occurred_at:null,
    message_type:'text',text_representation:'text',text}]};
const memory={text,subject:'contact',category:'preference',topic:'other',source_message_ids:[message],confidence:0.8,risk_flags:[],
  valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',
  alternatives:[],interpretation_reason:'仅用于合成失败合同回归。',event:null,conditions:null};
const stamp='a'.repeat(64),policies=[
  ['v2',resolveExtractionPolicy({version:2,mode:'legacy',rule_set_sha256:null,verification_policy:'complete-claim-v1',source_stamp:stamp},stamp,stamp).verification],
];

function scenario(policy,count,{malformed=false,cancelAtLastParse=false,failVerificationTrace=false}={}){
  const controller=new AbortController(),calls=[],events=[];
  const memories=Array.from({length:count},()=>({...memory}));if(malformed)memories.push(null);
  let parsed=0;
  const options={window,signal:controller.signal,max_retries:0,retry_delay_ms:0,verificationPolicy:policy??policies[0][1],
    requireCurrent:async()=>{},record:async event=>{
      events.push(event);
      if(event.stage==='parse'&&++parsed===memories.length&&cancelAtLastParse)controller.abort();
      if(event.stage==='verification_input'&&failVerificationTrace)
        throw Object.assign(new Error('合成追踪故障'),{code:'trace_write_failed'});
    },invoke:async request=>{
      calls.push(request.purpose);let args;
      if(request.purpose==='extraction')args={scenes:[{scene_name:'合成场景',memories}]};
      else{
        const payload=JSON.parse(request.user),modern=payload.check_format==='local-ids-v3';
        const facet={verdict:'supported',evidence_indices:[0]};
        args={results:Array.from({length:count},(_,candidate_index)=>({
          candidate_index,verdict:'supported',issues:[],evidence:[{message_id:message,quote:text}],
          ...(modern?{claim_check:{version:2,field_checks:Object.fromEntries(['category','topic','scene_name','alternatives','interpretation_reason',
            'valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'].map(name=>[name,facet])),
            parts:[{candidate_span:{start:0,end:[...text].length},
            attribution:{...facet,scope_subject:'contact',actor_kind:'third_party',resolution:'explicit',
              subject_mentions:[{kind:'literal_subject',evidence_index:0,source_span:{start:0,end:5},candidate_span:{start:0,end:5}}]},
            arguments_and_relation:facet,temporal_and_modality:facet}]}}:{}),
        }))};
      }
      const blocks=[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify(args)}];
      await request.validateOutput(blocks);return {blocks};
    }};
  return {run:()=>runExtractionFlow(options),calls,events};
}

test('61条合法direct候选在现行v2完整命题核验均归一invalid_output，E1/V0',async()=>{
  for(const [name,policy] of policies){
    const x=scenario(policy,61),result=await x.run();
    assert.equal(result.failure_kind,'invalid_output',name);assert.equal(result.extraction_completed,true,name);
    assert.deepEqual(result.accepted,[]);assert.deepEqual(result.candidate_trace_ids,[]);
    assert.equal(result.rejected_count,0);assert.deepEqual(result.verification,[]);
    assert.equal(result.failure_reason,'模型输出未通过提取或来源核验，本批未写入记忆。');
    assert.deepEqual(x.calls,['extraction'],name);
  }
});

test('准备失败保留已解析的结构拒绝计数，不重试E或进入V',async()=>{
  const x=scenario(undefined,61,{malformed:true}),result=await x.run();
  assert.equal(result.failure_kind,'invalid_output');assert.equal(result.rejected_count,1);
  assert.deepEqual(x.calls,['extraction']);
});

test('准备阶段协议错误遇取消仍优先抛AbortError，E1/V0',async()=>{
  for(const policy of [policies[0][1]]){
    const x=scenario(policy,61,{cancelAtLastParse:true});
    await assert.rejects(x.run(),{name:'AbortError'});
    assert.deepEqual(x.calls,['extraction']);
  }
});

test('60条边界仍一次E一次V并保留有据候选',async()=>{
  for(const policy of [policies[0][1]]){
    const x=scenario(policy,60),result=await x.run();
    assert.equal(result.failure_kind,null);assert.equal(result.accepted.length,60);
    assert.equal(result.rejected_count,0);assert.deepEqual(x.calls,['extraction','verification']);
  }
});

test('verification_input追踪故障仍原样传播，E1/V0',async()=>{
  const x=scenario(undefined,1,{failVerificationTrace:true});
  await assert.rejects(x.run(),{code:'trace_write_failed'});
  assert.deepEqual(x.calls,['extraction']);
});
