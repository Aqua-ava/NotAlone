import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';

async function strictTargetFixture(t) {
 const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
 const state = { tail: Promise.resolve(), current: null, serial: 0, pages: 0, created: 0, sharedActive:false, beforeInspect:null, beforePage:null, beforeClose:null };
 const shared = { async run(_owner, work, _release, signal) {
  const previous = state.tail; let unlock; state.tail = new Promise(resolve => { unlock = resolve; }); await previous;
  try {
   assert.equal(signal?.aborted ?? false, false);
   state.sharedActive=true;return await work({});
  } finally { state.sharedActive=false;unlock(); }
 } };
 const create = () => {
  const loss = Promise.withResolvers();state.created++;
  const select = (scope, target) => state.current = { contactId: scope.token.contact_id,
   target: { ...target, descriptor: `snapshot-${++state.serial}` }, tailCursor: null };
  const current = (scope, target) => {
   if (scope.token.contact_id !== state.current?.contactId || target.descriptor !== state.current?.target.descriptor)
    throw new StorageFailure('history_target_unverified');
   return state.current;
  };
  return { ...f.channel, guardSession: { loss: loss.promise },
   inspect: async scope => {const before=state.beforeInspect;state.beforeInspect=null;await before?.();return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
    capabilities: { incrementalTail: 'supported', durableIncremental: 'supported' } };},
   target: async scope => select(scope, f.target).target,
   resumeTarget: async (scope, previous) => select(scope, previous).target,
   page: async (scope, target, cursor) => {
    const before=state.beforePage;state.beforePage=null;await before?.();
    const selected = current(scope, target);state.pages++;
    selected.tailCursor = `checkpoint-${state.serial}`;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
     records: [record('1', { text: `合成历史：${scope.conversationKey}` })], completedPartitions: ['shard-a'],
     exhausted: true, resumeCursor: selected.tailCursor };
   },
   tail: async () => assert.fail('来源准备和首次历史不读取增量页'),
   close: async () => {const before=state.beforeClose;state.beforeClose=null;await before?.();state.current=null;loss.resolve();},
  };
 };
 const history = new SqliteHistoryService(f.storage, f.contacts, create, undefined, undefined, undefined, shared);
 t.after(async () => { await history.close(); await f.service.close(); for (const fn of cleanup.reverse()) await fn(); });
 return { ...f, history, state };
}

import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
async function pendingFixture(t){
 const f=await strictTargetFixture(t),[a,b]=f.saved;await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 f.state.beforePage=()=>{throw new StorageFailure('history_native_timeout');};
 await assert.rejects(f.history.synchronize(a.contact_id),{code:'history_native_timeout'});
 const pending=await f.history.coverage(a.contact_id);assert.equal(pending.phase,'incomplete');assert.equal(pending.pageCount,0);
 return {...f,a,b,pending};
}
test('来源元数据成功重验释放租约后仅唤醒首次协调器，协调器自动补齐旧未完目标',async t=>{
 const cleanup=[],f=await pendingFixture({after:fn=>cleanup.push(fn)});
 const directory={directory:async()=>{const d=await f.contacts.syncDirectory();return {...d,bindings:d.bindings.filter(x=>x.contact_id===f.a.contact_id)};}};
 const first=new FirstHistoryCoordinator(directory,f.history);t.after(async()=>{await first.close();for(const fn of cleanup.reverse())await fn();});
 const pages=f.state.pages,actions=[],execute=f.storage.execute.bind(f.storage),wakes=[];let preparing=true;
 f.storage.execute=(name,input,...rest)=>{if(preparing)actions.push(name);return execute(name,input,...rest);};
 f.history.setFirstHistoryWake(id=>{wakes.push({id,active:f.state.sharedActive,pages:f.state.pages});preparing=false;first.wakeContact(id);});
 await f.history.ensureSourceReady(f.a.contact_id);preparing=false;
 assert.deepEqual(wakes,[{id:f.a.contact_id,active:false,pages}]);assert.ok(!actions.includes('history.begin'),'来源准备本身不创建新历史目标');await first.waitForIdle();
 const result=await f.history.coverage(f.a.contact_id);assert.equal(result.phase,'complete');assert.notEqual(result.goalId,f.pending.goalId);assert.equal(f.state.pages,pages+1);
 const completedPages=f.state.pages;
 f.history.setFirstHistoryWake(id=>first.wakeContact(id));await f.history.ensureSourceReady(f.a.contact_id);await first.waitForIdle();
 assert.equal(f.state.pages,completedPages,'刷新来源元数据不会重复读取已完成历史');
});
for(const mode of ['revoked','inspect_failed','close_failed'])test(`来源准备${mode}失败不发完成唤醒或读取正文`,async t=>{
 const f=await pendingFixture(t);
 if(mode==='revoked')await f.contacts.revoke(f.a.contact_id,f.a.binding_id,f.a.selection_generation);
 if(mode==='inspect_failed')f.state.beforeInspect=()=>{throw new StorageFailure('history_native_unavailable');};
 if(mode==='close_failed')f.state.beforeClose=()=>{throw new StorageFailure('history_native_unavailable');};
 const wakes=[],pages=f.state.pages;f.history.setFirstHistoryWake(id=>wakes.push(id));
 await assert.rejects(f.history.ensureSourceReady(f.a.contact_id));
 assert.deepEqual(wakes,[]);assert.equal(f.state.pages,pages);assert.equal((await f.history.coverage(f.a.contact_id)).goalId,f.pending.goalId);
});

test('一位联系人的共享读取来源变化不波及另一位，另一位重新核对当前来源',async t=>{
 const f=await pendingFixture(t);
 const wakes=[],pages=f.state.pages;f.history.setFirstHistoryWake(id=>wakes.push(id));
 f.state.beforeInspect=()=>{throw new StorageFailure('history_source_changed');};
 await assert.rejects(f.history.ensureSourceReady(f.b.contact_id),{code:'history_source_changed'});
 assert.equal((await f.history.coverage(f.b.contact_id)).phase,'incomplete');
 await f.history.ensureSourceReady(f.a.contact_id);
 assert.deepEqual(wakes,[f.a.contact_id]);assert.equal(f.state.pages,pages,'来源准备本身不读取正文页');
 assert.equal((await f.history.coverage(f.a.contact_id)).goalId,f.pending.goalId);
 const originalInspect=f.channel.inspect;
 f.channel.inspect=async scope=>({...await originalInspect(scope),conversationKey:'synthetic-changed-conversation'});
 try{
  await assert.rejects(f.history.ensureSourceReady(f.a.contact_id),{code:'history_external_scope_changed'});
 }finally{f.channel.inspect=originalInspect;}
 assert.deepEqual(wakes,[f.a.contact_id]);assert.equal(f.state.pages,pages);
 assert.equal((await f.history.coverage(f.a.contact_id)).failureCode,'history_source_continuity_unverified');
});

async function hostPreparations(history){
 const source=await readFile(new URL('../src/sqlite-host-plugin.ts',import.meta.url),'utf8');
 // 执行宿主实际装配的两个回调，以行为验证接线，不断言某个方法名字符串。
 const callbacks=[...source.matchAll(/ensureSourceReady:\s*(\([^)]*\)\s*=>\s*history!\.\w+\([^)]*\))/g)].map(match=>{
  const javascript=stripTypeScriptTypes(`const preparation = ${match[1]};`,{mode:'transform'});
  return new Function('history',`${javascript}return preparation;`)(history);
 });
 assert.equal(callbacks.length,2,'宿主媒体和记忆都须装配来源准备');return callbacks;
}

for(const position of [0,1])test(`宿主${position===0?'媒体':'记忆'}准备释放来源租约后首次历史自动接续`,{timeout:5000},async t=>{
 const cleanup=[],f=await pendingFixture({after:fn=>cleanup.push(fn)}),{a}=f;
 const directoryEntered=Promise.withResolvers(),directoryRelease=Promise.withResolvers(),inspectEntered=Promise.withResolvers(),inspectRelease=Promise.withResolvers();let hold=true,preparing;
 const first=new FirstHistoryCoordinator({directory:async()=>{const d=await f.contacts.syncDirectory();if(hold){hold=false;directoryEntered.resolve();await directoryRelease.promise;}return {...d,bindings:d.bindings.filter(x=>x.contact_id===a.contact_id)};}},f.history);
 t.after(async()=>{directoryRelease.resolve();inspectRelease.resolve();await preparing?.catch(()=>{});await first.close();for(const fn of cleanup.reverse())await fn();});
 const pages=f.state.pages,wakes=[];
 f.history.setFirstHistoryWake(id=>{wakes.push({id,active:f.state.sharedActive,pages:f.state.pages});first.wakeContact(id);});
 first.wakeContact(a.contact_id);await directoryEntered.promise;
 f.state.beforeInspect=async()=>{inspectEntered.resolve();await inspectRelease.promise;};
 const callbacks=await hostPreparations(f.history);preparing=callbacks[position](a.contact_id);
 await inspectEntered.promise;directoryRelease.resolve();await first.waitForIdle();
 assert.equal(first.getState().contacts[0].lastError,'history_already_running');assert.equal(f.state.pages,pages);
 inspectRelease.resolve();await preparing;
 await first.waitForIdle();assert.equal((await f.history.coverage(a.contact_id)).phase,'complete');
 assert.deepEqual(wakes,[{id:a.contact_id,active:false,pages}]);assert.equal(f.state.pages,pages+1);
});
test('宿主媒体来源准备保留调用者取消信号与原有15秒期限',async t=>{
 const cleanup=[],f=await pendingFixture({after:fn=>cleanup.push(fn)}),callbacks=await hostPreparations(f.history),controller=new AbortController(),release=Promise.withResolvers();let pending;
 t.after(async()=>{release.resolve();await pending?.catch(()=>{});for(const fn of cleanup.reverse())await fn();});controller.abort();
 const created=f.state.created;await assert.rejects(callbacks[0](f.a.contact_id,controller.signal),{code:'history_native_cancelled'});
 assert.equal(f.state.created,created);
 const entered=Promise.withResolvers();
 f.state.beforeInspect=async()=>{entered.resolve();await release.promise;};
 t.mock.timers.enable({apis:['setTimeout','Date']});
 pending=callbacks[0](f.a.contact_id);await entered.promise;const rejected=assert.rejects(pending,{code:'history_native_timeout'});
 t.mock.timers.tick(15000);release.resolve();await rejected;
});
