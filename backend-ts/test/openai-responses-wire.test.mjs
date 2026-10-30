import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpenAIResponsesRequest,measureOpenAIResponsesRequest,OPENAI_RESPONSES_MODEL} from '../src/platform/models/openai-responses-wire.ts';

const binding={provider:'notalone-openai',model:OPENAI_RESPONSES_MODEL,maxTokens:1024,reasoningEffort:'off',toolChoice:'any'};
const profile={context_window_tokens:400000,safety_margin_tokens:10000};
function request(){return {provider:binding.provider,model:binding.model,maxTokens:binding.maxTokens,reasoningEffort:'off',
  system:'只处理当前联系人',messages:[{role:'user',content:[{type:'text',text:'你好'}]},
    {role:'assistant',content:[{type:'tool-call',id:'call_1',name:'lookup',arguments:'{"q":"近况"}'}]},
    {role:'tool',toolCallId:'call_1',content:[{type:'text',text:'合成资料'}]}],
  tools:[{name:'lookup',description:'查询资料',parameters:{type:'object',properties:{q:{type:'string'}}}}]};}

test('只生成无服务端存储的文字请求并保留工具调用顺序',()=>{
  const body=buildOpenAIResponsesRequest(request(),binding);
  assert.equal(body.store,false);
  assert.deepEqual(body.input,[{role:'system',content:'只处理当前联系人'},{role:'user',content:'你好'},
    {type:'function_call',call_id:'call_1',name:'lookup',arguments:'{"q":"近况"}'},
    {type:'function_call_output',call_id:'call_1',output:'合成资料'}]);
  assert.equal(body.tool_choice,'required');
  const measured=measureOpenAIResponsesRequest(body,binding,profile);
  assert.equal(measured.serialized_bytes,Buffer.byteLength(JSON.stringify(body)));
  assert.equal(measured.measurement_kind,'approximate');
});

test('拒绝图像、未绑定模型和超预算请求',()=>{
  const image=request(); image.messages[0].content.push({type:'image',attachment:{}});
  assert.throws(()=>buildOpenAIResponsesRequest(image,binding),{code:'reply_budget_unavailable'});
  assert.throws(()=>buildOpenAIResponsesRequest({...request(),model:'other'},binding),{code:'reply_budget_unavailable'});
  const body=buildOpenAIResponsesRequest(request(),binding);
  assert.throws(()=>measureOpenAIResponsesRequest(body,binding,{context_window_tokens:1100,safety_margin_tokens:100}),{code:'reply_budget_exceeded'});
  assert.throws(()=>measureOpenAIResponsesRequest({...body,store:true},binding,profile),{code:'reply_budget_unavailable'});
  assert.throws(()=>buildOpenAIResponsesRequest(request(),{...binding,toolChoice:{name:'unknown'}}),{code:'reply_budget_unavailable'});
  const cyclic=request();cyclic.tools[0].parameters.properties.self=cyclic.tools[0].parameters;
  assert.throws(()=>buildOpenAIResponsesRequest(cyclic,binding),{code:'reply_budget_unavailable'});
});
