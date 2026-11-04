import assert from 'node:assert/strict';
import test from 'node:test';
import {parseReplyOutput} from '../src/reply/sqlite/candidates/versions.ts';

const candidate={parts:['第一条','第二条'],basis:[1,2]};
const code=(text)=>{try{parseReplyOutput(text);}catch(error){return error.code;}return undefined;};

test('候选输出顶层多出说明字段时忽略该字段，候选照常解析', () => {
  const output=parseReplyOutput(JSON.stringify({candidates:[candidate],note:'模型附带的说明'}));
  assert.deepEqual(output,[{parts:['第一条','第二条'],basis:[1,2]}]);
});

test('候选输出缺少候选数组、顶层不是对象或候选数量越界时仍拒绝', () => {
  assert.equal(code('{"note":"没有候选"}'),'reply_output_invalid');
  assert.equal(code('[]'),'reply_output_invalid');
  assert.equal(code('null'),'reply_output_invalid');
  assert.equal(code('not json'),'reply_output_invalid');
  assert.equal(code(JSON.stringify({candidates:[]})),'reply_output_invalid');
  assert.equal(code(JSON.stringify({candidates:Array.from({length:6},()=>candidate)})),'reply_output_invalid');
});

test('单个候选内部多出字段或依据无效时仍拒绝', () => {
  assert.equal(code(JSON.stringify({candidates:[{...candidate,extra:1}]})),'reply_output_invalid');
  assert.equal(code(JSON.stringify({candidates:[{parts:['甲'],basis:[]}]})),'reply_output_invalid');
  assert.equal(code(JSON.stringify({candidates:[{parts:['甲'],basis:[1,1]}]})),'reply_output_invalid');
});
