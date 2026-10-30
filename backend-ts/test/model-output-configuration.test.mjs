import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {measureSerializedStrictChatCompletion} from '../src/platform/models/model-input-budget.ts';
import {modelLedgerInputBudget} from '../src/platform/models/model-ledger-contract.ts';
import {buildDeepSeekStrictVerificationRequest} from '../src/memory/extraction/verification/deepseek-strict.ts';
import {installModelProvider} from '../src/platform/models/model-provider.ts';

const configured=(extra={})=>resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-output-configuration-key',...extra});

test('宿主输出缺省使用供应商上限，显式任务额度可超过旧4096且校验供应商硬上限',()=>{
  const first=configured();assert.equal(first.status,'configured');
  assert.equal(first.model.maxTokens,393216);
  const second=configured({NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:'65536'});
  assert.equal(second.status,'configured');assert.equal(second.model.maxTokens,65536);
  assert.equal(second.provider.connection.maxTokens,65536);
  assert.equal(second.provider.connection.models[0].maxTokens,65536);
  for(const value of ['0','-1','1.5','Infinity','393217','65536junk','',' 65536','9007199254740993',[],false])
    assert.deepEqual(configured({NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:value}),{status:'unavailable',code:'reply_model_configuration_invalid'});
});

test('实际strict发送入口的最终HTTP实体和预约快照使用配置额度，fetch全程拦截',async t=>{
  const previous=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,init)=>{
    requests.push({url,raw:init.body,body:JSON.parse(init.body)});
    return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
      tool_calls:[{id:'synthetic-output-call',type:'function',function:{name:'SourceVerificationOutput',arguments:'{"results":[]}'}}]}}],
      usage:{prompt_tokens:3,completion_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
  };
  t.after(()=>{globalThis.fetch=previous;});
  for(const maxTokens of [393216,65536,8192]){
    const resolved=configured({NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:String(maxTokens)}),binding={provider:resolved.model.provider,
      model:resolved.model.model,maxTokens:resolved.model.maxTokens,temperature:0,reasoningEffort:'off'};
    const provider=installModelProvider({llm:{registerAdapter:()=>()=>{}}},{...resolved.provider,resolveUserId:()=> 'synthetic-output-test'});
    let reservations=0,budget;
    const call=provider.beginStrictVerificationCall({sessionId:randomUUID(),attempt_id:randomUUID(),permit_id:randomUUID(),
      binding,profile:resolved.model.budgetProfile,requireCurrent:async()=>{},beforeDispatch:async value=>{
        reservations++;budget=modelLedgerInputBudget(value.budget);
      }});
    try{
      await call.send({system:'仅作合成配置验证。',user:'保留完整的合成核验内容。',signal:new AbortController().signal,
        tool:{name:'SourceVerificationOutput',description:'合成',parameters:{type:'object',additionalProperties:false,properties:{},required:[]}}});
      const request=requests.at(-1);
      assert.equal(request.url,'https://api.deepseek.com/beta/chat/completions');
      assert.equal(request.body.max_tokens,maxTokens);assert.equal(budget.max_output_tokens,maxTokens);
      assert.equal(budget.request_sha256,createHash('sha256').update(request.raw).digest('hex'));
      assert.equal(reservations,1);assert.equal(call.observation().dispatch,'http_accepted');
    }finally{call.close();await provider.dispose();}
  }
  assert.equal(requests.length,3);
});

test('strict请求与记录沿用宿主实际配置，不被旧4096静默缩减',()=>{
  for(const maxTokens of [393216,65536,8192]){
  const resolved=configured({NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:String(maxTokens)}),binding={provider:resolved.model.provider,model:resolved.model.model,
    maxTokens:resolved.model.maxTokens,temperature:0,reasoningEffort:'off'},profile=resolved.model.budgetProfile;
  const text='完整的合成核验请求';
  const strict=buildDeepSeekStrictVerificationRequest({...binding,system:'仅作合成容量测量。',user:text,
    tool:{name:'SourceVerificationOutput',description:'合成',parameters:{type:'object',additionalProperties:false,properties:{},required:[]}}}).body;
    assert.equal(strict.max_tokens,maxTokens);
    const before=JSON.stringify(strict),receipt=measureSerializedStrictChatCompletion(strict,binding,profile),budget=modelLedgerInputBudget(receipt);
    assert.equal(receipt.serialized_bytes,Buffer.byteLength(before));assert.equal(receipt.input_tokens,receipt.serialized_bytes);
    assert.equal(receipt.measurement_kind,'approximate');assert.equal(JSON.stringify(strict),before);
    assert.equal(budget.max_output_tokens,maxTokens);assert.equal(Object.hasOwn(budget,'messages'),false);
  }
});
