import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
function enableDurable(channel){
 const inspect=channel.inspect;channel.guardSession={loss:new Promise(()=>{})};
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported',durableIncremental:'supported'}});
}
test('同源重新建立守卫时只接续已接受检查点，不重新读取完整历史',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;enableDurable(f.channel);
 f.channel.resumeTarget=async(_scope,previous)=>({...previous});
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'resume-initial'});
 f.channel.tail=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'accepted-tail',records:[record('2')],caughtUp:true});
 await f.service.synchronize(contact);await f.service.synchronizeIncremental(contact);await f.service.close();
 let lastResumedCursor,fullTargets=0;const target={...f.target,descriptor:'new-delta-target'};
 const channel={...f.channel,guardSession:{loss:new Promise(()=>{})},target:async()=>{fullTargets++;throw new Error('不得重扫历史');},
 resumeTarget:async(scope,previous,cursor)=>{lastResumedCursor=cursor;assert.equal(scope.token.contact_id,contact);assert.deepEqual(previous,f.target);assert.equal(cursor,'accepted-tail');return target;},
 page:async(_scope,used,cursor)=>({target:used.descriptor,cursorIn:cursor,cursorOut:null,records:[record('0')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'new-tail'})};
 const service=new SqliteHistoryService(f.storage,f.contacts,()=>channel);t.after(()=>service.close().catch(()=>{}));
 // 06起每次重建守卫都按最新已接受增量检查点接续；完整目标重建必须失败阻止。
 assert.equal((await service.synchronizeIncremental(contact)).phase,'complete');
 assert.equal(lastResumedCursor,'accepted-tail');assert.equal(fullTargets,0);assert.equal((await service.read(contact)).messages.length,3);await service.close();
});
test('本机检查点丢失明确回退首次补齐，不使用调用者猜测游标',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;enableDurable(f.channel);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'resume-initial'});
 await f.service.synchronize(contact);await f.service.close();let tried=0,fullTargets=0;
 const channel={...f.channel,guardSession:{loss:new Promise(()=>{})},resumeTarget:async()=>{tried++;return null;},target:async()=>{fullTargets++;return {...f.target,descriptor:'fresh'};}};
 const service=new SqliteHistoryService(f.storage,f.contacts,()=>channel);t.after(()=>service.close().catch(()=>{}));
 assert.equal((await service.synchronize(contact)).phase,'complete');assert.equal(tried,1);assert.equal(fullTargets,1);await service.close();
});

test('检查点不跨联系人、制品或读取许可恢复',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;enableDurable(f.channel);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'accepted'});
 await f.service.synchronize(contact);
 const token=await f.contacts.eligibility(contact),scope=await f.storage.execute('history.scope',{token}),report=await f.channel.inspect(scope);
 assert.equal((await f.storage.execute('history.resumeCheckpoint',{token,report})).cursor,'accepted');
 assert.equal(await f.storage.execute('history.resumeCheckpoint',{token,report:{...report,artifactSha256:'c'.repeat(64)}}),null);
 const other=await f.contacts.eligibility(f.saved[1].contact_id);
 assert.equal(await f.storage.execute('history.resumeCheckpoint',{token:other,report:{...report,conversationKey:'friend-b'}}),null);
 await f.contacts.setReading(false);
 await assert.rejects(f.storage.execute('history.resumeCheckpoint',{token,report}));await f.service.close();
});

test('较新的未完成历史片段不被更旧的已作废增量检查点压过，否则大历史每片都从头重读而永不完成',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;enableDurable(f.channel);
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'resume-initial'});
 f.channel.tail=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'accepted-tail',records:[record('2')],caughtUp:true});
 await f.service.synchronize(contact);await f.service.synchronizeIncremental(contact);await f.service.close();
 // 同源重建守卫：旧增量目标按“运行代次换代”作废，留下较旧的已作废增量检查点。
 const channel={...f.channel,guardSession:{loss:new Promise(()=>{})},resumeTarget:async()=>({...f.target,descriptor:'resumed'}),
  page:async(_scope,used,cursor)=>({target:used.descriptor,cursorIn:cursor,cursorOut:null,records:[],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'new-tail'})};
 const service=new SqliteHistoryService(f.storage,f.contacts,()=>channel);t.after(()=>service.close().catch(()=>{}));
 await service.synchronizeIncremental(contact);await service.close();
 const token=await f.contacts.eligibility(contact),scope=await f.storage.execute('history.scope',{token}),report=await f.channel.inspect(scope);
 // 之后重新扫描产生更新的未完成历史目标，并已接受一个带游标的片段。
 const target=f.target;
 await f.storage.execute('history.preflightContinuity',{token,target,report});
 const goal=await f.storage.execute('history.begin',{token,target,report,id:randomUUID(),at:Date.now()});
 const guardId=randomUUID();assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId}),true);
 await f.storage.execute('history.acceptPage',{token,guardId,goalId:goal.id,captureId:randomUUID(),at:Date.now(),runtimeToken:f.storage.status.runtimeId,
  page:{target:target.descriptor,cursorIn:null,cursorOut:'history-partial',records:[record('3')],completedPartitions:[],exhausted:false}});
 let r;try{r=await f.storage.execute('history.resumeCheckpoint',{token,report});}catch(e){console.error('RESUME_THROW',e.code);throw e;}
 assert.equal(r.cursor,'history-partial');
});
