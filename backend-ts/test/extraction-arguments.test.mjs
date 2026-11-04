import test from 'node:test';
import assert from 'node:assert/strict';
import {readExtractionToolArguments} from '../src/memory/extraction/arguments.ts';
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

test('多余收尾括号只在显式选项下丢弃，已解析的值原样保留',()=>{
 const strict=raw=>readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{});
 const drop=(raw,extra={})=>readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{drop_stray_closers:true,...extra});
 const body='{"results":[{"a":"含}和]的文字"}],"n":1}';
 // 默认保持严格：完整值后的任何尾随字符都拒绝。
 for(const tail of ['}',']}','} ','}}}'])assert.throws(()=>strict(body+tail),{code:'extraction_arguments_invalid'});
 for(const tail of ['}',']}',' } ','\n}\n','}}','] ]}','}}}']){
  const decoded=drop(body+tail);
  assert.deepEqual(decoded,{value:JSON.parse(body),repaired:true});
 }
 // 未多余时不标记修复。
 assert.deepEqual(drop(body),{value:JSON.parse(body),repaired:false});
 // 与既有尾逗号修复可叠加，且仍受修复开关控制。
 assert.deepEqual(drop('{scenes":[],}}',{repair:true,field_names:['scenes']}),{value:{scenes:[]},repaired:true});
 assert.throws(()=>drop('{"scenes":[],}}'),{code:'extraction_arguments_invalid'});
});

test('丢弃多余收尾括号不放过截断、重复键、额外内容或过长尾部',()=>{
 const drop=raw=>readExtractionToolArguments(block(raw),'DirectMemoryExtractionOutput',{drop_stray_closers:true});
 for(const raw of [
  '{"a":1}}}}}',                // 超过三个收尾括号
  '{"a":1}}x',                  // 括号后仍有其他内容
  '{"a":1}},{"b":2}',           // 多个根值
  '{"a":1} {"b":2}',            // 第二个值不是收尾括号
  '{"a":"截断',                  // 字符串未结束，尾部为空
  '{"a":[1,2',                  // 结构未闭合
  '{"a":1,"a":2}}',             // 前缀内的重复键仍拒绝
  '{"a":1}\u0000}',             // 控制字符不是空白
  '}',                          // 没有完整值
  '{"a":1}]]]]',
 ])assert.throws(()=>drop(raw),{code:'extraction_arguments_invalid'},raw);
 // 根数组仍需调用点显式映射；丢弃尾部不改变这条规则。
 assert.throws(()=>drop('[]]'),{code:'extraction_arguments_invalid'});
 assert.deepEqual(readExtractionToolArguments(block('[]]'),'DirectMemoryExtractionOutput',{drop_stray_closers:true,root_array_key:'results'}),{value:{results:[]},repaired:true});
});
