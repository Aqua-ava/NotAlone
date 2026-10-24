import test from 'node:test';
import assert from 'node:assert/strict';
import { measureSerializedMessages, MESSAGES_MEASUREMENT_ID } from '../src/model-input-budget.ts';
const binding={provider:'deepseek-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'};
const profile={context_window_tokens:8192,safety_margin_tokens:512};
const body=()=>({model:binding.model,stream:true,max_tokens:512,temperature:0,thinking:{type:'disabled'},system:'仅用证据回答。',messages:[{role:'user',content:[{type:'text',text:'合成中文𠀀'}]}],tools:[{name:'lookup',description:'查阅合成来源',input_schema:{type:'object',properties:{query:{type:'string'}}}}]});
test('完整Messages JSON含system、工具schema和Unicode字节，独立估算标识不冒充精确',()=>{
 const request=body(),receipt=measureSerializedMessages(request,binding,profile);
 assert.equal(receipt.serialized_bytes,Buffer.byteLength(JSON.stringify(request)));
 assert.equal(receipt.measurement_kind,'approximate');assert.equal(receipt.measurement_id,MESSAGES_MEASUREMENT_ID);
 assert.deepEqual(receipt.covered_components,['messages','system','tools','controls']);
});
test('第二轮工具结果超预算，第一轮未被改写，不能截断工具正文骗过检查',()=>{
 const first=measureSerializedMessages(body(),binding,profile);
 const second=body();second.messages.push({role:'user',content:[{type:'tool_result',tool_use_id:'synthetic',content:[{type:'text',text:'合成'.repeat(2000)}]}]});
 assert.throws(()=>measureSerializedMessages(second,binding,profile),error=>{
  assert.equal(error.code,'reply_budget_exceeded');
  assert.equal(error.receipt.input_tokens,Buffer.byteLength(JSON.stringify(second)));
  assert.equal(error.receipt.safety_margin_tokens,profile.safety_margin_tokens);
  assert.equal(error.receipt.input_tokens+error.receipt.maxTokens+error.receipt.safety_margin_tokens>profile.context_window_tokens,true);
  assert.equal(Object.hasOwn(error.receipt,'messages'),false);return true;
 });
 assert.equal(measureSerializedMessages(body(),binding,profile).request_sha256,first.request_sha256);
});
test('真实配置漂移、隐藏字段、未知内容、无余量均在发送前失败',()=>{
 for(const change of [{model:'other'},{max_tokens:2048},{temperature:1},{thinking:{type:'enabled'}},{extra_body:{messages:[]}}])assert.throws(()=>measureSerializedMessages({...body(),...change},binding,profile),/unavailable/);
 assert.throws(()=>measureSerializedMessages(body(),binding,{...profile,safety_margin_tokens:0}),/unavailable/);
 const image=body();image.messages[0].content=[{type:'image',source:{type:'base64',data:'synthetic'}}];
 assert.throws(()=>measureSerializedMessages(image,binding,profile),/unavailable/);
 const cyclic=body();cyclic.tools[0].input_schema.self=cyclic;
 assert.throws(()=>measureSerializedMessages(cyclic,binding,profile),/unavailable/);
});

test('锁定官方adapter最终序列化守卫：允许请求字节一致、超预算零HTTP', async t=>{
 const {readdir}=await import('node:fs/promises');
 const {resolve}=await import('node:path');
 const {pathToFileURL}=await import('node:url');
 const {createServer}=await import('node:http');
 const {once}=await import('node:events');
 const {createHash}=await import('node:crypto');
 const packageDirectory=(await readdir('node_modules/.pnpm')).find(name=>name.startsWith('@deepseek-ai+dsh-llm-deepseek@0.2.1-rc.2_'));
 assert.ok(packageDirectory,'必须使用已锁定的官方制品');
 const {DeepSeekAdapter,resolveAdapterOptions}=await import(pathToFileURL(resolve('node_modules/.pnpm',packageDirectory,'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')).href);
 const payloads=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;payloads.push(raw);
  res.writeHead(500,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic"}}');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const connection=resolveAdapterOptions({baseURL:`http://127.0.0.1:${server.address().port}/anthropic`,thinking:'disabled',maxTokens:512,retryPolicy:{mode:'normal',maxRetries:0}});
 let measured;
 const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous',
  prepareExtensions:async request=>{
   measured=measureSerializedMessages(request.body,binding,profile);
   return {fields:{},accept:async()=>{}};
  }});
 const options={...binding,system:'完整合成系统提示',messages:[{role:'user',content:[{type:'text',text:'合成内容'}]}],tools:[{name:'lookup',description:'合成工具',parameters:{type:'object',properties:{query:{type:'string'}}}}]};
 const collect=async options=>{for await(const _ of adapter.stream(options)){};};
 await assert.rejects(collect(options));
 assert.equal(payloads.length,1);
 assert.equal(measured.request_sha256,createHash('sha256').update(payloads[0]).digest('hex'));
 assert.equal(measured.serialized_bytes,Buffer.byteLength(payloads[0]));
 await assert.rejects(collect({...options,messages:[{role:'user',content:[{type:'text',text:'超预算'.repeat(10000)}]}]}));
 assert.equal(payloads.length,1,'第二次预算拒绝必须没有HTTP');
});
