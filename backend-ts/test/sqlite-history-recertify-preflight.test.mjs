import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,report,target,record} from './sqlite-clear-support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
import {IncrementalHistoryCoordinator} from '../src/history/sqlite/incremental-coordinator.ts';

for(const empty of [true,false])test(`正式来源认证完成与${empty?'空':'非空'}目标的正常读者预检交错，不重新建立围栏`,{timeout:5000},async t=>{
 const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)},{registryModule:new URL('./fixtures/history/recertify-registry.mjs',import.meta.url).href});
 const chosenTarget={...target,...(empty?{tables:[],checkedPartitions:[...target.partitions]}:{})};
 f.state.pageRecords=empty?[]:[record('shard-a','1')];
 f.state.inspectFactory=scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,
  continuity:'same-source-instances-normal-use-v1',...(empty?{profileId:'wechat-4.0.6-29387-absent-private-target-v1',declaredPrimaryKey:[],statusSemantics:'no-message-table-v1'}:{}),
  capabilities:{normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported',sourceLifecycle:'supported',restartContinuity:'supported',recoveryMapping:'supported',partitionGrowth:'supported',incrementalTail:empty?'unsupported':'supported'}});
 f.channel.guardSession={loss:new Promise(()=>{})};f.channel.target=async()=>chosenTarget;
 f.state.pageFactory=async(_scope,cursor)=>({target:chosenTarget.descriptor,cursorIn:cursor,cursorOut:null,records:f.state.pageRecords,completedPartitions:[...chosenTarget.partitions],exhausted:true,...(empty?{}:{resumeCursor:'synthetic-tail'})});
 f.channel.tail=async(_scope,used,cursor)=>({target:used.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true});
 const history=f.current.history,storage=f.current.storage,ownerId=f.current.contacts.ownerId;
 const directory={directory:async()=>{const saved=await f.current.contacts.directory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===f.contactA)};}};
 const first=new FirstHistoryCoordinator(directory,history),incremental=new IncrementalHistoryCoordinator(directory,history,{intervalMs:0,firstHistoryManagedExternally:true});
 history.setFirstHistoryWake(id=>first.wakeContact(id));
 const recertify=new SqliteHistoryRecertifyService(storage,f.current.contacts,()=>({...f.channel,guardSession:{loss:new Promise(()=>{})}}),f.current.holders,{stopHistory:id=>history.stop(id),onCompleted:id=>first.wakeContact(id)});
 const execute=storage.execute.bind(storage),finalizing=Promise.withResolvers(),allowFinalize=Promise.withResolvers(),preflightRead=Promise.withResolvers(),allowPreflight=Promise.withResolvers();
 let capture=false,normalRead,certification;
 storage.execute=async(name,input,...rest)=>{
  if(name==='history.recertifyFinalize'){finalizing.resolve();await allowFinalize.promise;}
  const value=await execute(name,input,...rest);
  // 固定围栏仍存在时的预检结果，再让认证提交；合并前后均在真实存储动作边界安排竞态。
  if(capture&&['history.normalUseRevalidationCandidate','history.readPreflight'].includes(name)&&(value===false||value?.ok===false)){
   capture=false;preflightRead.resolve();await allowPreflight.promise;
  }
  return value;
 };
 t.after(async()=>{allowFinalize.resolve();allowPreflight.resolve();await Promise.allSettled([normalRead,certification]);storage.execute=execute;await incremental.close();await first.close();await recertify.close();for(const clean of cleanup.reverse())await clean();});
 await history.synchronize(f.contactA);await history.stop(f.contactA);
 await storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(f.contactA)});
 certification=recertify.recertify(f.contactA,{requestKey:`synthetic-preflight-race-${empty}`});await finalizing.promise;
 capture=true;normalRead=history.ensureSourceReady(f.contactA).catch(error=>error.code);await preflightRead.promise;
 allowFinalize.resolve();assert.equal((await certification).state,'completed');allowPreflight.resolve();await normalRead;
 await first.waitForIdle();incremental.wake();await incremental.waitForIdle();await first.waitForIdle();
 const snapshot=await execute('fixture.recertifySnapshot',{ownerId,contactId:f.contactA});
 assert.equal(snapshot.fences.length,0,'不能用认证提交前的旧false结果给已完成的新来源重新建立围栏');
 assert.equal((await recertify.status(f.contactA,`synthetic-preflight-race-${empty}`)).state,'completed');
 assert.equal((await history.coverage(f.contactA)).phase,'complete');
 assert.ok(['caught_up','waiting_new_messages'].includes(incremental.getState().contacts[0].phase));
});

for(const failureCode of ['history_native_timeout','history_source_changed'])test(`正常读者预检期间守卫${failureCode}不混淆瞬时恢复与真实失证`,{timeout:5000},async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)},{registryModule:new URL('./fixtures/history/recertify-registry.mjs',import.meta.url).href});
 let current,capture=false;
 const history=new SqliteHistoryService(f.current.storage,f.current.contacts,()=>{
  const loss=Promise.withResolvers(),state={loss,code:null};current=state;
  return {...f.channel,guardSession:{loss:loss.promise,failureCode:()=>state.code},
   inspect:async scope=>({...await f.channel.inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported'}}),
   page:async(_scope,fixed,cursor)=>({target:fixed.descriptor,cursorIn:cursor,cursorOut:null,records:[record('shard-a','1')],completedPartitions:fixed.partitions,exhausted:true,resumeCursor:'synthetic-tail'}),
   tail:async(_scope,fixed,cursor)=>({target:fixed.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true}),close:async()=>loss.resolve()};
 });
 const directory={directory:async()=>{const saved=await f.current.contacts.directory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===f.contactA)};}};
 const first=new FirstHistoryCoordinator(directory,history),incremental=new IncrementalHistoryCoordinator(directory,history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 history.setFirstHistoryWake(id=>first.wakeContact(id));
 const execute=f.current.storage.execute.bind(f.current.storage),preflightRead=Promise.withResolvers(),allowPreflight=Promise.withResolvers(),released=Promise.withResolvers();let normalRead;
 f.current.storage.execute=async(name,input,...rest)=>{
  const value=await execute(name,input,...rest);
  if(capture&&['history.normalUseRevalidationCandidate','history.readPreflight'].includes(name)&&(value===false||value?.metadataRevalidation===false)){
   capture=false;preflightRead.resolve();await allowPreflight.promise;
  }
  if(name==='history.guardRelease')released.resolve();return value;
 };
 t.after(async()=>{allowPreflight.resolve();await Promise.allSettled([normalRead]);f.current.storage.execute=execute;await incremental.close();await first.close();await history.close();for(const clean of cleanup.reverse())await clean();});
 await history.synchronize(f.contactA);capture=true;normalRead=history.ensureSourceReady(f.contactA).catch(error=>error.code);await preflightRead.promise;
 current.code=failureCode;current.loss.resolve();await released.promise;allowPreflight.resolve();await normalRead;
 incremental.wake();await incremental.waitForIdle();await first.waitForIdle();incremental.start();t.mock.timers.tick(30_000);await incremental.waitForIdle();await first.waitForIdle();
 const snapshot=await execute('fixture.recertifySnapshot',{ownerId:f.current.contacts.ownerId,contactId:f.contactA});
 if(failureCode==='history_native_timeout'){
  assert.equal(snapshot.fences.length,0,'瞬时守卫丢失不能被分步预检变成永久来源围栏');
  assert.equal((await history.coverage(f.contactA)).phase,'complete');
  assert.equal(incremental.getState().contacts[0].phase,'caught_up','正常tick应在首次恢复后继续增量，不需要用户唤醒');
 }else{
  assert.equal(snapshot.fences.length,1,'真实来源变化必须保持围栏');
  assert.equal(first.getState().contacts.length,0,'真实围栏不能自动唤醒首次认证');
  assert.equal((await history.coverage(f.contactA)).failureCode,'history_source_continuity_unverified');
 }
});
