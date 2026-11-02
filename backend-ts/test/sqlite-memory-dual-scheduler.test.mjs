import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMemoryL1Scheduler} from '../src/memory/sqlite/scheduler.ts';

function harness(port){
 const timers=new Map();let next=0;
 const scheduler=new SqliteMemoryL1Scheduler(port,{now:()=>1_000,setTimeout:(callback,delay)=>{const id=++next;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id)});
 return {scheduler,timers};
}

test('每个历史小批之前重新检查增量，历史联系人轮流处理',async()=>{
 const events=[];let incremental=false;
 const {scheduler,timers}=harness({
  dueContacts:async()=>incremental?['new']:[],nextDueAt:async()=>incremental?1_000:null,
  startContact:async id=>{events.push(`incremental:${id}`);incremental=false;return {};},
  dueHistoryContacts:async()=>['old-a','old-b'],nextHistoryDueAt:async()=>1_000,
  startHistoryBatch:async id=>{events.push(`history:${id}`);incremental=true;return {};},
 });
 await scheduler.start();assert.deepEqual(events,['history:old-a']);assert.equal(timers.size,1);
 await scheduler.wake();assert.deepEqual(events,['history:old-a','incremental:new','history:old-b']);
 await scheduler.close();assert.equal(timers.size,0);
});

test('单联系人建轮失败不影响其他联系人或另一条队列',async()=>{
 const events=[];
 const {scheduler}=harness({
  dueContacts:async()=>['broken','new'],nextDueAt:async()=>null,
  startContact:async id=>{events.push(id);if(id==='broken')throw new Error('synthetic');return {};},
  dueHistoryContacts:async()=>['old-broken','old'],nextHistoryDueAt:async()=>null,
  startHistoryBatch:async id=>{events.push(id);if(id==='old-broken')throw new Error('synthetic');return {};},
 });
 await scheduler.start();assert.deepEqual(events,['broken','new','old-broken','old']);await scheduler.close();
});

test('没有到期目标仍定期重查历史终页；关闭后不再建轮',async()=>{
 let calls=0;
 const {scheduler,timers}=harness({
  dueContacts:async()=>[],nextDueAt:async()=>null,startContact:async()=>null,
  dueHistoryContacts:async()=>{calls++;return [];},nextHistoryDueAt:async()=>null,startHistoryBatch:async()=>null,
 });
 await scheduler.start();assert.equal(calls,1);assert.equal([...timers.values()][0].delay,30_000);
 await scheduler.close();await scheduler.wake();assert.equal(calls,1);assert.equal(timers.size,0);
});

test('关闭等待中的历史批后不会再启动另一个联系人',{timeout:2_000},async()=>{
 let release,entered;const running=new Promise(resolve=>{entered=resolve}),done=new Promise(resolve=>{release=resolve});const events=[];
 const {scheduler}=harness({
  dueContacts:async()=>[],nextDueAt:async()=>null,startContact:async()=>null,
  dueHistoryContacts:async()=>['a','b'],nextHistoryDueAt:async()=>1_000,
  startHistoryBatch:async id=>{events.push(id);entered();await done;return {};},
 });
 const start=scheduler.start();await running;const closing=scheduler.close();release();await Promise.all([start,closing]);assert.deepEqual(events,['a']);
});
