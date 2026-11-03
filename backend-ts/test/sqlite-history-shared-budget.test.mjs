import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, record } from './fixtures/memory-sqlite/support.mjs';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';

// 原生未完成页只在当前快照内有效，只有终页才保存可恢复检查点。
test('共享读取器超过1000页仍保留同一历史目标，随后完成另一联系人', {timeout:30000}, async t => {
 const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),[a,b]=f.saved;
 const state={tail:Promise.resolve(),owner:null,release:null,current:null,serial:0,opened:[],pages:new Map(),parked:[]};
 const shared={async run(owner,work,release,signal){
  const previous=state.tail;let unlock;state.tail=new Promise(resolve=>{unlock=resolve;});await previous;
  try{assert.equal(signal?.aborted??false,false);if(state.owner!==owner){await state.release?.();state.current=null;}state.owner=owner;state.release=release;return await work({});}finally{unlock();}
 }};
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const loss=Promise.withResolvers();let owned;
  return {...f.channel,guardSession:{loss:loss.promise},
   inspect:async scope=>({...await f.channel.inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported',durableIncremental:'supported'}}),
   target:async scope=>{owned=scope.token.contact_id;state.opened.push(owned);state.current={contactId:owned,index:0,target:{...f.target,descriptor:`snapshot-${++state.serial}`}};return state.current.target;},
   resumeTarget:async()=>null,
   page:async(scope,target,cursor)=>{
    const current=state.current;assert.equal(current.contactId,scope.token.contact_id);assert.equal(current.target.descriptor,target.descriptor);
    assert.equal(cursor,current.index?`${target.descriptor}.${current.index}`:null);
    const index=++current.index,exhausted=index===(current.contactId===a.contact_id?1001:1);
    state.pages.set(current.contactId,(state.pages.get(current.contactId)??0)+1);
    return {target:target.descriptor,cursorIn:cursor,cursorOut:exhausted?null:`${target.descriptor}.${index}`,
     records:[record(String(index),{text:`合成分页${scope.conversationKey}:${index}`})],completedPartitions:exhausted?['shard-a']:[],exhausted,
     ...(exhausted?{resumeCursor:`checkpoint-${state.serial}`}:{})};
   },park:async()=>{state.parked.push(owned);},close:async()=>loss.resolve()};
 },undefined,undefined,undefined,shared);
 t.after(async()=>{await history.close();await f.service.close();for(const fn of cleanup.reverse())await fn();});
 const [completedA,completedB]=await Promise.all([history.synchronize(a.contact_id),history.synchronize(b.contact_id)]);
 assert.equal(completedA.phase,'complete','1000页预算不能释放尚无持久检查点的共享固定快照');
 assert.equal(completedB.phase,'complete');assert.deepEqual(state.opened,[a.contact_id,b.contact_id]);
 assert.equal(state.pages.get(a.contact_id),1001);assert.equal(state.pages.get(b.contact_id),1);
 const results=await Promise.all([history.read(a.contact_id),history.read(b.contact_id)]);
 assert.equal(results[0].coverage.messageCount,1001);assert.equal(results[0].messages.length,101);assert.equal(results[1].messages.length,1);
 assert.ok(results[0].messages.every(row=>row.text.startsWith('合成分页friend-a:')));
 assert.ok(results[1].messages.every(row=>row.text.startsWith('合成分页friend-b:')));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
