import test from 'node:test';
import assert from 'node:assert/strict';
import {ports,contact,other,recertifyFixture,recertifyStatus,completedStatus,until} from './fixtures/history-recertify.mjs';

test('来源重新认证独立于清空与普通重读，真实桥只提交明确确认的请求键',async t=>{
 const f=await recertifyFixture(t),handlers=new Map(),roles=new Map();
 const controller=ports.installHistoryClearBridge({handle:(name,handler,role)=>{handlers.set(name,handler);roles.set(name,role);},publish:()=>{}},f.backend,f.contacts);t.after(()=>controller.dispose());await until(()=>controller.getState().phase==='ready');
 const bridge=ports.createHistoryClearBridge({invoke:async(name,...args)=>handlers.get(name)(...args),on:()=>{},removeListener:()=>{}});
 assert.equal(controller.getState().clear.phase,'none');assert.equal(controller.getState().recertify.state,'none');
 await bridge.recertify({...f.scope,requestKey:'recertify-explicit-1',confirmed:true});
 const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].path.endsWith('/history/recertify'));assert.deepEqual(posts[0].body,{request_key:'recertify-explicit-1'});
 assert.equal(controller.getState().recertify.completed,true);assert.equal(controller.getState().recertify.preservedMessageCount,7);assert.equal(roles.get('history-clear:recertify'),'manager');
 for(const patch of [{confirmed:false},{requestKey:'invalid key'},{bindingId:'hidden'}])await assert.rejects(bridge.recertify({...f.scope,requestKey:'recertify-explicit-2',confirmed:true,...patch}));
 await assert.rejects(bridge.recertify());assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('认证响应未知时保留原键，刷新只读同一操作，未确认前不能另开一轮',async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await f.controller.recertify({...f.scope,requestKey:'recertify-unknown',confirmed:true});
 assert.equal(f.controller.getState().pendingRecertifyKey,'recertify-unknown');assert.equal(f.controller.getState().recertify.completed,false);
 await f.controller.refresh(f.scope);assert.equal(f.controller.getState().pendingRecertifyKey,'recertify-unknown');
 await assert.rejects(f.controller.recertify({...f.scope,requestKey:'recertify-new',confirmed:true}));
 f.controls.status=completedStatus('recertify-unknown');await f.controller.refresh(f.scope);
 assert.equal(f.controller.getState().pendingRecertifyKey,null);assert.equal(f.controller.getState().recertify.completed,true);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('认证失败保留可理解原因；明确重试可用新键，运行中不能并发开启',async t=>{
 const f=await recertifyFixture(t);f.controls.post=async request=>({generation:1,data:recertifyStatus({request_key:request.body.request_key,state:'failed',stage:'history',failure_code:'history_recertify_source_changed',started_at:100,finished_at:200})});
 await f.controller.recertify({...f.scope,requestKey:'recertify-failed',confirmed:true});assert.equal(f.controller.getState().recertify.state,'failed');assert.equal(f.controller.getState().pendingRecertifyKey,null);
 f.controls.post=null;await f.controller.recertify({...f.scope,requestKey:'recertify-retry',confirmed:true});assert.equal(f.controller.getState().recertify.completed,true);
 const running=await recertifyFixture(t);running.controls.status=recertifyStatus({request_key:'recertify-running',state:'running',stage:'history',started_at:100});await running.controller.refresh(running.scope);
 await assert.rejects(running.controller.recertify({...running.scope,requestKey:'recertify-concurrent',confirmed:true}));assert.equal(f.calls.filter(call=>call.method==='POST').length,2);assert.equal(running.calls.filter(call=>call.method==='POST').length,0);
});

test('范围变化中止认证请求，旧范围迟到完成不能覆盖新联系人状态',async t=>{
 const f=await recertifyFixture(t);let finish,started;const entered=new Promise(resolve=>{started=resolve;}),response=new Promise(resolve=>{finish=resolve;});
 f.controls.post=async()=>{started();return response;};const old=f.controller.recertify({...f.scope,requestKey:'recertify-old-scope',confirmed:true});await entered;
 const post=f.calls.find(call=>call.method==='POST');f.select(other);assert.equal(post.signal.aborted,true);await until(()=>f.controller.getState().phase==='ready');
 finish({generation:1,data:completedStatus('recertify-old-scope')});await old;
 assert.equal(f.controller.getState().contactId,other);assert.equal(f.controller.getState().recertify.state,'none');assert.equal(f.controller.getState().pendingRecertifyKey,null);
});

test('另一轮已在运行的明确拒绝会只读刷新进度，不把冲突当作未知新操作',async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{
  f.controls.status=recertifyStatus({request_key:'recertify-existing',state:'running',stage:'metadata',started_at:100});
  throw new ports.BackendRequestFailure('response',409,'history_recertify_already_running');
 };
 await f.controller.recertify({...f.scope,requestKey:'recertify-conflict',confirmed:true});
 assert.equal(f.controller.getState().recertify.state,'running');assert.equal(f.controller.getState().recertify.requestKey,'recertify-existing');assert.equal(f.controller.getState().pendingRecertifyKey,null);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('认证DTO不能用矛盾完成标记、错误范围、非法计数或内部身份冒报成功',async t=>{
 const f=await recertifyFixture(t);
 for(const patch of [{completed:true},{state:'completed',stage:'history',completed:true},{message_count:-1},{contact_id:other},{binding_id:'internal-identity'}]){
  f.controls.status=recertifyStatus(patch);await f.controller.refresh(f.scope);assert.equal(f.controller.getState().phase,'failed');assert.notEqual(f.controller.getState().recertify?.completed,true);
 }
});

test('认证宿主撤下旧缓存且不改变读取范围，成功才刷新聊天；失败与未知保持撤下',async t=>{
 for(const outcome of ['completed','failed','unknown'])await t.test(outcome,async t=>{
  const f=await recertifyFixture(t),cache={chat:'旧聊天',memory:'旧记忆',candidate:'旧候选'},events=[];let pendingContexts=0;
  const stop=ports.coordinateHistoryRecertification(f.controller,{withdraw:id=>{events.push(['withdraw',id]);Object.keys(cache).forEach(key=>cache[key]=null);pendingContexts++;},
   revalidate:async()=>{pendingContexts--;events.push(['revalidate']);},refresh:async id=>{events.push(['refresh',id]);cache.chat='新来源聊天';}});t.after(stop);
  f.controls.post=async request=>{
   assert.equal(request.signal.aborted,false);assert.equal(f.selection.scopeRevision,7);assert.deepEqual(cache,{chat:null,memory:null,candidate:null});
   if(outcome==='unknown')throw new ports.BackendRequestFailure('connection');
   return {generation:1,data:outcome==='completed'?completedStatus(request.body.request_key):recertifyStatus({request_key:request.body.request_key,state:'failed',stage:'history',failure_code:'history_recertify_source_changed',started_at:100,finished_at:200})};
  };
  await f.controller.recertify({...f.scope,requestKey:`recertify-host-${outcome}`,confirmed:true});assert.equal(pendingContexts,0);
  assert.equal(cache.chat,outcome==='completed'?'新来源聊天':null);assert.equal(cache.memory,null);assert.equal(cache.candidate,null);
  if(outcome==='unknown'){
   await f.controller.refresh(f.scope);assert.equal(cache.chat,null);
   f.controls.status=completedStatus('recertify-host-unknown');await f.controller.refresh(f.scope);assert.equal(cache.chat,'新来源聊天');
  }
  assert.equal(events.filter(([kind])=>kind==='withdraw').length,1);assert.equal(events.filter(([kind])=>kind==='refresh').length,outcome==='failed'?0:1);assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 });
});

test('认证中途切换范围会结清快照复验占用，旧完成回包不刷新新会话',async t=>{
 const f=await recertifyFixture(t);let finish,started,pendingContexts=0,refreshes=0;
 const entered=new Promise(resolve=>{started=resolve;}),response=new Promise(resolve=>{finish=resolve;});
 const stop=ports.coordinateHistoryRecertification(f.controller,{withdraw:()=>{pendingContexts++;},revalidate:async()=>{pendingContexts--;},refresh:async()=>{refreshes++;}});t.after(stop);
 f.controls.post=async()=>{started();return response;};const old=f.controller.recertify({...f.scope,requestKey:'recertify-host-old-scope',confirmed:true});await entered;assert.equal(pendingContexts,1);
 f.select(other);assert.equal(pendingContexts,0);finish({generation:1,data:completedStatus('recertify-host-old-scope')});await old;assert.equal(refreshes,0);
});

test('异步认证短接纳返回running，查询精确原键且不等待全量工作',async t=>{
 const f=await recertifyFixture(t);f.controls.post=async request=>{
  f.controls.status=recertifyStatus({request_key:request.body.request_key,state:'running',stage:'metadata',started_at:100});return {generation:1,data:f.controls.status};
 };
 await f.controller.recertify({...f.scope,requestKey:'recertify-admitted',confirmed:true});
 assert.equal(f.controller.getState().busy,null);assert.equal(f.controller.getState().recertify.state,'running');
 const admission=f.calls.find(call=>call.method==='POST');assert.ok(admission.timeoutMs<=10000);
 await f.controller.refresh(f.scope);assert.ok(f.calls.some(call=>call.method==='GET'&&call.path.endsWith('/recertify?request_key=recertify-admitted')));
});

test('状态GET与接纳POST运输独立，读取进度不能取消或丢弃接纳回包',async t=>{
 const f=await recertifyFixture(t);let started,finish;const entered=new Promise(resolve=>{started=resolve;}),response=new Promise(resolve=>{finish=resolve;});
 f.controls.post=async()=>{started();return response;};const admission=f.controller.recertify({...f.scope,requestKey:'recertify-in-flight',confirmed:true});await entered;
 const post=f.calls.find(call=>call.method==='POST');
 try{await f.controller.refresh(f.scope);assert.equal(post.signal.aborted,false);}
 finally{finish({generation:1,data:recertifyStatus({request_key:'recertify-in-flight',state:'running',stage:'metadata',started_at:100})});await admission;}
 assert.equal(f.controller.getState().recertify.state,'running');assert.equal(f.controller.getState().busy,null);
});

test('切换范围仅精确取消本控制器未知接纳的原键，不取消外部观察任务',async t=>{
 const f=await recertifyFixture(t);f.controls.post=async()=>{throw new ports.BackendRequestFailure('connection');};
 await f.controller.recertify({...f.scope,requestKey:'recertify-owned-unknown',confirmed:true});f.select(other);
 await until(()=>f.calls.some(call=>call.path.endsWith('/recertify/cancel')));
 const cancels=f.calls.filter(call=>call.path.endsWith('/recertify/cancel'));assert.equal(cancels.length,1);assert.deepEqual(cancels[0].body,{request_key:'recertify-owned-unknown'});assert.ok(cancels[0].path.includes(`/contacts/${contact}/`));
 const external=await recertifyFixture(t);external.controls.status=recertifyStatus({request_key:'recertify-external',state:'running',stage:'history',started_at:100});await external.controller.refresh(external.scope);external.select(other);await until(()=>external.controller.getState().phase==='ready');
 assert.equal(external.calls.some(call=>call.path.endsWith('/recertify/cancel')),false);
});

test('显式停止可取消当前观察任务，未知停止可重试同键且不重新接纳',async t=>{
 const f=await recertifyFixture(t);f.controls.status=recertifyStatus({request_key:'recertify-observed',state:'running',stage:'history',started_at:100});await f.controller.refresh(f.scope);
 f.controls.cancel=async()=>{throw new ports.BackendRequestFailure('connection');};
 await f.controller.cancelRecertify({...f.scope,requestKey:'recertify-observed'});
 assert.equal(f.controller.getState().recertifyStoppingKey,'recertify-observed');assert.equal(f.controller.getState().recertifyCancelBusy,false);
 await f.controller.refresh(f.scope);assert.equal(f.controller.getState().recertify.state,'running');
 f.controls.cancel=null;await f.controller.cancelRecertify({...f.scope,requestKey:'recertify-observed'});
 assert.equal(f.controller.getState().recertify.state,'interrupted');assert.equal(f.controller.getState().recertifyStoppingKey,null);
 const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);assert.ok(posts.every(call=>call.path.endsWith('/recertify/cancel')&&call.body.request_key==='recertify-observed'));
 await assert.rejects(f.controller.cancelRecertify({...f.scope,requestKey:'recertify-another-key'}));
});

test('销毁精确停止所持认证，旧取消迟到回包不污染切换后的范围',async t=>{
 const f=await recertifyFixture(t);let finish;const response=new Promise(resolve=>{finish=resolve;});
 f.controls.post=async request=>{f.controls.status=recertifyStatus({request_key:request.body.request_key,state:'running',stage:'history',started_at:100});return {generation:1,data:f.controls.status};};
 await f.controller.recertify({...f.scope,requestKey:'recertify-owned-dispose',confirmed:true});f.controls.cancel=async()=>response;
 f.select(other);await until(()=>f.calls.some(call=>call.path.endsWith('/recertify/cancel')));await until(()=>f.controller.getState().phase==='ready');
 finish({generation:1,data:completedStatus('recertify-owned-dispose')});await new Promise(setImmediate);assert.equal(f.controller.getState().contactId,other);assert.equal(f.controller.getState().recertify.state,'none');
 const disposed=await recertifyFixture(t);disposed.controls.post=f.controls.post;await disposed.controller.recertify({...disposed.scope,requestKey:'recertify-dispose-only',confirmed:true});disposed.controller.dispose();
 await until(()=>disposed.calls.some(call=>call.path.endsWith('/recertify/cancel')));assert.equal(disposed.calls.filter(call=>call.path.endsWith('/recertify/cancel')).length,1);
});

test('精确停止桥仅接受当前范围和原请求键，不接受额外身份字段',async t=>{
 const f=await recertifyFixture(t),handlers=new Map(),roles=new Map();f.controls.status=recertifyStatus({request_key:'recertify-stop-protocol',state:'running',stage:'history',started_at:100});
 const controller=ports.installHistoryClearBridge({handle:(name,handler,role)=>{handlers.set(name,handler);roles.set(name,role);},publish:()=>{}},f.backend,f.contacts);t.after(()=>controller.dispose());await until(()=>controller.getState().phase==='ready');
 const bridge=ports.createHistoryClearBridge({invoke:async(name,...args)=>handlers.get(name)(...args),on:()=>{},removeListener:()=>{}});
 for(const patch of [{confirmed:true},{bindingId:'internal'},{requestKey:'invalid key'}])await assert.rejects(bridge.cancelRecertify({...f.scope,requestKey:'recertify-stop-protocol',...patch}));
 await bridge.cancelRecertify({...f.scope,requestKey:'recertify-stop-protocol'});assert.equal(controller.getState().recertify.state,'interrupted');assert.equal(roles.get('history-clear:recertify-cancel'),'manager');
 assert.deepEqual(f.calls.find(call=>call.path.endsWith('/recertify/cancel')).body,{request_key:'recertify-stop-protocol'});
});

test('迟到running状态不能覆盖已由接纳回包确认的稳定完成',async t=>{
 const f=await recertifyFixture(t);let finishPost,finishGet;
 const postResponse=new Promise(resolve=>{finishPost=resolve;}),getResponse=new Promise(resolve=>{finishGet=resolve;});f.controls.post=async()=>postResponse;
 const admission=f.controller.recertify({...f.scope,requestKey:'recertify-out-of-order',confirmed:true});
 const original=f.backend.requestJson;f.backend.requestJson=async request=>request.method==='GET'&&request.path.includes('/recertify?request_key=')?getResponse:original(request);
 const status=f.controller.refresh(f.scope);finishPost({generation:1,data:completedStatus('recertify-out-of-order')});await admission;
 finishGet({generation:1,data:recertifyStatus({request_key:'recertify-out-of-order',state:'running',stage:'activation',started_at:100})});await status;
 assert.equal(f.controller.getState().recertify.state,'completed');assert.equal(f.controller.getState().recertify.completed,true);
});

test('接纳运输未返回时精确停止终态解除忙碌，迟到接纳不能复活旧操作',async t=>{
 const f=await recertifyFixture(t);let finish;const response=new Promise(resolve=>{finish=resolve;});f.controls.post=async()=>response;
 const old=f.controller.recertify({...f.scope,requestKey:'recertify-admit-stop-race',confirmed:true});
 await f.controller.cancelRecertify({...f.scope,requestKey:'recertify-admit-stop-race'});assert.equal(f.controller.getState().recertify.state,'interrupted');assert.equal(f.controller.getState().busy,null);
 finish({generation:1,data:recertifyStatus({request_key:'recertify-admit-stop-race',state:'running',stage:'metadata',started_at:100})});await old;assert.equal(f.controller.getState().recertify.state,'interrupted');
 f.controls.post=null;await f.controller.recertify({...f.scope,requestKey:'recertify-new-explicit',confirmed:true});assert.equal(f.controller.getState().recertify.completed,true);assert.equal(f.controller.getState().recertify.requestKey,'recertify-new-explicit');
});

test('运行状态读取失败仍保留精确停止目标，但不把外部观察任务变成本地拥有',async t=>{
 for(const stop of [false,true])await t.test(stop?'显式停止':'离开不停止',async t=>{
  const f=await recertifyFixture(t);f.controls.status=recertifyStatus({request_key:'recertify-observed-read-failed',state:'running',stage:'history',started_at:100});await f.controller.refresh(f.scope);
  const original=f.backend.requestJson;f.backend.requestJson=async request=>{if(request.method==='GET'&&request.path.includes('/recertify?'))throw new ports.BackendRequestFailure('connection');return original(request);};
  await f.controller.refresh(f.scope);assert.equal(f.controller.getState().phase,'failed');assert.equal(f.controller.getState().pendingRecertifyKey,'recertify-observed-read-failed');
  if(stop){await f.controller.cancelRecertify({...f.scope,requestKey:'recertify-observed-read-failed'});assert.equal(f.controller.getState().recertify.state,'interrupted');}
  else {f.select(other);await new Promise(setImmediate);assert.equal(f.calls.some(call=>call.path.endsWith('/recertify/cancel')),false);}
 });
});
