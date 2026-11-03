import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {historicalReplyFixture,renderSession} from './fixtures/historical-reply-basis.mjs';

for(const action of ['replies'])test(`生产Main与preload的${action}以分段回执接管真实会话，显示轻提示并明确继续上一段`,async()=>{
 const f=await historicalReplyFixture(),fresh=randomUUID(),original=f.backend.requestJson;
 let current=f.sessionId;
 const old=structuredClone(f.records.saved);
 f.backend.requestJson=async request=>{
  const turn=f.records.saved.turns.at(-1);
  if(request.path.endsWith('/'+action+'/prepare')){
   f.calls.push(request);current=fresh;
   turn.request_key=request.body.idempotency_key;
   f.records.saved.session_id=fresh;f.records.history.session_id=fresh;
   return {generation:7,data:{session_id:fresh,previous_session_id:f.sessionId,turn_id:turn.turn_id,
    request_key:turn.request_key,input_version_id:turn.input_version_id,state:'running'}};
  }
  if(request.path.endsWith('/'+action)){f.calls.push(request);return {generation:7,data:{...turn.reply,
   session_id:fresh,turn_id:turn.turn_id,input_version_id:turn.input_version_id,state:'completed'}}; }
  if(request.path.endsWith('/assistant-sessions')&&request.method==='GET')return {generation:7,data:{
   sessions:[{session_id:f.sessionId,is_current:current===f.sessionId},{session_id:fresh,is_current:current===fresh}],current_session_id:current}};
  if(request.path.endsWith('/resume')){f.calls.push(request);current=f.sessionId;f.records.saved=old;f.records.history.session_id=f.sessionId;return {generation:7,data:{session_id:f.sessionId}};}
  if(request.path.endsWith('/'+f.sessionId))return {generation:7,data:old};
  return original(request);
 };
 try{
  await f.bridge.readSavedSession(f.scope);await f.bridge.enterWorkspace(f.scope);
  f.contacts.setDraft({...f.scope,text:'合成空闲后新输入'});
  if(action==='replies')await f.bridge.generate({...f.scope,newRequest:true,workspaceAction:'express'});
  const state=await f.bridge.getState();
  assert.equal(state.savedSession.sessionId,fresh,'展示真实受理段');
  assert.equal(state.sessionCatalog.currentSessionId,fresh);
  assert.ok(state.result,JSON.stringify({phase:state.phase,saved:state.savedSession,calls:f.calls.map(call=>call.path)}));
  assert.equal(state.result.assistantSessionId,fresh);
  assert.match(renderSession(state),/已开启新讨论/);
  assert.match(renderSession(state),/继续上一段/);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/'+action)).length,1);
  if(action==='replies')assert.ok(f.calls.find(call=>call.path===`/api/contacts/${f.scope.contactId}/assistant-sessions/${fresh}/replies`));
  await f.bridge.resumeSavedSession({...f.scope,sessionId:f.sessionId});
  assert.equal((await f.bridge.getState()).sessionCatalog.currentSessionId,f.sessionId);
  assert.doesNotMatch(renderSession(await f.bridge.getState()),/已开启新讨论/);
 }finally{await f.replies.beginGenerationClosing(()=>{}).catch(error=>{if(f.replies.getState().phase!=='failed')throw error;});}
});

test('分段准备迟到时不污染已回看的历史，作业仍按真实受理段完成',async()=>{
 const f=await historicalReplyFixture(),fresh=randomUUID(),history=randomUUID(),original=f.backend.requestJson;
 let enter,release,key,admitted=false;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
 f.backend.requestJson=async request=>{
  const turn=f.records.saved.turns.at(-1);
  if(request.path.endsWith('/replies/prepare')){f.calls.push(request);key=request.body.idempotency_key;admitted=true;enter();await gate;
   return {generation:7,data:{session_id:fresh,previous_session_id:f.sessionId,turn_id:turn.turn_id,input_version_id:turn.input_version_id,request_key:key,state:'running'}};}
  if(request.path.endsWith('/replies')){f.calls.push(request);return {generation:7,data:{...turn.reply,session_id:fresh,turn_id:turn.turn_id,input_version_id:turn.input_version_id,state:'completed'}};}
  if(request.path.endsWith('/'+history))return {generation:7,data:{session_id:history,current_input_version_id:null,turns:[],inputs:[]}};
  if(request.path.endsWith('/assistant-sessions')&&request.method==='GET')return {generation:7,data:{sessions:[{session_id:f.sessionId,is_current:!admitted},{session_id:history,is_current:false},{session_id:fresh,is_current:admitted}],current_session_id:admitted?fresh:f.sessionId}};
  return original(request);
 };
 try{
  await f.bridge.readSavedSession(f.scope);await f.bridge.enterWorkspace(f.scope);
  f.contacts.setDraft({...f.scope,text:'合成切换前输入'});
  const running=f.bridge.generate({...f.scope,newRequest:true,workspaceAction:'express'});await entered;
  await f.bridge.viewSavedSession({...f.scope,sessionId:history});release();await running;
  const state=await f.bridge.getState();
  assert.equal(state.savedSession.sessionId,history);assert.equal(state.result,null);
  assert.doesNotMatch(renderSession(state),/已开启新讨论/);
  assert.equal(state.generationJobs.find(job=>job.requestKey===key).sessionId,fresh);
  assert.equal(state.generationJobs.find(job=>job.requestKey===key).phase,'completed');
  assert.equal(f.calls.filter(call=>call.path.endsWith('/replies')).length,1);
 }finally{release();await f.replies.beginGenerationClosing(()=>{});}
});
