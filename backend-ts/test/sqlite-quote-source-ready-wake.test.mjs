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
    capabilities: { incrementalTail: 'supported', durableIncremental: 'supported' } }; },
   target: async scope => select(scope, f.target).target,
   resumeTarget: async (scope, previous) => { state.resumes++; return select(scope, previous).target; },
   page: async (scope, target, cursor) => {
    const selected = current(scope, target);if(state.pageFailure)throw new StorageFailure(state.pageFailure);state.pages.push({ contactId: scope.token.contact_id, target: target.descriptor });
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



async function pendingQuoteFixture(t,{lost=true}={}) {
 const cleanup=[],f=await strictTargetFixture({after:fn=>cleanup.push(fn)}),[a,b]=f.saved;
 let first;
 t.after(async()=>{await first?.close();for(const clean of cleanup.reverse())await clean();});
 await f.history.synchronize(a.contact_id);
 if(lost){await f.history.synchronize(b.contact_id);f.state.pageFailure='history_native_timeout';await assert.rejects(f.history.synchronizeIncremental(a.contact_id),{code:'history_native_timeout'});f.state.pageFailure=null;await f.history.stop(a.contact_id);}
 const wakes=[],pageCount=f.state.pages.length;
 first=new FirstHistoryCoordinator({directory:async()=>{const directory=await f.contacts.syncDirectory();return {...directory,bindings:directory.bindings.filter(row=>row.contact_id===a.contact_id)};}},f.history);
 f.history.setFirstHistoryWake(id=>{assert.equal(f.state.pages.length,pageCount,'引用重验只处理引用，不直接读取历史分页');wakes.push(id);first.wakeContact(id);});
 return {...f,a,first,wakes,pageCount};
}

test('引用补齐成功重验旧守卫后接回已失效历史，引用内容与正文去重不变',async t=>{
 const f=await pendingQuoteFixture(t),token=await f.contacts.eligibility(f.a.contact_id);
 assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate',{token}),true);
 assert.deepEqual(await f.history.synchronizeQuotes(f.a.contact_id),{processed:1,more:false});
 await f.first.waitForIdle();
 assert.deepEqual(f.wakes,[f.a.contact_id]);assert.equal((await f.history.coverage(f.a.contact_id)).phase,'complete');
 const read=await f.history.read(f.a.contact_id),quoted=read.messages.find(row=>row.originalType==='244813135921');
 assert.equal(quoted.quote.replyText,'合成引用回复');assert.equal(quoted.quote.referencedText,'合成被引内容');
 assert.equal(read.messages.length,2);assert.equal(f.state.quoteReads,1);
 assert.deepEqual(await f.history.synchronizeQuotes(f.a.contact_id),{processed:0,more:false});assert.equal(f.wakes.length,1);
});

test('引用补齐没有来源重验时不重新派发历史目标',async t=>{
 const f=await pendingQuoteFixture(t,{lost:false}),before=await f.history.coverage(f.a.contact_id);
 assert.deepEqual(await f.history.synchronizeQuotes(f.a.contact_id),{processed:1,more:false});await f.first.waitForIdle();
 assert.deepEqual(f.wakes,[]);assert.equal(f.state.pages.length,f.pageCount);assert.equal((await f.history.coverage(f.a.contact_id)).goalId,before.goalId);
});

for(const failure of ['source-changed','revoked'])test(`引用重验后${failure}不能发送完成唤醒或保存迟到引用`,async t=>{
 const f=await pendingQuoteFixture(t);
 if(failure==='source-changed'){f.state.quoteFailure='history_quote_source_changed';f.state.beforeQuote=()=>{f.target.tables=f.target.tables.map(table=>({...table,instance:table.instance+'-replaced'}));};}
 else f.state.beforeQuote=()=>f.contacts.revoke(f.a.contact_id,f.a.binding_id,f.a.selection_generation);
 await assert.rejects(f.history.synchronizeQuotes(f.a.contact_id),{code:failure==='source-changed'?'history_quote_source_changed':'read_not_authorized'});
 await f.first.waitForIdle();assert.deepEqual(f.wakes,[]);assert.equal(f.state.pages.length,f.pageCount);
 assert.ok((await f.history.read(f.a.contact_id)).messages.every(row=>!row.quote));
 if(failure==='source-changed'){
  assert.equal(await f.storage.execute('history.normalUseRevalidationCandidate',{token:await f.contacts.eligibility(f.a.contact_id)}),true,'只允许再次核元数据，不开放旧来源');
  const source=(await f.history.read(f.a.contact_id)).messages[0].sourceRecordIds[0];await assert.rejects(f.history.source(f.a.contact_id,source),{code:'history_source_not_found'});
  const quoteReads=f.state.quoteReads;await assert.rejects(f.history.ensureSourceReady(f.a.contact_id),{code:'history_source_recovery_unsupported'});
  assert.equal(f.state.quoteReads,quoteReads,'物理表已替换不能继续读取引用');assert.equal(f.state.pages.length,f.pageCount);assert.deepEqual(f.wakes,[]);assert.equal((await f.history.coverage(f.a.contact_id)).failureCode,'history_source_continuity_unverified');
 }
});
