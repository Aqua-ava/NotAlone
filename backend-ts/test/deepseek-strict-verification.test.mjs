import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepSeekStrictVerificationRequest,
  decodeDeepSeekStrictVerificationResponse,
  deepSeekStrictVerificationSchema,
} from '../src/platform/models/deepseek-strict.ts';
import {buildSourceVerificationContract} from '../src/memory/extraction/contract.ts';
import {prepareSourceVerification} from '../src/memory/extraction/verification/complete-claim.ts';
import {verificationPolicy,completeClaimRow} from './fixtures/complete-claim-response.mjs';

const messageId='33333333-3333-4333-8333-333333333333';
const fact={text:'联系人有事爱直接打电话',category:'preference',subject:'contact',topic:'other',
  source_message_ids:[messageId],confidence:.9,risk_flags:[],valid_at:null,invalid_at:null,
  speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],
  interpretation_reason:'原话明确表达偏好',requires_all_sources:true,event:null,conditions:null};
const contract=buildSourceVerificationContract([fact],{require_complete_evidence:true});

function visit(schema,path='$',result=[]){
  if(!schema||typeof schema!=='object')return result;
  result.push([path,schema]);
  if(schema.properties)for(const [key,value] of Object.entries(schema.properties))visit(value,`${path}.properties.${key}`,result);
  if(schema.items)visit(schema.items,`${path}.items`,result);
  if(schema.anyOf)for(const [index,value] of schema.anyOf.entries())visit(value,`${path}.anyOf[${index}]`,result);
  return result;
}

test('现行来源核验转换为DeepSeek strict支持的关键字与对象闭合合同',()=>{
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
  assert.equal(Object.hasOwn(schema.properties.results.items.properties,'proof'),false);
  const nullable=deepSeekStrictVerificationSchema({type:'object',properties:{optional:{type:['string','null']}},required:['optional'],additionalProperties:false});
  assert.deepEqual(nullable.properties.optional.anyOf.map(item=>item.type),['string','null']);
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

test('strict工具结果经现行完整命题核验，旧proof槽不再赋予准入',async()=>{
  const window={owner_id:'11111111-1111-4111-8111-111111111111',contact_id:'22222222-2222-4222-8222-222222222222',
    messages:[{message_id:messageId,text:'有事爱直接打电话',sender:'contact',occurred_at:null,text_representation:'text'}],target_message_ids:[messageId]};
  const normalized={...fact,source_dependency_mode:'any',_scene_name:'沟通偏好',timing:{source_started_at:null,source_ended_at:null,source_time_complete:false}};
  const row=completeClaimRow(normalized,{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:messageId,quote:'有事爱直接打电话'}]},window);
  for(const oldProof of [false,true]){
    const value={results:[{...row,...(oldProof?{proof:null}:{})}]};
    const response={id:'synthetic-response',choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
      tool_calls:[{id:'synthetic-call',type:'function',function:{name:'SourceVerificationOutput',arguments:JSON.stringify(value)}}]}}],usage:{prompt_tokens:21,completion_tokens:13}};
    const decoded=decodeDeepSeekStrictVerificationResponse(response);
    const prepared=prepareSourceVerification({window,facts:[normalized],policy:verificationPolicy,requireCurrent:async()=>{}});
    const item=(await prepared.decode(decoded.blocks)).items[0];
    assert.equal(item.admitted,!oldProof);
    assert.equal(item.result.verification_mode,'complete-claim-v1');
  }
});
