import test from 'node:test';
import assert from 'node:assert/strict';
import {ports,batchFixture,until,contactId,batchId,completedView,runningView,interruptedView} from './fixtures/history-recertify-batch.mjs';

const statusKey=request=>{
 const url=new URL(request.path,'http://synthetic.local');
 return url.searchParams.get('request_key');
};
const isStatus=request=>request.method==='GET'&&/\/history\/recertify$/.test(new URL(request.path,'http://synthetic.local').pathname)&&new URL(request.path,'http://synthetic.local').searchParams.has('request_key');
const isCancel=request=>request.method==='POST'&&request.path.endsWith('/history/recertify/cancel');

test('接纳响应丢失后只用同一 request_key 查询，绝不换键重发', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 const keys=[];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:({request})=>{
   if(request.method==='POST'){keys.push(request.body.request_key);throw new ports.BackendRequestFailure('connection');}
   return {generation:1,data:completedView(contacts[0],statusKey(request))};
  },
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.equal(state.completed,2);
 const admissions=f.state.calls.filter(call=>call.method==='POST'&&/\/history\/recertify$/.test(new URL(call.path,'http://synthetic.local').pathname));
 assert.equal(admissions.length,2);
 assert.match(keys[0],new RegExp(`^batch-${batchId}-001-${contacts[0]}$`));
 const lookups=f.state.calls.filter(call=>isStatus(call)&&call.path.includes(contacts[0]));
 assert.ok(lookups.length>=1);
 for(const lookup of lookups)assert.equal(statusKey(lookup),keys[0]);
});

test('接纳响应始终查不到且超过宽限时整体中断，不换键也不重复提交', {timeout:20000}, async t=>{
 const contacts=[contactId(1)];
 const f=await batchFixture(t,{contacts});
 let posts=0;
 f.state.behaviors.set(contacts[0],({request,state})=>{
  if(request.method==='POST'){posts++;throw new ports.BackendRequestFailure('connection');}
  // 模拟响应丢失后同键始终没有被接纳：推进时钟越过宽限期。
  state.now+=50;
  return {generation:1,data:{contact_id:contacts[0],request_key:null,state:'none',stage:'none',completed:false,failure_code:null,
   message_count:0,non_text_count:0,page_count:0,preserved_message_count:0,started_at:null,finished_at:null}};
 });
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='interrupted');
 const state=f.controller.getState();
 assert.equal(state.interruptedReason,'history_recertify_admission_unconfirmed');
 assert.equal(posts,1);
 assert.equal(f.activity.batchRunning(),false);
});

test('停止：取消当前位并等待终态后结束，不再开始下一位', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:({request,url})=>{
   if(isCancel(request))return {generation:1,data:interruptedView(contacts[0],request.body.request_key)};
   if(request.method==='POST')return {generation:1,data:runningView(contacts[0],request.body.request_key)};
   return {generation:1,data:runningView(contacts[0],statusKey(request))};
  },
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='running'&&f.controller.getState().current?.stage==='history');
 const key=f.state.calls.find(call=>call.method==='POST'&&/\/history\/recertify$/.test(new URL(call.path,'http://synthetic.local').pathname)).body.request_key;
 await f.controller.stop();
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.equal(state.stopRequested,true);assert.equal(state.completed,0);
 assert.deepEqual(state.skippedByCode,{history_recertify_cancelled:1});
 const cancels=f.state.calls.filter(call=>isCancel(call));
 assert.equal(cancels.length,1);assert.equal(cancels[0].body.request_key,key);
 assert.equal(f.state.calls.filter(call=>call.method==='POST'&&/\/history\/recertify$/.test(new URL(call.path,'http://synthetic.local').pathname)).length,1);
 assert.equal(f.state.calls.some(call=>call.path.includes(contacts[1])),false);
 assert.equal(f.activity.batchRunning(),false);
});

test('接纳结果未知时停止仍只取消原键并确认终态', {timeout:20000}, async t=>{
 const contacts=[contactId(1)];
 const f=await batchFixture(t,{contacts});
 const keys=[];
 f.state.behaviors.set(contacts[0],({request})=>{
  if(request.method==='POST'&&/\/history\/recertify$/.test(new URL(request.path,'http://synthetic.local').pathname)){keys.push(request.body.request_key);throw new ports.BackendRequestFailure('connection');}
  if(isCancel(request))return {generation:1,data:interruptedView(contacts[0],request.body.request_key)};
  return {generation:1,data:runningView(contacts[0],statusKey(request))};
 });
 const started=f.controller.start({limit:null,confirmed:true});
 await until(()=>f.state.calls.some(call=>call.method==='POST'));
 await f.controller.stop();
 await started;
 await until(()=>f.controller.getState().phase==='finished'||f.controller.getState().phase==='interrupted');
 const state=f.controller.getState();
 assert.equal(state.phase,'finished');assert.equal(state.stopRequested,true);
 const cancels=f.state.calls.filter(call=>isCancel(call));
 assert.equal(cancels.length,1);assert.equal(cancels[0].body.request_key,keys[0]);
 assert.equal(f.state.calls.filter(call=>call.method==='POST'&&/\/history\/recertify$/.test(new URL(call.path,'http://synthetic.local').pathname)).length,1);
});

test('后端连接代次变化以 interrupted 结束，保留已完成统计且不自动恢复', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2),contactId(3)];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[1]]:({request,state})=>{
   if(request.method==='POST'){state.setGeneration(2);throw new ports.BackendRequestFailure('connection');}
   return {generation:2,data:completedView(contacts[1],statusKey(request))};
  },
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='interrupted');
 const state=f.controller.getState();
 assert.equal(state.phase,'interrupted');assert.equal(state.interruptedReason,'connection_changed');
 assert.equal(state.completed,1);
 assert.equal(f.state.calls.some(call=>call.path.includes(contacts[2])),false);
 assert.equal(f.activity.batchRunning(),false);
 // 不自动恢复：状态保持 interrupted，需要再次明确确认才会开始新批次。
 await f.state.setGeneration(1);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.controller.getState().phase,'interrupted');
 assert.equal(f.state.calls.filter(call=>call.method==='POST'&&/\/history\/recertify$/.test(new URL(call.path,'http://synthetic.local').pathname)).length,2);
});

test('停滞看门狗取消当前位并确认终态后计联系人级失败并继续', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 const f=await batchFixture(t,{contacts,options:{stallMs:100},behaviors:{
  [contacts[0]]:({request,state})=>{
   if(isCancel(request))return {generation:1,data:interruptedView(contacts[0],request.body.request_key)};
   if(request.method==='POST')return {generation:1,data:runningView(contacts[0],request.body.request_key)};
   state.now+=60;
   return {generation:1,data:runningView(contacts[0],statusKey(request))};
  },
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.deepEqual(state.failedByCode,{history_recertify_stalled:1});
 assert.equal(state.completed,1);
 const admission=f.state.calls.find(call=>call.method==='POST'&&/\/history\/recertify$/.test(new URL(call.path,'http://synthetic.local').pathname));
 const cancels=f.state.calls.filter(call=>isCancel(call));
 assert.equal(cancels.length,1);assert.equal(cancels[0].body.request_key,admission.body.request_key);
 assert.ok(f.state.logs.some(line=>line.event==='contact_stalled'));
});

test('回包不符合既有状态格式时整体中断，不把未知结构当普通失败', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:()=>({generation:1,data:{contact_id:contacts[0],request_key:'recertify-malformed',state:'completed'}}),
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='interrupted');
 assert.equal(f.controller.getState().interruptedReason,'history_recertify_response_invalid');
 assert.equal(f.state.calls.some(call=>call.path.includes(contacts[1])),false);
});

test('already_running 先只读等待既有终态，再记录码并继续下一位', {timeout:20000}, async t=>{
 const contacts=[contactId(1),contactId(2)];
 let polls=0;
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:({request})=>{
   if(request.method==='POST')throw new ports.BackendRequestFailure('response',409,'history_recertify_already_running');
   polls++;
   return {generation:1,data:polls<2?runningView(contacts[0],'existing-operation'):completedView(contacts[0],'existing-operation')};
  },
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().phase==='finished');
 const state=f.controller.getState();
 assert.deepEqual(state.skippedByCode,{history_recertify_already_running:1});
 assert.equal(state.completed,1);
 assert.ok(polls>=2);
});

test('停止后无法确认终态时以 interrupted 结束，不谎报已停止', {timeout:20000}, async t=>{
 const contacts=[contactId(1)];
 const f=await batchFixture(t,{contacts,behaviors:{
  [contacts[0]]:({request,state})=>{
   if(isCancel(request))throw new ports.BackendRequestFailure('connection');
   if(request.method==='POST')return {generation:1,data:runningView(contacts[0],request.body.request_key)};
   state.now+=30;
   return {generation:1,data:runningView(contacts[0],statusKey(request))};
  },
 }});
 await f.controller.start({limit:null,confirmed:true});
 await until(()=>f.controller.getState().current?.stage==='history');
 await f.controller.stop();
 await until(()=>f.controller.getState().phase==='interrupted');
 assert.equal(f.controller.getState().interruptedReason,'history_recertify_stop_unconfirmed');
 assert.equal(f.activity.batchRunning(),false);
});
