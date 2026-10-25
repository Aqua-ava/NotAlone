import test from 'node:test';
import assert from 'node:assert/strict';
import {neutralizeTrace} from './neutral-trace.mjs';
test('E/V 的输入、原返回和判定全部进入中性包，运行身份只进私有绑定',()=>{
  const trace={case_id:'合成明确事实',scope:{owner_id:'00000000-0000-5000-a000-000000000001',contact_id:'00000000-0000-5000-a000-000000000002'},
    arm:'new',commit:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64',
    events:[{stage:'model_request',payload:{purpose:'memory_extraction',messages:[{role:'user',content:'联系人：我不吃香菜'}]}},
      {stage:'model_response',payload:{purpose:'memory_extraction',raw_output:{facts:[{text:'不吃香菜',subject:'contact'}]}}},
      {stage:'model_request',payload:{purpose:'source_verification',candidate:{text:'不吃香菜'},source_text:'联系人：我不吃香菜'}},
      {stage:'model_response',payload:{purpose:'source_verification',raw_output:{supported:true,quote:'我不吃香菜'}}},
      {stage:'adoption',payload:{adoption_method:'auto',status:'saved'}}]};
  const result=neutralizeTrace(trace);
  assert.equal(result.visible.events.length,5);assert.equal(result.visible.coverage.extraction_requests,1);
  assert.equal(result.visible.coverage.verification_responses,1);
  assert.equal(result.visible.events[3].data.raw_output.quote,'我不吃香菜');
  const named=neutralizeTrace({...trace,events:[{stage:'model_response',payload:{purpose:'memory_extraction',raw_output:{text:'用户学习TypeScript和LangChain。'}}}]});
  assert.equal(named.visible.events[0].data.raw_output.text,'用户学习TypeScript和LangChain。');
  const identifierText=neutralizeTrace({...trace,events:[{stage:'model_response',payload:{purpose:'memory_extraction',raw_output:{text:'编号00000000-0000-5000-a000-000000000001属于原话。'}}}]});
  assert.equal(identifierText.visible.events[0].data.raw_output.text,'编号00000000-0000-5000-a000-000000000001属于原话。');
  assert.doesNotMatch(JSON.stringify(result.visible),/4f89bb|00000000|"arm"|"commit"/);
  assert.equal(result.binding.commit,trace.commit);
  assert.throws(()=>neutralizeTrace({...trace,events:[...trace.events,{stage:'unknown_private_step',payload:{}}]}),/unmapped_trace_stage/);
});
