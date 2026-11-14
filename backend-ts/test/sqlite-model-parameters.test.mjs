import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';
import {SqliteModelSetup} from '../src/host/sqlite-model-setup.ts';
import {createSqliteModelRuntime} from '../src/host/sqlite-model-runtime.ts';
import {randomUUID} from 'node:crypto';

const configured=(environment={},options={})=>resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only-key',...environment},options);
test('回复与记忆分别读取手动思考和温度配置，默认保持原值',()=>{
 const environment={NOTALONE_REPLY_THINKING_EFFORT:'low',NOTALONE_REPLY_TEMPERATURE:'0.7',NOTALONE_MEMORY_THINKING_EFFORT:'max',NOTALONE_MEMORY_TEMPERATURE:'1.5'};
 const reply=configured(environment),memory=configured(environment,{purpose:'memory'});
 assert.equal(reply.model.reasoningEffort,'low');assert.equal(reply.model.temperature,0.7);
 assert.equal(memory.model.reasoningEffort,'max');assert.equal(memory.model.temperature,1.5);
 assert.equal(configured({}, {purpose:'memory'}).model.reasoningEffort,'off');assert.equal(configured({}, {purpose:'memory'}).model.temperature,0);
 for(const prefix of ['REPLY','MEMORY']){
  for(const value of ['', 'medium','enabled'])assert.equal(configured({[`NOTALONE_${prefix}_THINKING_EFFORT`]:value},{purpose:prefix.toLowerCase()}).status,'unavailable');
  for(const value of ['', '-0.1','2.1','NaN','Infinity','garbage'])assert.equal(configured({[`NOTALONE_${prefix}_TEMPERATURE`]:value},{purpose:prefix.toLowerCase()}).status,'unavailable');
 }
});

test('回复与记忆参数独立保存且无需密钥，重启前后状态及环境覆盖受控',async t=>{
 const root=await mkdtemp(join(tmpdir(),'notalone-model-parameters-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'model.env');await writeFile(file,'OTHER=kept\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only-key\n',{mode:0o600});
 const setup=await SqliteModelSetup.open(file,{});
 assert.deepEqual(setup.status().model_parameters,{reply:{thinking_effort:'off',temperature:0},memory:{thinking_effort:'off',temperature:0}});
 const parameters={reply:{thinking_effort:'off',temperature:0.7},memory:{thinking_effort:'max',temperature:1.2}};
 await setup.saveModelParameters(parameters);
 assert.deepEqual(setup.status().model_parameters,parameters);assert.equal(setup.status().runtime_configuration_pending,true);
 const saved=await readFile(file,'utf8');assert.match(saved,/OTHER=kept/);assert.match(saved,/NOTALONE_DEEPSEEK_API_KEY=synthetic-only-key/);assert.equal((await stat(file)).mode&0o777,0o600);
 const reopened=await SqliteModelSetup.open(file,{});assert.deepEqual(reopened.status().model_parameters,parameters);assert.equal(reopened.status().runtime_configuration_pending,false);
 for(const invalid of [null,{}, {...parameters,extra:1},{...parameters,reply:{thinking_effort:'medium',temperature:0}},{...parameters,memory:{thinking_effort:'high',temperature:2.1}},{...parameters,reply:{thinking_effort:'off',temperature:'0.7'}},{...parameters,reply:{thinking_effort:'off',temperature:NaN}},{...parameters,reply:{thinking_effort:'off',temperature:Infinity}},{...parameters,reply:{thinking_effort:'off',temperature:0,extra:true}}])await assert.rejects(setup.saveModelParameters(invalid),{code:'setup_request_invalid'});
 assert.equal(await readFile(file,'utf8'),saved);
 const overridden=await SqliteModelSetup.open(file,{NOTALONE_MEMORY_THINKING_EFFORT:'low'});assert.equal(overridden.status().runtime_configuration_environment_override,true);
 await assert.rejects(overridden.saveModelParameters(parameters),{code:'configuration_environment_override'});assert.equal(await readFile(file,'utf8'),saved);
 for(const temperature of [1e-7,0.30000000000000004]){
  const precise={reply:{thinking_effort:'off',temperature},memory:{thinking_effort:'low',temperature}};
  await setup.saveModelParameters(precise);assert.deepEqual((await SqliteModelSetup.open(file,{})).status().model_parameters,precise);
 }
});

for(const [replyEffort,memoryEffort] of [['off','high'],['max','off']])test(`唯一官方provider分别发送回复${replyEffort}和记忆${memoryEffort}，strict沿用记忆参数`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'notalone-purpose-provider-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const requests=[],previousFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(init.body);requests.push(body);
  if(body.stream===false)return Response.json({choices:[{message:{tool_calls:[{id:'synthetic-tool',function:{name:'SourceVerificationOutput',arguments:'{"ok":true}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1}});
  const events=[{type:'message_start',message:{id:'synthetic',model:body.model,usage:{input_tokens:1,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };t.after(()=>{globalThis.fetch=previousFetch;});
 let adapter,registrations=0;
 const runtime=await createSqliteModelRuntime({ctx:{llm:{registerAdapter(_names,value){registrations++;adapter=value;return async()=>{};}}},userData:root,businessHome:root,infoPath:join(root,'info'),envFilePath:join(root,'model.env'),environment:{NOTALONE_DEEPSEEK_API_KEY:'synthetic-only-key',NOTALONE_REPLY_THINKING_EFFORT:replyEffort,NOTALONE_REPLY_TEMPERATURE:'0.7',NOTALONE_MEMORY_THINKING_EFFORT:memoryEffort,NOTALONE_MEMORY_TEMPERATURE:'1.3'}});
 t.after(()=>runtime.close());assert.equal(registrations,1);
 const shared=runtime.shared;
 for(const configuration of [shared.configuration,shared.memoryConfiguration]){
  const {physical_limit,deadline_ms,warning_ratio,budgetProfile,...binding}=configuration.model,sessionId=randomUUID();
  const call=shared.provider.beginCall({sessionId,attempt_id:randomUUID(),permit_id:randomUUID(),binding,profile:budgetProfile,requireCurrent:async()=>{},beforeDispatch:async()=>{}});
  try{for await(const chunk of adapter.stream({...binding,sessionId,messages:[{role:'user',content:[{type:'text',text:'合成用途配置'}]}]}))if(chunk.type==='finish')assert.equal(chunk.reason.kind,'stop');}finally{call.close();}
 }
 const {physical_limit,deadline_ms,warning_ratio,budgetProfile,...binding}=shared.memoryConfiguration.model;
 const call=shared.provider.beginStrictVerificationCall({sessionId:randomUUID(),attempt_id:randomUUID(),permit_id:randomUUID(),binding,profile:budgetProfile,requireCurrent:async()=>{},beforeDispatch:async()=>{}});
 try{const result=await call.send({system:'合成核验',user:'合成来源',tool:{name:'SourceVerificationOutput',description:'合成结构核验',parameters:{type:'object',properties:{ok:{type:'boolean'}}}},signal:new AbortController().signal});assert.equal(result.success,true);}finally{call.close();}
 assert.equal(requests.length,3);
 for(const [index,effort,temperature] of [[0,replyEffort,0.7],[1,memoryEffort,1.3],[2,memoryEffort,1.3]]){
  const body=requests[index];assert.deepEqual(body.thinking,{type:effort==='off'?'disabled':'enabled'});assert.equal(body.temperature,temperature);
  if(index===2){assert.equal(body.reasoning_effort,effort==='off'?'none':effort);assert.equal(body.tools[0].function.strict,true);assert.equal('tool_choice' in body,effort==='off');}
  else assert.deepEqual(body.output_config,effort==='off'?undefined:{effort});
 }
 await runtime.close();
});
