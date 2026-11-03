import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

for(const mode of ['abort','stop','revoke'])test(`共享历史超过1000页后${mode}仍逐页停止，迟到页不保存且其他联系人可接续`,{timeout:30000},async t=>{
 const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),[a,b]=f.saved;
 const entered=Promise.withResolvers(),releasePage=Promise.withResolvers(),state={tail:Promise.resolve(),owner:null,release:null,current:null,serial:0,pages:new Map()};
 // 只替代原生租约与分页；持久资格检查、守卫、取消和每页接受均使用真实服务及SQLite。
 const shared={async run(owner,work,release,signal){
  const previous=state.tail;let unlock;state.tail=new Promise(resolve=>{unlock=resolve;});await previous;
  try{if(signal?.aborted)throw new StorageFailure('history_native_cancelled');if(state.owner!==owner){await state.release?.();state.current=null;}state.owner=owner;state.release=release;return await work({});}finally{unlock();}
 }};
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const loss=Promise.withResolvers();
  return {...f.channel,guardSession:{loss:loss.promise},
   inspect:async scope=>({...await f.channel.inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported',durableIncremental:'supported'}}),
   target:async scope=>{state.current={contactId:scope.token.contact_id,index:0,target:{...f.target,descriptor:`synthetic-control-${++state.serial}`}};return state.current.target;},
   resumeTarget:async()=>null,
   page:async(scope,target,cursor,signal)=>{
    const current=state.current;assert.equal(current.contactId,scope.token.contact_id);assert.equal(current.target.descriptor,target.descriptor);
    assert.equal(cursor,current.index?`${target.descriptor}.${current.index}`:null);
    const index=++current.index;state.pages.set(current.contactId,(state.pages.get(current.contactId)??0)+1);
    if(current.contactId===a.contact_id&&index===1001){
     entered.resolve();
     await new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(new StorageFailure('history_native_cancelled'));};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      releasePage.promise.then(()=>{signal.removeEventListener('abort',abort);resolve();});
     });
    }
    const exhausted=current.contactId===b.contact_id;
    return {target:target.descriptor,cursorIn:cursor,cursorOut:exhausted?null:`${target.descriptor}.${index}`,
     records:[record(String(index),{text:`合成控制${scope.conversationKey}:${index}`})],completedPartitions:exhausted?['shard-a']:[],exhausted,
     ...(exhausted?{resumeCursor:`synthetic-tail-${state.serial}`}:{})};
   },park:async()=>{},close:async()=>loss.resolve()};
 },undefined,undefined,undefined,shared);
 let first,second;const controller=new AbortController();
 t.after(async()=>{controller.abort();releasePage.resolve();await history.close();await Promise.allSettled([first,second]);await f.service.close();for(const fn of cleanup.reverse())await fn();});
 first=history.synchronize(a.contact_id,controller.signal).then(value=>({value}),error=>({error}));
 assert.equal(await Promise.race([entered.promise.then(()=>'entered'),first.then(()=>'returned')]),'entered','共享租约必须持续到1000页之后');
 second=history.synchronize(b.contact_id);assert.equal(state.pages.get(b.contact_id)??0,0);
 if(mode==='abort')controller.abort();
 else if(mode==='stop')await history.stop(a.contact_id);
 else {await f.contacts.revoke(a.contact_id,a.binding_id,a.selection_generation);releasePage.resolve();}
 const outcome=await first;assert.ok(outcome.error,'停止或撤销后的在途任务不能声称完成');
 assert.ok(['history_native_cancelled','history_interrupted','read_not_authorized','read_eligibility_stale'].includes(outcome.error.code),outcome.error.code);
 assert.equal(state.pages.get(a.contact_id),1001,'控制生效后不得继续发起下一页');
 assert.equal((await history.coverage(a.contact_id)).pageCount,1000,'第1001页迟到正文不得接受');
 assert.equal((await second).phase,'complete','取消大联系人后必须释放租约供另一联系人继续');
 assert.equal(state.pages.get(b.contact_id),1);assert.equal((await history.read(b.contact_id)).messages.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
