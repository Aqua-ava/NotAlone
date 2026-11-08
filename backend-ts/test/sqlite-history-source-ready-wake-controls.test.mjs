import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';

async function strictTargetFixture(t, { sharedReader = true } = {}) {
 const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
 const state = { owner: null, release: null, tail: Promise.resolve(), current: null, serial: 0, pages: [], tails: [], resumes: 0, sessions: [], sharedActive:false, parkFailure:null, beforeInspect:null };
 const shared = { async run(owner, work, release, signal) {
  const previous = state.tail; let unlock; state.tail = new Promise(resolve => { unlock = resolve; }); await previous;
  try {
   assert.equal(signal?.aborted ?? false, false);
   if (state.owner !== owner) { await state.release?.(); state.current = null; }
   state.owner = owner; state.release = release; state.sharedActive=true;return await work({});
  } finally { state.sharedActive=false;unlock(); }
 } };
 const create = () => {
  const loss = {...Promise.withResolvers(),code:'history_native_timeout'}; state.sessions.push(loss);
  const select = (scope, target) => state.current = { contactId: scope.token.contact_id,
   target: { ...target, descriptor: `snapshot-${++state.serial}` }, tailCursor: null };
  const current = (scope, target) => {
   if (scope.token.contact_id !== state.current?.contactId || target.descriptor !== state.current?.target.descriptor)
    throw new StorageFailure('history_target_unverified');
   return state.current;
  };
  return { ...f.channel, guardSession: { loss: loss.promise, failureCode:()=> loss.code },
   inspect: async scope => {const before=state.beforeInspect;state.beforeInspect=null;await before?.();return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
    capabilities: { incrementalTail: 'supported', durableIncremental: 'supported' } };},
   target: async scope => select(scope, f.target).target,
   resumeTarget: async (scope, previous) => { state.resumes++; return select(scope, previous).target; },
   page: async (scope, target, cursor) => {
    const selected = current(scope, target); state.pages.push({ contactId: scope.token.contact_id, target: target.descriptor });
    selected.tailCursor = `checkpoint-${state.serial}`;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
     records: [record('1', { text: `合成历史：${scope.conversationKey}` })], completedPartitions: ['shard-a'],
     exhausted: true, resumeCursor: selected.tailCursor };
   },
   tail: async (scope, target, cursor) => {
    const selected = current(scope, target); assert.equal(cursor, selected.tailCursor, '新目标必须先读取历史页后才能增量');
    state.tails.push(scope.token.contact_id);
    return { target: target.descriptor, cursorIn: cursor, cursorOut: cursor, records: [], caughtUp: true };
   },
   park: async () => {if(state.parkFailure)throw new StorageFailure(state.parkFailure);}, close: async () => loss.resolve(),
  };
 };
 const history = new SqliteHistoryService(f.storage, f.contacts, create, undefined, undefined, undefined, sharedReader ? shared : undefined);
 t.after(async () => { await history.close(); await f.service.close(); for (const fn of cleanup.reverse()) await fn(); });
 return { ...f, history, state };
}

import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
import {IncrementalHistoryCoordinator} from '../src/history/sqlite/incremental-coordinator.ts';
async function pendingFixture(t){
 const f=await strictTargetFixture(t),[a,b]=f.saved;await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 await f.history.synchronizeIncremental(a.contact_id);const pending=await f.history.coverage(a.contact_id);
 assert.equal(pending.phase,'running');assert.equal(pending.pageCount,0);
 return {...f,a,b,pending};
}
async function lose(f,code='history_native_timeout'){
 const current=f.state.sessions.at(-1);current.code=code;current.resolve();
 for(let i=0;i<12;i++)await Promise.resolve();await f.history.waitForReadIdle(f.a.contact_id);await f.storage.check();
}
test('来源元数据成功重验释放租约后仅唤醒首次协调器，协调器自动补齐旧未完目标',async t=>{
 const cleanup=[],f=await pendingFixture({after:fn=>cleanup.push(fn)});await lose(f);
 const directory={directory:async()=>{const d=await f.contacts.syncDirectory();return {...d,bindings:d.bindings.filter(x=>x.contact_id===f.a.contact_id)};}};
 const first=new FirstHistoryCoordinator(directory,f.history);t.after(async()=>{await first.close();for(const fn of cleanup.reverse())await fn();});
 const pages=f.state.pages.length,actions=[],execute=f.storage.execute.bind(f.storage),wakes=[];let preparing=true;
 f.storage.execute=(name,input,...rest)=>{if(preparing)actions.push(name);return execute(name,input,...rest);};
 f.history.setFirstHistoryWake(id=>{wakes.push(id);assert.equal(f.state.sharedActive,false,'唤醒必须在原生租约释放后');assert.equal(f.state.pages.length,pages,'来源准备本身不读取正文页');assert.ok(!actions.includes('history.begin'),'来源准备本身不创建新历史目标');preparing=false;first.wakeContact(id);});
 await f.history.ensureSourceReady(f.a.contact_id);preparing=false;
 assert.deepEqual(wakes,[f.a.contact_id]);await first.waitForIdle();
 const result=await f.history.coverage(f.a.contact_id);assert.equal(result.phase,'complete');assert.notEqual(result.goalId,f.pending.goalId);assert.equal(f.state.pages.length,pages+1);
 // 仅刷新已有活来源不应再派发重复历史任务。
 wakes.length=0;f.history.setFirstHistoryWake(id=>wakes.push(id));await f.history.ensureSourceReady(f.a.contact_id);assert.deepEqual(wakes,[]);
});
for(const mode of ['revoked','park_failed'])test(`来源准备${mode}失败不发完成唤醒或读取正文`,async t=>{
 const f=await pendingFixture(t);await lose(f,'history_native_timeout');
 if(mode==='revoked')await f.contacts.revoke(f.a.contact_id,f.a.binding_id,f.a.selection_generation);
 if(mode==='park_failed')f.state.parkFailure='history_native_unavailable';
 const wakes=[],pages=f.state.pages.length;f.history.setFirstHistoryWake(id=>wakes.push(id));
 await assert.rejects(f.history.ensureSourceReady(f.a.contact_id));
 assert.deepEqual(wakes,[]);assert.equal(f.state.pages.length,pages);assert.equal((await f.history.coverage(f.a.contact_id)).goalId,f.pending.goalId);
 f.state.parkFailure=null;
});

test('空闲守卫收到共享进程来源错误码时来源准备先完整重验，真实来源变化才围栏',async t=>{
 const f=await pendingFixture(t);await lose(f,'history_source_changed');
 const wakes=[],pages=f.state.pages.length;f.history.setFirstHistoryWake(id=>wakes.push(id));
 // 共享读取进程整体停止的错误码不能把空闲联系人的来源准备变成永久失效，须用当前读取器完整重验元数据。
 await f.history.ensureSourceReady(f.a.contact_id);
 // 完整重验后只允许唤醒首次协调器补齐旧未完目标；正文页仍不由来源准备读取。
 assert.deepEqual(wakes,[f.a.contact_id]);assert.equal(f.state.pages.length,pages,'来源准备本身不读取正文页');
 const token=await f.contacts.eligibility(f.a.contact_id);
 // 重验成功后守卫已续租为活守卫；不得借此建立新的正文目标或推进旧目标。
 assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate',{token}),false);
 assert.equal((await f.history.coverage(f.a.contact_id)).goalId,f.pending.goalId);
 const originalInspect=f.channel.inspect;
 f.channel.inspect=async scope=>({...await originalInspect(scope),conversationKey:'synthetic-changed-conversation'});
 try{
  await assert.rejects(f.history.ensureSourceReady(f.a.contact_id),{code:'history_external_scope_changed'});
 }finally{f.channel.inspect=originalInspect;}
 assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate',{token}),true,'持久围栏允许后续核对，候选资格本身不放行正文');assert.equal((await f.history.coverage(f.a.contact_id)).phase,'incomplete');
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

for(const position of [0,1])test(`宿主${position===0?'媒体':'记忆'}来源准备复用活守卫，未重验时也不抢占首次派发`,{timeout:5000},async t=>{
 const cleanup=[],f=await strictTargetFixture({after:fn=>cleanup.push(fn)}),[a,b]=f.saved;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const directoryEntered=Promise.withResolvers(),directoryRelease=Promise.withResolvers(),inspectEntered=Promise.withResolvers(),inspectRelease=Promise.withResolvers();let hold=true,preparing;
 const first=new FirstHistoryCoordinator({directory:async()=>{const d=await f.contacts.syncDirectory();if(hold){hold=false;directoryEntered.resolve();await directoryRelease.promise;}return {...d,bindings:d.bindings.filter(x=>x.contact_id===a.contact_id)};}},f.history);
 t.after(async()=>{directoryRelease.resolve();inspectRelease.resolve();await preparing?.catch(()=>{});await first.close();for(const fn of cleanup.reverse())await fn();});
 f.history.setFirstHistoryWake(id=>first.wakeContact(id));await f.history.synchronizeIncremental(a.contact_id);await directoryEntered.promise;
 const token=await f.contacts.eligibility(a.contact_id);assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate',{token}),false);
 f.state.beforeInspect=async()=>{inspectEntered.resolve();await inspectRelease.promise;};
 const callbacks=await hostPreparations(f.history);preparing=callbacks[position](a.contact_id);
 const outcome=await Promise.race([preparing.then(()=>'prepared'),inspectEntered.promise.then(()=>'native_entered')]);
 if(outcome==='native_entered'){
  // 旧接线真的拿走同一联系人读者，首次调度撞互斥后不会自行再跑。
  directoryRelease.resolve();await first.waitForIdle();assert.equal(first.getState().contacts[0].phase,'incomplete');inspectRelease.resolve();await preparing;
 }else{f.state.beforeInspect=null;directoryRelease.resolve();}
 await first.waitForIdle();assert.equal((await f.history.coverage(a.contact_id)).phase,'complete');
 assert.equal(outcome,'prepared','有效活守卫应直接复用，不启动多余原生元数据读取');
});
test('宿主媒体来源准备保留调用者取消信号与原有15秒期限',async t=>{
 const cleanup=[],f=await pendingFixture({after:fn=>cleanup.push(fn)}),callbacks=await hostPreparations(f.history),controller=new AbortController(),release=Promise.withResolvers();let pending;
 t.after(async()=>{release.resolve();await pending?.catch(()=>{});for(const fn of cleanup.reverse())await fn();});controller.abort();
 const created=f.state.sessions.length;await assert.rejects(callbacks[0](f.a.contact_id,controller.signal),{code:'history_native_cancelled'});
 assert.equal(f.state.sessions.length,created);
 await lose(f);const entered=Promise.withResolvers();
 f.state.beforeInspect=async()=>{entered.resolve();await release.promise;};
 t.mock.timers.enable({apis:['setTimeout','Date']});
 pending=callbacks[0](f.a.contact_id);await entered.promise;const rejected=assert.rejects(pending,{code:'history_native_timeout'});
 t.mock.timers.tick(15000);release.resolve();await rejected;
});
