import test from 'node:test';
import assert from 'node:assert/strict';
import {readExtractionToolArguments} from '../src/memory/extraction/extraction-arguments.ts';
const block=argumentsText=>[{type:'tool-call',name:'DirectMemoryExtractionOutput',arguments:argumentsText}];
test('原始工具参数拒绝重复键和截断，只允许白名单字段起引号及结构尾逗号修复',()=>{
 const read=raw=>readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{repair:true,field_names:['scenes']});
 assert.deepEqual(read('{scenes":[],}'),{value:{scenes:[]},repaired:true});
 assert.throws(()=>read('{"scenes":[],"scenes":[1]}'),{code:'extraction_arguments_invalid'});
 assert.throws(()=>read('{"scenes":[{"text":"截断'),{code:'extraction_arguments_invalid'});
 assert.throws(()=>read('{unknown":[]}'),{code:'extraction_arguments_invalid'});
 assert.throws(()=>read('{"scenes":[],"value":1e999}'),{code:'extraction_arguments_invalid'});
});

test('唯一根数组只由调用点显式映射为命名包络',()=>{
 const raw=JSON.stringify([{candidate_index:0,verdict:'supported',issues:[],evidence:[]}]);
 assert.throws(()=>readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{repair:true}),{
  code:'extraction_arguments_invalid',
 });
 assert.deepEqual(readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{
  repair:true,root_array_key:'results',
 }),{value:{results:JSON.parse(raw)},repaired:true});
});
