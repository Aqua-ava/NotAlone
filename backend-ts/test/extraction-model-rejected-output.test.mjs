import test from 'node:test';
import assert from 'node:assert/strict';
import {ExtractionModelError} from '../src/memory/extraction/model.ts';
const rejected=blocks=>new ExtractionModelError('extraction_model_validation_failed',null,null,blocks);

test('校验拒绝保留完整原始参数副本，但错误JSON不暴露原文',()=>{
 const blocks=[{type:'tool-call',id:'synthetic-call',name:'SourceVerificationOutput',arguments:'{"results":[PRIVATE_SYNTHETIC_BROKEN'}];
 const error=rejected(blocks),snapshot=error.rejectedOutput;
 assert.deepEqual(snapshot.blocks,blocks);assert.equal(snapshot.truncated,false);assert.equal(snapshot.originalBlockCount,1);
 assert.equal(snapshot.originalBytes,Buffer.byteLength(JSON.stringify(blocks)));
 blocks[0].arguments='changed';assert.equal(snapshot.blocks[0].arguments,'{"results":[PRIVATE_SYNTHETIC_BROKEN');
 assert.equal(Object.hasOwn(error,'rejectedOutput'),true);assert.equal(Object.keys(error).includes('rejectedOutput'),false);
 assert.doesNotMatch(JSON.stringify(error),/PRIVATE_SYNTHETIC_BROKEN|rejectedOutput/);assert.doesNotMatch(error.message,/PRIVATE_SYNTHETIC_BROKEN/);
});

test('拒绝快照最多16块和256KiB，超限参数只截取原文前缀',()=>{
 const raw=('合成😀\\\n"').repeat(100_000),blocks=[{type:'tool-call',id:'synthetic-call',name:'SourceVerificationOutput',arguments:raw}];
 const snapshot=rejected(blocks).rejectedOutput;
 assert.equal(snapshot.truncated,true);assert.equal(snapshot.originalBytes,Buffer.byteLength(JSON.stringify(blocks)));
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=256*1024);assert.ok(snapshot.blocks[0].arguments.length>0);
 assert.ok(raw.startsWith(snapshot.blocks[0].arguments));assert.ok(!snapshot.blocks[0].arguments.endsWith('\uD83D'),'不拆开Unicode代理对');
 const many=rejected(Array.from({length:20},(_,i)=>({type:'text',text:`合成${i}`}))).rejectedOutput;
 assert.equal(many.blocks.length,16);assert.equal(many.originalBlockCount,20);assert.equal(many.truncated,true);
});

test('成功以外的普通模型故障和未知调用都不携带拒绝输出',()=>{
 for(const code of ['extraction_model_call_failed','extraction_model_ack_unknown','extraction_model_cancelled']){
  const error=new ExtractionModelError(code,null,null,[{type:'text',text:'PRIVATE_SYNTHETIC'}]);
  assert.equal(error.rejectedOutput,undefined);assert.equal(Object.hasOwn(error,'rejectedOutput'),false);
 }
});
