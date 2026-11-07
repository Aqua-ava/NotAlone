import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
import {IncrementalHistoryCoordinator} from '../src/history/sqlite/incremental-coordinator.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fixture,owner,record,report,createChannel,restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {SqliteHistoryClearHttp} from '../src/history/sqlite/clear-http.ts';

import {recertifySetup,recoveryReader,normalCapabilities,gate} from './fixtures/history/recertify-reader.mjs';
async function setup(t,options={}){
 let f;f=await recertifySetup(t,{...options,stopHistory:async id=>{await options.stopHistory?.(id);await f.current.history.stop(id);}});let hold=gate(),entered=gate();
 f.state.pageHook=async()=>{entered.resolve();await hold.promise;};f.state.closeHook=async entry=>{if(entry.reading&&f.channels.includes(entry.channel))hold.resolve();};
 return Object.assign(f,{entered:()=>entered.promise,release:()=>hold.resolve(),next:()=>{hold=gate();entered=gate();}});
}
test('持久接纳短返回running，同key不重复启动，精确GET状态不启动渠道', {timeout:5000},async t=>{
 const f=await setup(t),accepted=await f.service.admit(f.contactA,{requestKey:'async-one'});assert.equal(accepted.state,'running');assert.equal(accepted.completed,false);
 await f.entered();const count=f.channels.length;assert.equal(count,1);
 assert.equal((await f.service.status(f.contactA,'async-one')).state,'running');assert.equal((await f.service.status(f.contactA,'unknown-key')).state,'none');
 assert.equal((await f.service.admit(f.contactA,{requestKey:'async-one'})).state,'running');assert.equal(f.channels.length,count);
 f.release();assert.equal((await f.service.recertify(f.contactA,{requestKey:'async-one'})).state,'completed');
});
test('取消早于接纳持久阻止同key启动，重启后仍不读来源', {timeout:5000},async t=>{
 const f=await setup(t),cancelled=await f.service.cancel(f.contactA,{requestKey:'cancel-before-admission'});
 assert.equal(cancelled.state,'interrupted');assert.equal(cancelled.stage,'metadata');assert.equal(cancelled.failure_code,'history_recertify_cancelled');assert.equal(cancelled.request_key,'cancel-before-admission');
 assert.equal((await f.service.admit(f.contactA,{requestKey:'cancel-before-admission'})).state,'interrupted');assert.equal(f.channels.length,0);
 await f.service.close();const current=await restart(f,t);assert.equal((await current.recertify.status(f.contactA,'cancel-before-admission')).state,'interrupted');
 assert.equal((await current.recertify.admit(f.contactA,{requestKey:'cancel-before-admission'})).state,'interrupted');
});
test('取消只停止精确key，重复旧取消不误停另一个新任务', {timeout:5000},async t=>{
 const f=await setup(t);await f.service.admit(f.contactA,{requestKey:'first'});await f.entered();
 const stopped=await f.service.cancel(f.contactA,{requestKey:'first'});assert.ok(['running','interrupted'].includes(stopped.state));
 assert.equal((await f.service.recertify(f.contactA,{requestKey:'first'})).state,'interrupted');
 f.next();await f.service.admit(f.contactA,{requestKey:'second'});await f.entered();
 assert.equal((await f.service.cancel(f.contactA,{requestKey:'first'})).state,'interrupted');assert.equal((await f.service.status(f.contactA,'second')).state,'running');
 f.release();assert.equal((await f.service.recertify(f.contactA,{requestKey:'second'})).state,'completed');
});
test('原地恢复收尾前仍running，ResumeComplete之前取消不能发布completed', {timeout:5000},async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage),finalizing=gate(),allowFinalize=gate();t.after(()=>allowFinalize.resolve());
 f.current.storage.execute=async(name,input,...rest)=>{if(name==='history.recertifyResumeComplete'){finalizing.resolve();await allowFinalize.promise;}return execute(name,input,...rest);};
 await f.service.admit(f.contactA,{requestKey:'cancel-finalize'});await f.entered();f.release();await finalizing.promise;
 const visible=await f.service.status(f.contactA,'cancel-finalize');assert.equal(visible.state,'running');assert.equal(visible.completed,false);assert.equal((await f.snapshot()).bindings.length,1);
 await f.service.cancel(f.contactA,{requestKey:'cancel-finalize'});allowFinalize.resolve();
 const result=await f.service.recertify(f.contactA,{requestKey:'cancel-finalize'});assert.equal(result.state,'interrupted');assert.equal(result.failure_code,'history_recertify_cancelled');assert.equal((await f.snapshot()).fences.length,1);
});
test('ResumeComplete后completed稳定，迟到取消与本任务Fail不能改写成功或重造围栏', {timeout:5000},async t=>{
 const f=await setup(t);await f.service.admit(f.contactA,{requestKey:'stable-completed'});await f.entered();f.release();const done=await f.service.recertify(f.contactA,{requestKey:'stable-completed'});
 assert.equal(done.state,'completed');assert.deepEqual(await f.service.cancel(f.contactA,{requestKey:'stable-completed'}),done);
 const snapshot=await f.snapshot(),op=snapshot.operations[0];assert.equal(await f.current.storage.execute('history.recertifyFail',{ownerId:owner,id:op.id,code:'history_native_closed',stage:'activation',at:Date.now()}),false);
 assert.equal((await f.service.status(f.contactA,'stable-completed')).state,'completed');assert.equal((await f.snapshot()).fences.length,0);
 const currentMessage=snapshot.messages.find(m=>m.binding_id===op.old_binding_id),source=snapshot.captures.find(r=>r.message_id===currentMessage.id);
 await assert.rejects(f.current.storage.execute('history.source',{ownerId:owner,contactId:f.contactA,recordId:source.id}),{code:'history_source_not_found'});
});
test('HTTP响应未知后accepted任务不因连接结束取消，精确GET和取消无需重发POST', {timeout:5000},async t=>{
 const f=await setup(t),http=new SqliteHistoryClearHttp(f.current.clear,f.current.resync,f.service);let drop=true;
 const server=createServer((req,res)=>{if(req.method==='POST'&&drop){drop=false;res.end=()=>{res.destroy();return res;};}void http.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}/history/recertify`;
 await assert.rejects(fetch(url,{method:'POST',body:JSON.stringify({request_key:'lost-accepted'})}));await f.entered();
 const known=await (await fetch(url+'?request_key=lost-accepted')).json();assert.equal(known.state,'running');assert.equal(f.channels.length,1);
 assert.equal((await fetch(url+'?request_key=a&request_key=b')).status,400);
 const cancelled=await fetch(url+'/cancel',{method:'POST',body:JSON.stringify({request_key:'lost-accepted'})});assert.equal(cancelled.status,200);
 assert.equal((await f.service.recertify(f.contactA,{requestKey:'lost-accepted'})).state,'interrupted');assert.equal(f.channels.length,1);
});
test('持久取消意图随联系人/账号删除清除，来源删除保留重放抑制', {timeout:5000},async t=>{
 for(const kind of ['source','contact','account']){
  const f=await setup(t);await f.service.cancel(f.contactA,{requestKey:`tombstone-${kind}`});
  const source=f.saved.sourceRecordIds[0];
  const scope=kind==='account'?{kind}:kind==='contact'?{kind,contactId:f.contactA}:{kind,contactId:f.contactA,sourceId:source};
  const plan=await f.current.deletion.plan({ownerId:owner,requestKey:`delete-cancel-intent-${kind}`,scope});assert.equal((await f.current.deletion.advance(plan)).state,'completed');
  const view=await f.service.status(f.contactA,`tombstone-${kind}`);assert.equal(view.state,kind==='source'?'interrupted':'none');assert.equal(f.channels.length,0);
 }
});

test('接纳不等待旧reader关闭，持久接纳后HTTP signal撤销不取消后台任务', {timeout:5000},async t=>{
 const drain=gate(),draining=gate(),controller=new AbortController(),f=await setup(t,{stopHistory:async()=>{draining.resolve();await drain.promise;}});
 const admitted=await f.service.admit(f.contactA,{requestKey:'slow-old-reader',signal:controller.signal});assert.equal(admitted.state,'running');await draining.promise;assert.equal(f.channels.length,0);
 controller.abort();drain.resolve();await f.entered();f.release();assert.equal((await f.service.recertify(f.contactA,{requestKey:'slow-old-reader'})).state,'completed');
});
test('取消与持久接纳竞争，取消先落盘便不创建操作或渠道', {timeout:5000},async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage),preparing=gate(),allowPrepare=gate();
 f.current.storage.execute=async(name,input,...rest)=>{if(name==='history.recertifyPrepare'){preparing.resolve();await allowPrepare.promise;}return execute(name,input,...rest);};
 const admission=f.service.admit(f.contactA,{requestKey:'race-before-prepare'});await preparing.promise;
 assert.equal((await f.service.cancel(f.contactA,{requestKey:'race-before-prepare'})).state,'interrupted');allowPrepare.resolve();
 assert.equal((await admission).state,'interrupted');assert.equal((await f.snapshot()).operations.length,0);assert.equal(f.channels.length,0);
});
test('取消已发出但native close未确认时仍running，实际停止后才interrupted', {timeout:5000},async t=>{
 const f=await setup(t),closeEntered=gate(),allowClose=gate();await f.service.admit(f.contactA,{requestKey:'slow-close'});await f.entered();
 f.channels[0].close=async()=>{closeEntered.resolve();f.release();await allowClose.promise;};
 const cancelling=await f.service.cancel(f.contactA,{requestKey:'slow-close'});await closeEntered.promise;assert.equal(cancelling.state,'running');assert.equal((await f.service.status(f.contactA,'slow-close')).state,'running');
 allowClose.resolve();const done=await f.service.recertify(f.contactA,{requestKey:'slow-close'});assert.equal(done.state,'interrupted');assert.equal(done.failure_code,'history_recertify_cancelled');assert.equal((await f.service.status(f.contactA)).page_count,done.page_count);
});

test('渠道close已resolve但保留来源故障码时不能Finalize成功', {timeout:5000},async t=>{
 const f=await setup(t);await f.service.admit(f.contactA,{requestKey:'close-preserved-loss'});await f.entered();
 let code=null;f.channels[0].guardSession.failureCode=()=>code;f.channels[0].close=async()=>{code='history_source_changed';};f.release();
 const result=await f.service.recertify(f.contactA,{requestKey:'close-preserved-loss'});assert.equal(result.state,'failed');assert.equal(result.stage,'history');assert.equal(result.failure_code,'history_source_changed');assert.equal((await f.snapshot()).fences.length,1);
});

test('已持久记录guard故障但关闭尚未完成即重启，保留原始固定原因和阶段', {timeout:5000},async t=>{
 const f=await setup(t),pending=f.service.recertify(f.contactA,{requestKey:'known-loss-restart'});pending.catch(()=>{});await f.entered();
 const op=(await f.snapshot()).operations[0];await f.current.storage.execute('history.recertifyNoteFailure',{ownerId:owner,id:op.id,code:'history_source_changed',at:Date.now()});
 await f.current.storage.close();f.release();await assert.rejects(pending,{code:'worker_failed'});await f.service.close();
 const current=await restart(f,t),status=await current.recertify.status(f.contactA,'known-loss-restart');assert.equal(status.state,'interrupted');assert.equal(status.stage,'history');assert.equal(status.failure_code,'history_source_changed');const saved=await f.snapshot();assert.equal(saved.fences.length,1);await assert.rejects(f.current.storage.execute('fixture.recertifyAssertSource',{owner_id:owner,contact_id:f.contactA,record_id:f.saved.sourceRecordIds[0],message_id:f.saved.id}),{code:'history_source_not_available'});
});

test('仅成功收尾后通知一次本contact，native和holder未确认完成前不通知', {timeout:5000},async t=>{
 const calls=[],f=await setup(t,{onCompleted:id=>calls.push(id)}),closeEntered=gate(),allowClose=gate(),holderReleased=gate(),allowHolder=gate(),register=f.current.holders.register.bind(f.current.holders);
 f.current.holders.register=resource=>{const release=register(resource);return resource.key.startsWith('history:recertify_')?async()=>{await release();holderReleased.resolve();await allowHolder.promise;}:release;};
 const pending=f.service.recertify(f.contactA,{requestKey:'notify-after-cleanup'});await f.entered();f.channels[0].close=async()=>{closeEntered.resolve();await allowClose.promise;};f.release();await closeEntered.promise;
 assert.equal((await f.service.status(f.contactA,'notify-after-cleanup')).state,'running');assert.deepEqual(calls,[]);allowClose.resolve();await holderReleased.promise;
 assert.equal((await f.service.status(f.contactA,'notify-after-cleanup')).state,'completed');assert.deepEqual(calls,[]);allowHolder.resolve();assert.equal((await pending).state,'completed');assert.deepEqual(calls,[f.contactA]);
 await f.service.admit(f.contactA,{requestKey:'notify-after-cleanup'});assert.deepEqual(calls,[f.contactA]);
});
test('成功通知抛错或异步拒绝不翻转completed且幂等查询不再次通知', {timeout:5000},async t=>{
 for(const asynchronous of [false,true]){
  let count=0;const f=await setup(t,{onCompleted:()=>{count++;if(asynchronous)return Promise.reject(Error('合成通知拒绝'));throw Error('合成通知失败');}});
  const pending=f.service.recertify(f.contactA,{requestKey:'notify-failed'});await f.entered();f.release();const done=await pending;assert.equal(done.state,'completed');assert.equal(count,1);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(await f.service.admit(f.contactA,{requestKey:'notify-failed'}),done);assert.equal(count,1);assert.equal((await f.snapshot()).fences.length,0);
 }
});
test('失败取消或应用退出不发成功通知，退出收尾中的稳定completed也不唤醒', {timeout:5000},async t=>{
 for(const mode of ['failed','cancelled','closed','closed-completed']){
  const calls=[],f=await setup(t,{onCompleted:id=>calls.push(id)}),holderReleased=gate(),allowHolder=gate();
  if(mode==='closed-completed'){const register=f.current.holders.register.bind(f.current.holders);f.current.holders.register=resource=>{const release=register(resource);return resource.key.startsWith('history:recertify_')?async()=>{await release();holderReleased.resolve();await allowHolder.promise;}:release;};}
  const pending=f.service.recertify(f.contactA,{requestKey:`no-notify-${mode}`});await f.entered();
  if(mode==='failed'){f.channels[0].guardSession.failureCode=()=> 'history_source_changed';f.release();}
  if(mode==='cancelled')await f.service.cancel(f.contactA,{requestKey:`no-notify-${mode}`});
  if(mode==='closed')await f.service.close();
  if(mode==='closed-completed'){f.release();await holderReleased.promise;assert.equal((await f.service.status(f.contactA)).state,'completed');const closing=f.service.close();allowHolder.resolve();await closing;}
  const done=await pending;assert.equal(done.state,mode==='failed'?'failed':mode==='closed-completed'?'completed':'interrupted');assert.deepEqual(calls,[]);
 }
});
test('成功通知接真实FirstHistory及SQLite续读，不换绑定也不重排他人',{timeout:10000},async t=>{
 let first;const f=await setup(t,{onCompleted:id=>first.wakeContact(id)}),normal=recoveryReader(),history=new SqliteHistoryService(f.current.storage,f.current.contacts,normal.create,f.current.holders);
 const directory={directory:async()=>{const saved=await f.current.contacts.directory();return {...saved,bindings:saved.bindings.filter(b=>b.contact_id===f.contactA)};}};
 first=new FirstHistoryCoordinator(directory,history);const incremental=new IncrementalHistoryCoordinator(directory,history,{firstHistoryManagedExternally:true,intervalMs:0});
 try{
  const before=await f.snapshot(),pending=f.service.recertify(f.contactA,{requestKey:'notify-normal-coordinator'});await f.entered();f.release();assert.equal((await pending).state,'completed');await first.waitForIdle();
  const after=await f.snapshot();assert.equal((await history.coverage(f.contactA)).phase,'complete');assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,f.old.binding_id);assert.deepEqual(after.bindings,before.bindings);assert.equal(after.operations.length,1);assert.equal(after.fences.length,0);assert.equal(after.messages.length,before.messages.length);
  assert.equal(normal.state.channels.length,1);assert.deepEqual(normal.state.readIds,[],'调度恢复沿已有水位，不重读旧正文');
  incremental.wake();await incremental.waitForIdle();assert.equal((await history.coverage(f.contactA)).incremental.phase,'ready');assert.equal((await f.snapshot()).operations.length,1);
 }finally{f.release();await incremental.close();await first.close();await history.close();}
});

test('取消早于接纳的终态也返回固定完整形状，页面与批量解析不会因缺键失败', {timeout:5000},async t=>{
 const f=await setup(t);
 const cancelled=await f.service.cancel(f.contactA,{requestKey:'cancel-shape-before-admission'});
 const keys=['contact_id','request_key','state','stage','completed','failure_code','message_count','non_text_count','page_count','preserved_message_count','started_at','finished_at'];
 assert.deepEqual(Object.keys(cancelled).sort(),[...keys].sort());
 assert.equal(cancelled.state,'interrupted');assert.equal(cancelled.completed,false);assert.equal(cancelled.stage,'metadata');
 assert.equal(cancelled.failure_code,'history_recertify_cancelled');assert.equal(cancelled.page_count,0);
 assert.equal(cancelled.preserved_message_count,0);assert.ok(cancelled.started_at!==null);assert.ok(cancelled.finished_at!==null);
 const http=new SqliteHistoryClearHttp(f.current.clear,f.current.resync,f.service);
 const server=createServer((req,res)=>{void http.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}/history/recertify?request_key=cancel-shape-before-admission`);
 assert.equal(response.status,200);const body=await response.json();
 assert.deepEqual(Object.keys(body).sort(),[...keys].sort());
 assert.equal(body.state,'interrupted');assert.equal(body.failure_code,'history_recertify_cancelled');
});
