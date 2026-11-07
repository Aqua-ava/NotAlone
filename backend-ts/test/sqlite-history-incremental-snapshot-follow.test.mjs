import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';

async function sharedFixture(t,{durableHistory=true}={}) {
  const cleanup = [], f = await fixture({ after: callback => cleanup.push(callback) },{registryModule:new URL('./fixtures/history-parked-registry.mjs',import.meta.url).href});
  const state = { owner: undefined, releaseOwner: undefined, tail: Promise.resolve(), parks: 0, pages: 0, tails: [], serial:0,resumes:0, channels: [], wakes: [] };
  // 只替代原生进程租约边界；顺序、停车回调、历史目标、守卫和存储均走生产服务。
  const shared = { async run(owner, work, releasePreviousOwner, signal) {
    const previous = state.tail;
    let unlock; state.tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    try {
      assert.equal(signal?.aborted ?? false, false);
      if (state.owner !== undefined && state.owner !== owner) await state.releaseOwner?.();
      state.owner = owner; state.releaseOwner = releasePreviousOwner;
      return await work({});
    } finally { unlock(); }
  } };
  const history = new SqliteHistoryService(f.storage, f.contacts, () => {
    const loss = Promise.withResolvers(), current = { loss, code: null, scope: null };
    state.channels.push(current);current.closed=0;
    return { ...f.channel,
      target:async scope=>{current.descriptor=`synthetic-snapshot-${state.dynamicSnapshots?++state.serial:state.targetRevision??0}`;return {...await f.channel.target(scope),descriptor:current.descriptor};},
      resumeTarget:async(_scope,previous)=>{state.resumes++;if(state.resumeUnavailable)return null;current.descriptor=`synthetic-snapshot-${state.dynamicSnapshots?++state.serial:state.targetRevision??0}`;return {...previous,descriptor:current.descriptor,...state.resumeOverride};},
      guardSession: { loss: loss.promise, failureCode: () => current.code },
      inspect: async scope => {
        current.scope = scope;
        return { ...await f.channel.inspect(scope), continuity: 'same-source-instances-normal-use-v1',
          // 当前 v3 同时声明两项持久能力；兼容用例明确模拟尚无历史检查点的旧读取器。
          capabilities: { incrementalTail: 'supported',durableIncremental:'supported',...(durableHistory?{durableHistory:'supported'}:{}) } };
      },
      page: async (scope, target, cursor) => {await state.beforePage?.(scope);assert.equal(target.descriptor,current.descriptor);state.pages++;current.tailCursor=`checkpoint-${target.descriptor}`;if(state.pageFactory)return state.pageFactory(scope,target,cursor,current);return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
        records: [record('1', { text: `合成历史：${scope.conversationKey}` })], completedPartitions: ['shard-a'],
        exhausted: true, resumeCursor: current.tailCursor };},
      tail: async (_scope, target, cursor) => { assert.equal(target.descriptor,current.descriptor,'旧快照目标不能传给当前原生读取器');assert.equal(cursor,current.tailCursor,'必须使用本次交接产生的游标');state.tails.push({contactId:_scope.token.contact_id,cursor});return { target: target.descriptor, cursorIn: cursor, cursorOut: cursor, records: [], caughtUp: true };},
      park: async () => { state.parks++; },
      close: async () => { current.closed++;loss.resolve(); },
    };
  }, undefined, undefined, undefined, shared);
  history.setFirstHistoryWake(contactId => state.wakes.push(contactId));
  t.after(async () => { await history.close(); await f.service.close(); for (const callback of cleanup.reverse()) await callback(); });
  return { ...f, history, state };
}



test('每次独占读取结束即释放原生通道和守卫，两位联系人两轮不会遗留空闲租约',async t=>{
 const f=await sharedFixture(t),[a,b]=f.saved;f.state.dynamicSnapshots=true;
 for(let round=0;round<2;round++)for(const contact of [a,b]){
  await f.history.synchronize(contact.contact_id);
  assert.ok(f.state.channels.every(channel=>channel.closed===1));
  assert.equal(f.state.parks,0);
  const token=await f.contacts.eligibility(contact.contact_id);
  assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'not-a-current-read'}),false);
 }
 assert.equal(f.state.channels.length,4);
});

test('多联系人轮转后新快照在同一租约接纳交接与增量，连续两轮不饿死tail',{timeout:20000},async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=await sharedFixture(t),[a,b]=f.saved;f.state.dynamicSnapshots=true;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const directory={directory:()=>f.contacts.syncDirectory()};
 const incremental=new IncrementalHistoryCoordinator(directory,f.history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 const first=new FirstHistoryCoordinator(directory,f.history);
 t.after(async()=>{await incremental.close();await first.close();});
 f.history.setFirstHistoryWake(id=>first.wakeContact(id));
 incremental.start();
 for(let round=0;round<2;round++){
  const offset=f.state.tails.length;
  if(round===0)incremental.wake();else t.mock.timers.tick(30_000);
  await incremental.waitForIdle();await first.waitForIdle();await incremental.waitForIdle();
  assert.deepEqual(new Set(f.state.tails.slice(offset).map(row=>row.contactId)),new Set([a.contact_id,b.contact_id]),`第${round+1}轮两位都须接纳tail页`);
  assert.ok(incremental.getState().contacts.every(row=>row.phase==='caught_up'));
  assert.equal((await f.history.read(a.contact_id)).messages.length,1);
  assert.equal((await f.history.read(b.contact_id)).messages.length,1);
 }
 assert.ok(f.state.resumes>=2,'每次重新连接后沿持久检查点恢复');
});

test('旧读取器没有持久历史检查点时，同租约完成33页并在两轮继续增量',{timeout:20000},async t=>{
 const f=await sharedFixture(t,{durableHistory:false}),[a,b]=f.saved;f.state.dynamicSnapshots=true;
 for(const contact of [a,b])await f.history.synchronize(contact.contact_id);
 f.state.pageFactory=(_scope,target,cursor,current)=>{
  const page=cursor===null?1:Number(cursor.replace('synthetic-legacy-page-',''))+1,exhausted=page===33;
  assert.ok(page>=1&&page<=33);
  return {target:target.descriptor,cursorIn:cursor,cursorOut:exhausted?null:`synthetic-legacy-page-${page}`,
   records:[record(String(page+1))],completedPartitions:exhausted?['shard-a']:[],exhausted,
   ...(exhausted?{resumeCursor:current.tailCursor}:{})};
 };
 for(let round=0;round<2;round++)for(const contact of [a,b]){
  const pages=f.state.pages,tails=f.state.tails.length;
  await f.history.synchronizeIncremental(contact.contact_id,undefined,{followHistoryHandoff:true});
  assert.equal(f.state.pages-pages,33);
  assert.deepEqual(f.state.tails.slice(tails).map(tail=>tail.contactId),[contact.contact_id]);
  assert.equal((await f.history.coverage(contact.contact_id)).phase,'complete');
  assert.equal((await f.history.read(contact.contact_id)).messages.length,34);
 }
});

test('新完整历史的守卫重验作废旧增量后仍自动续读两轮',{timeout:20000},async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const f=await sharedFixture(t),[a,b]=f.saved;
 await f.history.synchronize(a.contact_id);await f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true});
 await f.history.synchronize(b.contact_id);
 const directory={directory:async()=>{const saved=await f.contacts.syncDirectory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===a.contact_id)};}};
 const incremental=new IncrementalHistoryCoordinator(directory,f.history,{intervalMs:30_000,firstHistoryManagedExternally:true});
 const first=new FirstHistoryCoordinator(directory,f.history);
 t.after(async()=>{await incremental.close();await first.close();});
 f.history.setFirstHistoryWake(id=>first.wakeContact(id));
 f.state.resumeUnavailable=true;
 incremental.start();incremental.wake();await incremental.waitForIdle();await first.waitForIdle();
 assert.equal(incremental.getState().contacts[0].phase,'blocked','先进入无可恢复检查点的真实替换阻塞');
 assert.equal((await f.history.coverage(a.contact_id)).phase,'complete','首次协调器已补齐新历史');
 f.state.resumeUnavailable=false;
 for(let round=0;round<2;round++){
  await f.history.stop(a.contact_id);f.state.targetRevision=round+1;
  await f.history.prepareSource(a.contact_id);await first.waitForIdle();
  const before=await f.history.coverage(a.contact_id),tails=f.state.tails.length;
  assert.equal(before.phase,'complete');
  assert.equal(before.incremental.failureCode,'history_runtime_revalidated','仅元数据重验使旧增量失效');
  t.mock.timers.tick(30_000);await incremental.waitForIdle();await first.waitForIdle();await incremental.waitForIdle();
  assert.equal(incremental.getState().contacts[0].phase,'caught_up',`第${round+1}轮自动接上增量`);
  assert.ok(f.state.tails.length>tails,`第${round+1}轮确实读到增量页`);
  assert.equal((await f.history.coverage(a.contact_id)).incremental.failureCode,null);
 }
});

for(const mode of ['source_changed','revoked'])test(`同租约交接${mode}仍拒绝新页与tail`,async t=>{
 const f=await sharedFixture(t),[a,b]=f.saved;f.state.dynamicSnapshots=true;
 await f.history.synchronize(a.contact_id);await f.history.synchronize(b.contact_id);
 const tails=f.state.tails.length,pages=f.state.pages;
 if(mode==='source_changed')f.state.resumeOverride={sourceGeneration:'different-source'};
 else f.state.beforePage=async()=>{f.state.beforePage=null;await f.contacts.revoke(a.contact_id,a.binding_id,a.selection_generation);};
 await assert.rejects(f.history.synchronizeIncremental(a.contact_id,undefined,{followHistoryHandoff:true}),error=>
  mode==='source_changed'?error.code==='history_target_unverified':['read_not_authorized','read_eligibility_stale'].includes(error.code));
 assert.equal(f.state.tails.length,tails,'失败交接不能进入tail');
 if(mode==='source_changed')assert.equal(f.state.pages,pages,'变来源不能读取新历史页');
 else assert.equal((await f.contacts.directory()).bindings.some(row=>row.contact_id===a.contact_id&&row.status==='active'),false);
});
