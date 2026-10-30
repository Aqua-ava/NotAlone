import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenAIResponsesAdapter,decodeOpenAIResponse} from '../src/platform/models/openai-adapter.ts';
import {OPENAI_RESPONSES_MODEL,OPENAI_RESPONSES_ENDPOINT} from '../src/platform/models/openai-responses-wire.ts';

const binding={provider:'notalone-openai',model:OPENAI_RESPONSES_MODEL,maxTokens:100,reasoningEffort:'off'};
const options={...binding,signal:new AbortController().signal,messages:[{role:'user',content:[{type:'text',text:'合成消息'}]}]};
const response={status:'completed',output:[{type:'function_call',call_id:'call_1',name:'lookup',arguments:'{"id":1}'}],
  usage:{input_tokens:20,output_tokens:5,input_tokens_details:{cached_tokens:4}}};

test('发送前守卫获准后调用固定地址并转换工具和用量',async()=>{
  let seen=false;
  const adapter=new OpenAIResponsesAdapter({key:'synthetic-key',guard:async (_options,build)=>build(binding),fetch:async (url,init)=>{
    seen=true;assert.equal(url,OPENAI_RESPONSES_ENDPOINT);assert.equal(init.redirect,'error');
    assert.equal(JSON.parse(init.body).store,false);
    return new Response(JSON.stringify(response),{status:200});
  }});
  const chunks=[];for await(const chunk of adapter.stream(options))chunks.push(chunk);
  assert.equal(seen,true);
  assert.equal(chunks.find(chunk=>chunk.type==='tool-call-delta').name,'lookup');
  assert.deepEqual(chunks.find(chunk=>chunk.type==='usage').usage,{inputTokens:16,outputTokens:5,cacheReadTokens:4});
  assert.equal(chunks.at(-1).reason.kind,'tool-calls');
});

test('守卫拒绝时不发送；不完整或不合法结果失败关闭',async()=>{
  let sent=false;
  const adapter=new OpenAIResponsesAdapter({key:'synthetic-key',guard:async()=>{throw Error('denied');},fetch:async()=>{sent=true;throw Error();}});
  await assert.rejects(async()=>{for await(const _ of adapter.stream(options)){}},/denied/);
  assert.equal(sent,false);
  assert.throws(()=>decodeOpenAIResponse({...response,status:'incomplete'}),{code:'INVALID_RESPONSE'});
  assert.throws(()=>decodeOpenAIResponse({...response,output:[{type:'function_call',call_id:'x',name:'f',arguments:'{'}]}),{code:'INVALID_RESPONSE'});
});
