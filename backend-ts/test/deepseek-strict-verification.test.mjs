import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepSeekStrictVerificationRequest,
  decodeDeepSeekStrictVerificationResponse,
  deepSeekStrictVerificationSchema,
} from '../src/memory/extraction/deepseek-strict-verification.ts';
import {buildSourceVerificationContract} from '../src/memory/extraction/extraction-protocol-contract.ts';
import {parseSourceVerification} from '../src/memory/extraction/extraction-protocol.ts';
import {readExtractionToolArguments} from '../src/memory/extraction/extraction-arguments.ts';

const messageId='33333333-3333-4333-8333-333333333333';
const fact={text:'联系人有事爱直接打电话',category:'preference',subject:'contact',topic:'other',
  source_message_ids:[messageId],confidence:.9,risk_flags:[],valid_at:null,invalid_at:null,
  speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],
  interpretation_reason:'原话明确表达偏好',requires_all_sources:true,event:null,conditions:null};
const contract=buildSourceVerificationContract([fact],'nullable-proof-v3');

function visit(schema,path='$',result=[]){
  if(!schema||typeof schema!=='object')return result;
  result.push([path,schema]);
  if(schema.properties)for(const [key,value] of Object.entries(schema.properties))visit(value,`${path}.properties.${key}`,result);
  if(schema.items)visit(schema.items,`${path}.items`,result);
  if(schema.anyOf)for(const [index,value] of schema.anyOf.entries())visit(value,`${path}.anyOf[${index}]`,result);
  return result;
}

test('nullable-proof-v3转换为DeepSeek strict支持的关键字与对象闭合合同',()=>{
  const schema=deepSeekStrictVerificationSchema(contract.schema);
  const nodes=visit(schema);
  for(const [path,node] of nodes){
    assert.equal(Array.isArray(node.type),false,`${path} 仍含联合type`);
    assert.equal(Object.hasOwn(node,'oneOf'),false,`${path} 仍含oneOf`);
    for(const key of ['minLength','maxLength','minItems','maxItems'])assert.equal(Object.hasOwn(node,key),false,`${path} 含不支持关键字 ${key}`);
    if(node.type==='object'&&node.properties){
      assert.equal(node.additionalProperties,false,`${path} 未闭合`);
      assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort(),`${path} 未将全部对象字段设为required`);
    }
  }
  const proof=schema.properties.results.items.properties.proof;
  assert.deepEqual(proof.anyOf.map(item=>item.type),['object','null']);
  const atoms=proof.anyOf[0].properties.atom_links;
  assert.deepEqual(atoms.anyOf.map(item=>item.type),['array','null']);
  assert.ok(atoms.anyOf[0].items.anyOf.length>1);
});

test('只构造SourceVerificationOutput的Beta Chat Completions strict请求并能解码唯一工具结果',()=>{
  const request=buildDeepSeekStrictVerificationRequest({
    model:'deepseek-flash',system:'合成核验提示',user:'{"results":[]}',
    tool:{name:'SourceVerificationOutput',description:'合成核验',parameters:contract.schema},
    maxTokens:512,temperature:0,reasoningEffort:'off',
  });
  assert.equal(request.endpoint,'https://api.deepseek.com/beta/chat/completions');
  assert.equal(request.body.stream,false);
  assert.deepEqual(request.body.tool_choice,{type:'function',function:{name:'SourceVerificationOutput'}});
  assert.equal(request.body.tools.length,1);
  assert.deepEqual(request.body.tools[0].function,{
    name:'SourceVerificationOutput',description:'合成核验',
    parameters:deepSeekStrictVerificationSchema(contract.schema),strict:true,
  });
  assert.deepEqual(request.body.messages,[
    {role:'system',content:'合成核验提示'},
    {role:'user',content:'{"results":[]}'},
  ]);
  const decoded=decodeDeepSeekStrictVerificationResponse({
    id:'synthetic-response',
    choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[
      {id:'synthetic-call',type:'function',function:{name:'SourceVerificationOutput',
        arguments:'{"results":[{"candidate_index":0,"verdict":"supported","issues":[],"evidence":[],"proof":null}]}'}},
    ]}}],
    usage:{prompt_tokens:21,completion_tokens:13,prompt_cache_hit_tokens:4,prompt_cache_miss_tokens:17},
  });
  assert.equal(decoded.success,true);
  assert.deepEqual(decoded.blocks,[{type:'tool-call',id:'synthetic-call',name:'SourceVerificationOutput',
    arguments:'{"results":[{"candidate_index":0,"verdict":"supported","issues":[],"evidence":[],"proof":null}]}'}]);
  assert.deepEqual(decoded.usage,{input_tokens:21,output_tokens:13,cache_read_tokens:4,cache_write_tokens:null});
});

test('strict工具结果中的supported与proof:null通过现有nullable-proof-v3解析器',()=>{
  const response={id:'synthetic-response',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
    tool_calls:[{id:'synthetic-call',type:'function',function:{name:'SourceVerificationOutput',
      arguments:JSON.stringify({results:[{candidate_index:0,verdict:'supported',issues:[],
        evidence:[{message_id:messageId,quote:'有事爱直接打电话'}],proof:null}]})}}]}}],
  usage:{prompt_tokens:21,completion_tokens:13}};
  const decoded=decodeDeepSeekStrictVerificationResponse(response);
  const argumentsValue=readExtractionToolArguments(decoded.blocks,'SourceVerificationOutput',{repair:false}).value;
  const window={owner_id:'11111111-1111-4111-8111-111111111111',
    contact_id:'22222222-2222-4222-8222-222222222222',
    messages:[{message_id:messageId,text:'有事爱直接打电话',sender:'contact',
      occurred_at:'2024-02-01T00:00:00Z',text_representation:'text'}],target_message_ids:[messageId]};
  const result=parseSourceVerification(argumentsValue,window,[fact],{isolate_items:true,mode:'nullable-proof-v3'});
  assert.equal(result.length,1);
  assert.equal(result[0].verdict,'supported');
  assert.equal(result[0].model_verdict,'supported');
  assert.equal(result[0].proof,null);
  assert.deepEqual(result[0].model_issues,[]);
});
