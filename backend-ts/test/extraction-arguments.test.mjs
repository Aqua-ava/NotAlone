import test from 'node:test';
import assert from 'node:assert/strict';
import {readExtractionToolArguments} from '../src/extraction-arguments.ts';
const block=argumentsText=>[{type:'tool-call',name:'DirectMemoryExtractionOutput',arguments:argumentsText}];
test('原始工具参数拒绝重复键和截断，只允许白名单字段起引号及结构尾逗号修复',()=>{
 const read=raw=>readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{repair:true,field_names:['scenes']});
 assert.deepEqual(read('{scenes":[],}'),{value:{scenes:[]},repaired:true});
 assert.throws(()=>read('{"scenes":[],"scenes":[1]}'),{code:'extraction_arguments_invalid'});
 assert.throws(()=>read('{"scenes":[{"text":"截断'),{code:'extraction_arguments_invalid'});
 assert.throws(()=>read('{unknown":[]}'),{code:'extraction_arguments_invalid'});
 assert.throws(()=>read('{"scenes":[],"value":1e999}'),{code:'extraction_arguments_invalid'});
});
