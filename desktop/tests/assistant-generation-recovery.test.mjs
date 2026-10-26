import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
import {build} from 'esbuild';

const output=await build({stdin:{contents:`export {AssistantGenerationJobs} from './src/main/reply/assistant-generation-jobs';
export {recoverAssistantGenerationReceipt,interruptAssistantGeneration} from './src/main/reply/assistant-generation-interruption';
export {BackendRequestFailure} from './src/main/backend/json-client';
export {BackendHost} from './src/main/backend/host';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false});
const loaded={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const {AssistantGenerationJobs,recoverAssistantGenerationReceipt,interruptAssistantGeneration,BackendRequestFailure,BackendHost}=loaded.exports;

test('明确重试收尾可找回分段丢失的全部准备回执，只中断真实段且不生成',async()=>{
 const identity={connectionGeneration:7,contactId:randomUUID(),sessionId:randomUUID(),requestKey:randomUUID()},fresh=randomUUID(),turn=randomUUID(),version=randomUUID(),calls=[];
 const receipt={session_id:fresh,previous_session_id:identity.sessionId,turn_id:turn,input_version_id:version,request_key:identity.requestKey,state:'running'};
 const backend={getConnectionGeneration:()=>7,requestJson:async request=>{
  calls.push(request);
  if(request.method==='GET')return {generation:7,data:{session_id:identity.sessionId,current_input_version_id:null,inputs:[],turns:[]}};
  if(request.path.endsWith('/generation-receipt'))return {generation:7,data:receipt};
  assert.equal(request.path,`/api/contacts/${identity.contactId}/assistant-sessions/${fresh}/interrupt`);
  return {generation:7,data:{session_id:fresh,turn_id:turn,input_version_id:version,request_key:identity.requestKey,state:'failed',interruption_reason:'app_quit'}};
 }};
 const host=new BackendHost('/unused/synthetic-stopping-recovery');host.generation=7;host.state={phase:'connected'};
 host.target={requestJson:async request=>(await backend.requestJson(request)).data};host.confirmManualInput(identity.contactId,7);
 const captured=host.captureAssistantStoppingConnection(identity);assert.ok(captured);
 const jobs=new AssistantGenerationJobs();let late;
 await jobs.execute({identity,stopping:{recover:id=>recoverAssistantGenerationReceipt(captured,id),interrupt:actual=>interruptAssistantGeneration(captured,actual)},adapter:{async run(protocol){late=protocol;protocol.preparing();throw Error('合成全部准备回执丢失');}},consume:()=>assert.fail('未请求生成'),failed:()=>{}});
 await assert.rejects(jobs.beginClosing(()=>assert.fail('使用原认证连接')),/身份尚未确认/);assert.equal(calls.length,0);
 await jobs.beginClosing(()=>assert.fail('使用原认证连接'));assert.equal(calls.length,3);assert.deepEqual(jobs.pendingReceipts(),[]);
 assert.throws(()=>late.observe({kind:'receipt',receipt:{sessionId:fresh,previousSessionId:identity.sessionId,turnId:turn,inputVersionId:version,requestKey:identity.requestKey,state:'completed'}}),/归属无效/);
 assert.ok(calls.every(call=>call.method==='GET'||call.path.endsWith('/generation-receipt')||call.path.endsWith('/interrupt')));
 assert.ok(calls.every(call=>call.manualContactId===identity.contactId));
 await assert.rejects(captured.requestJson({method:'POST',path:`/api/contacts/${identity.contactId}/assistant-sessions/${fresh}/replies`,body:{}}));
});

test('原会话仍存在但尚未找到受理时保持未确认，不能把404当已删除',async()=>{
 const identity={connectionGeneration:7,contactId:randomUUID(),sessionId:randomUUID(),requestKey:randomUUID()};
 const backend={getConnectionGeneration:()=>7,requestJson:async request=>{if(request.method==='GET')return {generation:7,data:{session_id:identity.sessionId,current_input_version_id:null,inputs:[],turns:[]}};throw new BackendRequestFailure('response',404,'not_found');}};
 await assert.rejects(recoverAssistantGenerationReceipt(backend,identity));
});

test('正常分段回执的原认证停止句柄先核对受理别名，再仅中断对应输入版本',async()=>{
 const identity={connectionGeneration:7,contactId:randomUUID(),sessionId:randomUUID(),requestKey:randomUUID()},fresh=randomUUID(),turn=randomUUID(),version=randomUUID(),calls=[];
 const host=new BackendHost('/unused/synthetic-known-rollover');host.generation=7;host.state={phase:'connected'};
 host.target={requestJson:async request=>{calls.push(request);if(request.path.endsWith('/generation-receipt'))return {session_id:fresh,previous_session_id:identity.sessionId,turn_id:turn,input_version_id:version,request_key:identity.requestKey,state:'running'};return {session_id:fresh,turn_id:turn,input_version_id:version,request_key:identity.requestKey,state:'failed',interruption_reason:'user_cancelled'};}};
 const captured=host.captureAssistantStoppingConnection(identity);
 const actual={...identity,sessionId:fresh,turnId:turn,inputVersionId:version,state:'running'};
 assert.deepEqual(await interruptAssistantGeneration(captured,actual,'user_cancelled'),{state:'failed',interruptionReason:'user_cancelled'});
 assert.equal(calls.length,2);assert.equal(calls[0].path,`/api/contacts/${identity.contactId}/assistant-sessions/${identity.sessionId}/generation-receipt`);assert.equal(calls[1].path,`/api/contacts/${identity.contactId}/assistant-sessions/${fresh}/interrupt`);
 await assert.rejects(interruptAssistantGeneration(captured,{...actual,inputVersionId:randomUUID()},'user_cancelled'));assert.equal(calls.filter(call=>call.path.endsWith('/interrupt')).length,1);
});

for(const damage of ['previous_session','request_key','connection'])test(`恢复拒绝${damage}不匹配的分段回执`,async()=>{
 const identity={connectionGeneration:7,contactId:randomUUID(),sessionId:randomUUID(),requestKey:randomUUID()};let generation=7;
 const backend={getConnectionGeneration:()=>generation,requestJson:async request=>{
  if(request.method==='GET')return {generation:7,data:{session_id:identity.sessionId,current_input_version_id:null,inputs:[],turns:[]}};
  if(damage==='connection')generation=8;
  return {generation:7,data:{session_id:randomUUID(),previous_session_id:damage==='previous_session'?randomUUID():identity.sessionId,turn_id:randomUUID(),input_version_id:randomUUID(),request_key:damage==='request_key'?randomUUID():identity.requestKey,state:'running'}};
 }};
 await assert.rejects(recoverAssistantGenerationReceipt(backend,identity));
});
