import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/platform/models/model-provider.ts';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

async function fixture(t){
 const base=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});assert.equal(base.status,'configured');
 let adapter,received=0;const handles=[];
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}received++;res.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 const provider=installModelProvider({llm:{registerAdapter(_names,value){adapter=value;return async()=>{};}}},{...base.provider,
  connection:resolveAdapterOptions({baseURL:origin+'/anthropic',thinking:'disabled',maxTokens:64,retryPolicy:{mode:'normal',maxRetries:0}}),
  strictVerificationEndpoint:origin+'/beta/chat/completions',resolveAuth:async()=>({headers:{'x-api-key':'synthetic-only'}}),resolveUserId:()=> 'synthetic-anonymous'});
 t.after(async()=>{for(const handle of handles)handle.close();try{await provider.dispose();}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}});
 const binding={provider:base.model.provider,model:base.model.model,maxTokens:64,temperature:0.2,reasoningEffort:'off'},profile={context_window_tokens:131072,safety_margin_tokens:4096};
 const begin=(signal,beforeDispatch,strict=false)=>{
  const registration={sessionId:randomUUID(),attempt_id:randomUUID(),permit_id:randomUUID(),binding,profile,requireCurrent:async()=>{},beforeDispatch};
  const call=strict?provider.beginStrictVerificationCall(registration):provider.beginCall(registration);handles.push(call);
  const work=async()=>{if(strict){try{await call.send({system:'合成',user:'{}',tool:{name:'SourceVerificationOutput',description:'合成',parameters:{type:'object',properties:{results:{type:'array',items:{type:'object',properties:{}}}}}},signal});}catch{}return;}
   for await(const _chunk of adapter.stream({...binding,sessionId:registration.sessionId,messages:[{role:'user',content:[{type:'text',text:'合成'}]}],signal})){}
  };
  return {call,runUnobserved:async()=>{try{await work();}catch{}return call.observation();},run:async()=>{try{await (call.runWithDispatchObservation?call.runWithDispatchObservation(work):work());}catch{}return call.observation();}};
 };
 return {begin,get received(){return received;}};
}

for(const strict of [false,true])test(`${strict?'strict':'官方Messages'}预约后取消且未进入fetch时有明确未发送证明`,async t=>{
 const f=await fixture(t),controller=new AbortController();
 const pending=f.begin(controller.signal,async()=>{controller.abort();},strict);const observed=await pending.run();
 assert.equal(f.received,0);assert.equal(observed.fetch_started,false);pending.call.close();
});

test('并行会话取消只标自己的未发送，真实fetch后断线仍是未知发送',async t=>{
 const f=await fixture(t),cancelled=new AbortController(),dispatched=new AbortController();let entered,release;
 const ready=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});
 const waiting=f.begin(cancelled.signal,async()=>{entered();await gate;});const waitingWork=waiting.run();await ready;
 const actual=f.begin(dispatched.signal,async()=>{});const actualObservation=await actual.run();
 cancelled.abort();release();const cancelledObservation=await waitingWork;
 assert.equal(f.received,1);assert.equal(actualObservation.fetch_started,true);assert.equal(actualObservation.dispatch,'authorized_unconfirmed');
 assert.equal(cancelledObservation.fetch_started,false);waiting.call.close();actual.call.close();
});


test('strict真正进入fetch后无回执仍为可能已发送，不能归为未发送',async t=>{
 const f=await fixture(t),pending=f.begin(new AbortController().signal,async()=>{},true);
 const observed=await pending.run();assert.equal(f.received,1);assert.equal(observed.fetch_started,true);assert.equal(observed.dispatch,'authorized_unconfirmed');pending.call.close();
});

test('未绑定作用域的旧消费者保持缺省观测，已进入前门的调用不会被重复run重置',async t=>{
 const f=await fixture(t),legacy=f.begin(new AbortController().signal,async()=>{});
 const unknown=await legacy.runUnobserved();assert.equal(f.received,1);assert.equal(unknown.fetch_started,undefined);legacy.call.close();
 const bound=f.begin(new AbortController().signal,async()=>{});assert.equal((await bound.run()).fetch_started,true);
 assert.equal((await bound.run()).fetch_started,true);assert.equal(f.received,2);bound.call.close();
});
