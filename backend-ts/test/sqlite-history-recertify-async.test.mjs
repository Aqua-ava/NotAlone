import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fixture,owner,record,report,createChannel,restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {SqliteHistoryClearHttp} from '../src/history/sqlite/clear-http.ts';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function setup(t,options={}){
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/recertify-registry.mjs',import.meta.url).href});f.state.pageRecords=[record('shard-a','1')];
 await f.current.history.synchronize(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(f.contactA)});
 const channels=[];let hold=gate(),entered=gate();
 const create=()=>{const {channel,state}=createChannel(),thisHold=hold,thisEntered=entered;let reading=false;
  channel.guardSession={loss:new Promise(()=>{})};state.pageRecords=[record('shard-a','1')];
  state.inspectFactory=scope=>({...report,continuity:'same-source-instances-normal-use-v1',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
  state.pageHook=async()=>{reading=true;thisEntered.resolve();await thisHold.promise;};channel.close=async()=>{if(reading)thisHold.resolve();};channels.push(channel);return channel;};
 const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,create,f.current.holders,{stopHistory:id=>f.current.history.stop(id),...options});t.after(()=>service.close());
 return {...f,service,channels,entered:()=>entered.promise,release:()=>hold.resolve(),next:()=>{hold=gate();entered=gate();},snapshot:()=>f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId:f.contactA})};
}
test('持久接纳短返回running，同key不重复启动，精确GET状态不启动渠道', {timeout:5000},async t=>{
 const f=await setup(t),accepted=await f.service.admit(f.contactA,{requestKey:'async-one'});assert.equal(accepted.state,'running');assert.equal(accepted.completed,false);
 await f.entered();const count=f.channels.length;assert.equal(count,2);
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
test('Seal和清洁关闭期间仍running且围栏保留，Finalize之前取消不能发布completed', {timeout:5000},async t=>{
 const f=await setup(t),execute=f.current.storage.execute.bind(f.current.storage),finalizing=gate(),allowFinalize=gate();
 f.current.storage.execute=async(name,input,...rest)=>{if(name==='history.recertifyFinalize'){finalizing.resolve();await allowFinalize.promise;}return execute(name,input,...rest);};
 await f.service.admit(f.contactA,{requestKey:'cancel-finalize'});await f.entered();f.release();await finalizing.promise;
 const visible=await f.service.status(f.contactA,'cancel-finalize');assert.equal(visible.state,'running');assert.equal(visible.stage,'activation');assert.equal(visible.completed,false);assert.equal((await f.snapshot()).fences.length,1);
 await f.service.cancel(f.contactA,{requestKey:'cancel-finalize'});allowFinalize.resolve();
 const result=await f.service.recertify(f.contactA,{requestKey:'cancel-finalize'});assert.equal(result.state,'interrupted');assert.equal(result.failure_code,'history_recertify_cancelled');assert.equal((await f.snapshot()).fences.length,1);
});
test('Finalize后completed稳定，迟到取消与本任务Fail不能改写成功或重造围栏', {timeout:5000},async t=>{
 const f=await setup(t);await f.service.admit(f.contactA,{requestKey:'stable-completed'});await f.entered();f.release();const done=await f.service.recertify(f.contactA,{requestKey:'stable-completed'});
 assert.equal(done.state,'completed');assert.deepEqual(await f.service.cancel(f.contactA,{requestKey:'stable-completed'}),done);
 const snapshot=await f.snapshot(),op=snapshot.operations[0];assert.equal(await f.current.storage.execute('history.recertifyFail',{ownerId:owner,id:op.id,code:'history_native_closed',stage:'activation',at:Date.now()}),false);
 assert.equal((await f.service.status(f.contactA,'stable-completed')).state,'completed');assert.equal((await f.snapshot()).fences.length,0);
 const currentMessage=snapshot.messages.find(m=>m.binding_id===op.new_binding_id),source=snapshot.captures.find(r=>r.message_id===currentMessage.id);
 await assert.rejects(f.current.storage.execute('history.source',{ownerId:owner,contactId:f.contactA,recordId:source.id}),{code:'history_source_not_found'});
});
test('HTTP响应未知后accepted任务不因连接结束取消，精确GET和取消无需重发POST', {timeout:5000},async t=>{
 const f=await setup(t),http=new SqliteHistoryClearHttp(f.current.clear,f.current.resync,f.service);let drop=true;
 const server=createServer((req,res)=>{if(req.method==='POST'&&drop){drop=false;res.end=()=>{res.destroy();return res;};}void http.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}/history/recertify`;
 await assert.rejects(fetch(url,{method:'POST',body:JSON.stringify({request_key:'lost-accepted'})}));await f.entered();
 const known=await (await fetch(url+'?request_key=lost-accepted')).json();assert.equal(known.state,'running');assert.equal(f.channels.length,2);
 assert.equal((await fetch(url+'?request_key=a&request_key=b')).status,400);
 const cancelled=await fetch(url+'/cancel',{method:'POST',body:JSON.stringify({request_key:'lost-accepted'})});assert.equal(cancelled.status,200);
 assert.equal((await f.service.recertify(f.contactA,{requestKey:'lost-accepted'})).state,'interrupted');assert.equal(f.channels.length,2);
});
test('持久取消意图随联系人/账号删除清除，来源删除保留重放抑制', {timeout:5000},async t=>{
 for(const kind of ['source','contact','account']){
  const f=await setup(t);await f.service.cancel(f.contactA,{requestKey:`tombstone-${kind}`});
  const stored=await f.current.history.read(f.contactA),source=stored.messages[0].sourceRecordIds[0];
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
 f.channels[1].close=async()=>{closeEntered.resolve();f.release();await allowClose.promise;};
 const cancelling=await f.service.cancel(f.contactA,{requestKey:'slow-close'});await closeEntered.promise;assert.equal(cancelling.state,'running');assert.equal((await f.service.status(f.contactA,'slow-close')).state,'running');
 allowClose.resolve();const done=await f.service.recertify(f.contactA,{requestKey:'slow-close'});assert.equal(done.state,'interrupted');assert.equal(done.failure_code,'history_recertify_cancelled');assert.equal((await f.service.status(f.contactA)).page_count,done.page_count);
});

test('渠道close已resolve但保留来源故障码时不能Finalize成功', {timeout:5000},async t=>{
 const f=await setup(t);await f.service.admit(f.contactA,{requestKey:'close-preserved-loss'});await f.entered();
 let code=null;f.channels[1].guardSession.failureCode=()=>code;f.channels[1].close=async()=>{code='history_source_changed';};f.release();
 const result=await f.service.recertify(f.contactA,{requestKey:'close-preserved-loss'});assert.equal(result.state,'failed');assert.equal(result.stage,'activation');assert.equal(result.failure_code,'history_source_changed');assert.equal((await f.snapshot()).fences.length,1);
});

test('已持久记录guard故障但关闭尚未完成即重启，保留原始固定原因和阶段', {timeout:5000},async t=>{
 const f=await setup(t),pending=f.service.recertify(f.contactA,{requestKey:'known-loss-restart'});pending.catch(()=>{});await f.entered();
 const op=(await f.snapshot()).operations[0];await f.current.storage.execute('history.recertifyNoteFailure',{ownerId:owner,id:op.id,code:'history_source_changed',at:Date.now()});
 await f.current.storage.close();f.release();await assert.rejects(pending,{code:'worker_failed'});await f.service.close();
 const current=await restart(f,t),status=await current.recertify.status(f.contactA,'known-loss-restart');assert.equal(status.state,'interrupted');assert.equal(status.stage,'history');assert.equal(status.failure_code,'history_source_changed');assert.equal((await current.history.readChat(f.contactA)).messages.length,0);
});
