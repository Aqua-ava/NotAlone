import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,report,target,record} from './sqlite-clear-support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';
import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
import {IncrementalHistoryCoordinator} from '../src/history/sqlite/incremental-coordinator.ts';

import {recertifySetup,recoveryReader,normalCapabilities,gate} from './fixtures/history/recertify-reader.mjs';
for(const empty of [true,false])test(`原地恢复完成与${empty?'空':'非空'}目标正常预检交错，不重新建立围栏`,{timeout:10000},async t=>{
 const f=await recertifySetup(t,empty?{oldRecords:[],targetOverride:{tables:[]},reportOverride:{profileId:'wechat-4.0.6-29387-absent-private-target-v1',declaredPrimaryKey:[],statusSemantics:'no-message-table-v1',capabilities:{...normalCapabilities,incrementalTail:'unsupported'}}}:{});
 const storage=f.current.storage,history=f.current.history,execute=storage.execute.bind(storage),finalizing=gate(),allowFinalize=gate(),preflightRead=gate(),allowPreflight=gate();let capture=false,normalRead;
 storage.execute=async(name,input,...rest)=>{if(name==='history.recertifyResumeComplete'){finalizing.resolve();await allowFinalize.promise;}const value=await execute(name,input,...rest);if(capture&&name==='history.readPreflight'){capture=false;preflightRead.resolve();await allowPreflight.promise;}return value;};
 try{
  const certification=f.service.recertify(f.contactA,{requestKey:`preflight-race-${empty}`});await finalizing.promise;
  f.channel=f.reader.create();capture=true;normalRead=history.ensureSourceReady(f.contactA).catch(error=>error.code);await preflightRead.promise;
  allowFinalize.resolve();assert.equal((await certification).state,'completed');allowPreflight.resolve();assert.equal(await normalRead,undefined);
  const snapshot=await f.snapshot();assert.equal(snapshot.fences.length,0);assert.equal(snapshot.bindings.length,1);assert.equal((await history.coverage(f.contactA)).phase,'complete');
 }finally{allowFinalize.resolve();allowPreflight.resolve();await Promise.allSettled([normalRead]);storage.execute=execute;}
});

for(const failureCode of ['history_native_timeout','history_source_changed'])test(`正常读者预检期间守卫${failureCode}不混淆瞬时恢复与真实失证`,{timeout:10000},async t=>{
 const reader=recoveryReader(),f=await fixture(t,{registryModule:new URL('./fixtures/history/recertify-registry.mjs',import.meta.url).href}),history=new SqliteHistoryService(f.current.storage,f.current.contacts,reader.create,f.current.holders);
 const directory={directory:async()=>{const saved=await f.current.contacts.directory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===f.contactA)};}};
 const first=new FirstHistoryCoordinator(directory,history),incremental=new IncrementalHistoryCoordinator(directory,history,{intervalMs:0,firstHistoryManagedExternally:true});history.setFirstHistoryWake(id=>first.wakeContact(id));
 const execute=f.current.storage.execute.bind(f.current.storage),preflightRead=gate(),allowPreflight=gate(),released=gate();let capture=false,normalRead;
 try{
  await history.synchronize(f.contactA);await history.ensureSourceReady(f.contactA);const current=reader.state.entries.at(-1);
  f.current.storage.execute=async(name,input,...rest)=>{const value=await execute(name,input,...rest);if(capture&&name==='history.readPreflight'){capture=false;preflightRead.resolve();await allowPreflight.promise;}if(name==='history.guardRelease')released.resolve();return value;};
  capture=true;normalRead=history.ensureSourceReady(f.contactA).catch(error=>error.code);await preflightRead.promise;if(failureCode==='history_source_changed')reader.state.targetOverride.tables=target.tables.map(table=>({...table,instance:table.instance+'-replaced'}));current.code=failureCode;current.loss.resolve();await released.promise;allowPreflight.resolve();await normalRead;
  incremental.wake();await incremental.waitForIdle();await first.waitForIdle();
  // 首次恢复完成后，第二次正常调度节拍接续增量；与宿主事件/轮询唤醒一致，不循环等到成功。
  incremental.wake();await incremental.waitForIdle();await first.waitForIdle();const snapshot=await execute('fixture.recertifySnapshot',{ownerId:f.current.contacts.ownerId,contactId:f.contactA});
  if(failureCode==='history_native_timeout'){assert.equal(snapshot.fences.length,0);assert.equal((await history.coverage(f.contactA)).phase,'complete');assert.ok(['caught_up','waiting_new_messages'].includes(incremental.getState().contacts[0].phase));}
  else{assert.equal(snapshot.fences.length,1);assert.equal((await history.coverage(f.contactA)).failureCode,'history_source_continuity_unverified');}
 }finally{allowPreflight.resolve();await Promise.allSettled([normalRead]);f.current.storage.execute=execute;await Promise.allSettled([incremental.close(),first.close(),history.close()]);}
});
