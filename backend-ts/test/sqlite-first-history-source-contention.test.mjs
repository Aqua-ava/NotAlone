import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';

async function strictTargetFixture(t, { sharedReader = true } = {}) {
 const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
 const state = { owner: null, release: null, tail: Promise.resolve(), current: null, serial: 0, pages: [], tails: [], resumes: 0, channels: [], beforeInspect: null, quoteReads: 0, beforeQuote: null, quoteFailure: null };
 const shared = { async run(owner, work, release, signal) {
  const previous = state.tail; let unlock; state.tail = new Promise(resolve => { unlock = resolve; }); await previous;
  try {
   assert.equal(signal?.aborted ?? false, false);
   if (state.owner !== owner) { await state.release?.(); state.current = null; }
   state.owner = owner; state.release = release; return await work({});
  } finally { unlock(); }
 } };
 const create = () => {
  const loss = Promise.withResolvers(), entry = { loss, code: null }; state.channels.push(entry);
  const select = (scope, target) => state.current = { contactId: scope.token.contact_id,
   target: { ...target, descriptor: `snapshot-${++state.serial}` }, tailCursor: null };
  const current = (scope, target) => {
   if (scope.token.contact_id !== state.current?.contactId || target.descriptor !== state.current?.target.descriptor)
    throw new StorageFailure('history_target_unverified');
   return state.current;
  };
  return { ...f.channel, guardSession: { loss: loss.promise, failureCode: () => entry.code },
   inspect: async scope => { const before=state.beforeInspect;state.beforeInspect=null;await before?.();return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
    capabilities: Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail','durableIncremental'].map(key=>[key,'supported'])) }; },
   target: async scope => select(scope, f.target).target,
   resumeTarget: async (scope, previous) => { state.resumes++; return select(scope, previous).target; },
   page: async (scope, target, cursor) => {
    const selected = current(scope, target); state.pages.push({ contactId: scope.token.contact_id, target: target.descriptor });
    selected.tailCursor = `checkpoint-${state.serial}`;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
     records: [record('1', { text: `合成历史：${scope.conversationKey}` }),record('99',{kind:'other',text:null,originalType:'244813135921',status:'2',serverId:'0',metadataOnly:true,stateAssurance:'unverified'})], completedPartitions: ['shard-a'],
     exhausted: true, resumeCursor: selected.tailCursor };
   },
   tail: async (scope, target, cursor) => {
    const selected = current(scope, target); assert.equal(cursor, selected.tailCursor, '新目标必须先读取历史页后才能增量');
    state.tails.push(scope.token.contact_id);
    return { target: target.descriptor, cursorIn: cursor, cursorOut: cursor, records: [], caughtUp: true };
   },
   readQuote: async (scope,target) => { current(scope,target);state.quoteReads++;await state.beforeQuote?.();if(state.quoteFailure)throw new StorageFailure(state.quoteFailure);return {replyText:'合成引用回复',referencedText:'合成被引内容',referencedSender:'合成联系人',referencedSenderRole:'contact',referencedType:'1',referencedServerId:'0',proofDigest:'c'.repeat(64)}; },
   park: async () => {}, close: async () => loss.resolve(),
  };
 };
 const history = new SqliteHistoryService(f.storage, f.contacts, create, undefined, undefined, undefined, sharedReader ? shared : undefined);
 t.after(async () => { await history.close(); await f.service.close(); for (const fn of cleanup.reverse()) await fn(); });
 return { ...f, history, state };
}




for(const action of ['resume','revoke','stop','disabled'])test(`活守卫引用与首次历史相撞后按普通退避${action}且不恢复已撤销范围`, {timeout:5000}, async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const cleanup=[],f=await strictTargetFixture({after:fn=>cleanup.push(fn)}),[a,b]=f.saved;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const directoryEntered=Promise.withResolvers(),directoryRelease=Promise.withResolvers();let holdDirectory=true;
 const first=new FirstHistoryCoordinator({directory:async()=>{
  const current=await f.contacts.syncDirectory();if(holdDirectory){holdDirectory=false;directoryEntered.resolve();await directoryRelease.promise;}
  return {...current,bindings:current.bindings.filter(row=>row.contact_id===a.contact_id)};
 }},f.history);
 const quoteEntered=Promise.withResolvers(),quoteRelease=Promise.withResolvers();let quoting;
 t.after(async()=>{directoryRelease.resolve();quoteRelease.resolve();await quoting?.catch(()=>{});await first.close();for(const clean of cleanup.reverse())await clean();});
 const wakes=[];f.history.setFirstHistoryWake(id=>{wakes.push(id);first.wakeContact(id);});
 await f.history.synchronizeIncremental(a.contact_id);await directoryEntered.promise;
 assert.equal((await f.history.coverage(a.contact_id)).phase,'running');
 f.state.beforeQuote=async()=>{quoteEntered.resolve();await quoteRelease.promise;};
 quoting=f.history.synchronizeQuotes(a.contact_id);await quoteEntered.promise;
 directoryRelease.resolve();await first.waitForIdle();
 assert.equal(first.getState().contacts.find(row=>row.contactId===a.contact_id).lastError,'history_already_running');assert.equal(first.getState().phase,'scheduled');
 quoteRelease.resolve();assert.deepEqual(await quoting,{processed:1,more:false});await first.waitForIdle();
 const pages=f.state.pages.length;
 if(action==='revoke')await f.contacts.revoke(a.contact_id,a.binding_id,a.selection_generation);
 if(action==='stop')await first.stop(a.contact_id);
 if(action==='disabled')await f.contacts.setReading(false);
 t.mock.timers.tick(1000);await first.waitForIdle();
 assert.equal(wakes.length,1,'未重验引用没有额外wake，只有先前增量唤醒');
 if(action==='resume'){assert.equal((await f.history.coverage(a.contact_id)).phase,'complete','活guard引用读取碰撞也应能够恢复First');assert.equal(f.state.pages.length,pages+1);assert.equal(first.getState().lastError,null);}
 else {assert.equal(f.state.pages.length,pages,'停止或授权变化后退避任务不能继续读取');assert.notEqual((await f.history.coverage(a.contact_id)).phase,'complete');}
});
