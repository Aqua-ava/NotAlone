import test from 'node:test';
import assert from 'node:assert/strict';
import {responseEnvelopeComplete} from '../experiments/reply-stream-completion.mjs';

const events=[
  {type:'message_start',message:{}},
  {type:'content_block_start',content_block:{type:'text'}},
  {type:'content_block_delta',delta:{type:'text_delta',text:'{"candidates":[]}'}},
  {type:'content_block_stop'},
  {type:'message_delta',delta:{stop_reason:'end_turn'}},
  {type:'message_stop'},
];
const sse=values=>values.map(value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');

test('完整SSE只认协议终态，正文像JSON也不等于业务成功',()=>{
  assert.equal(responseEnvelopeComplete('new',200,sse(events)),true);
});

test('半截SSE或流内错误保持未完整，不凭可拼接正文判成功',()=>{
  assert.equal(responseEnvelopeComplete('new',200,sse(events.slice(0,-1))),false);
  assert.equal(responseEnvelopeComplete('new',200,sse([
    events[0],
    {type:'error',error:{type:'synthetic'}},
    events.at(-1),
  ])),false);
  assert.equal(responseEnvelopeComplete('new',500,sse(events)),false);
});

test('旧协议只认DONE或非流式finish_reason',()=>{
  assert.equal(responseEnvelopeComplete('old',200,'data: {"choices":[]}\n\ndata: [DONE]\n\n'),true);
  assert.equal(responseEnvelopeComplete('old',200,JSON.stringify({choices:[{finish_reason:'stop'}]})),true);
  assert.equal(responseEnvelopeComplete('old',200,'data: {"choices":[{"finish_reason":null}]}\n\n'),false);
});
