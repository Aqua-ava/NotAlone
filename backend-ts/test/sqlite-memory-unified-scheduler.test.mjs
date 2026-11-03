import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteMemoryL1Scheduler} from '../src/memory/sqlite/scheduler.ts';

function harness(ids,overrides={}){
 let now=1_000,nextTimer=0,armed;
 const timers=new Map(),scans=[],events=[],rows=new Map(ids.map(contactId=>[contactId,{contactId,incrementalDueAt:null,historyDue:false}]));
 const port={
  scheduleContacts:async()=>[...rows.keys()],
  scanSchedule:async(_now,contactIds)=>{scans.push([...contactIds]);return {contacts:contactIds.flatMap(id=>rows.has(id)?[{...rows.get(id)}]:[])};},
  startContact:async id=>{events.push(`incremental:${id}`);rows.get(id).incrementalDueAt=null;return {};},
  startHistoryBatch:async id=>{events.push(`history:${id}`);rows.get(id).historyDue=false;return {};},
  ...overrides,
 };
 const scheduler=new SqliteMemoryL1Scheduler(port,{now:()=>now,setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});armed?.();armed=undefined;return id;},clearTimeout:id=>timers.delete(id)});
 return {scheduler,timers,scans,events,rows,port,setNow:value=>{now=value;},async tick(){const [id,timer]=[...timers.entries()][0];timers.delete(id);const ready=new Promise(resolve=>{armed=resolve;});timer.callback();await ready;}};
}

test('统一调度启动按32人分批，每批只读一次历史和增量摘要',async()=>{
 const ids=Array.from({length:65},(_,index)=>`contact-${String(index).padStart(2,'0')}`),f=harness(ids);
 try{
  await f.scheduler.start();
  assert.deepEqual(f.scans,[ids.slice(0,32),ids.slice(32,64),ids.slice(64)]);
  assert.equal(f.events.length,0);assert.equal([...f.timers.values()][0].delay,30_000);
 }finally{await f.scheduler.close();}
});

test('单联系人唤醒只刷新该人，不重扫其他联系人',async()=>{
 const f=harness(['a','b','c']);
 try{
  await f.scheduler.start();f.scans.length=0;f.rows.get('b').incrementalDueAt=2_000;
  await f.scheduler.wake('b');assert.deepEqual(f.scans,[['b']]);
  assert.equal([...f.timers.values()][0].delay,1_000);
 }finally{await f.scheduler.close();}
});

test('同一联系人在途再次唤醒不会被旧扫描清除',async()=>{
 const f=harness(['a','b']);
 try{
  await f.scheduler.start();f.scans.length=0;
  const read=f.port.scanSchedule;let release,entered;
  const reading=new Promise(resolve=>{entered=resolve;});let hold=true;
  f.port.scanSchedule=async(now,ids)=>{const snapshot=await read(now,ids);if(hold){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return snapshot;};
  const first=f.scheduler.wake('a');await reading;
  f.rows.get('a').incrementalDueAt=2_000;const second=f.scheduler.wake('a');release();await Promise.all([first,second]);
  assert.deepEqual(f.scans,[['a'],['a']]);assert.equal([...f.timers.values()][0].delay,1_000);
 }finally{await f.scheduler.close();}
});

test('到期时只重读到期联系人，建轮后再读新摘要决定计时器',async()=>{
 const f=harness(['a','b']);f.rows.get('a').incrementalDueAt=1_100;
 try{
  await f.scheduler.start();f.scans.length=0;assert.equal([...f.timers.values()][0].delay,100);
  f.setNow(1_100);await f.tick();
  assert.deepEqual(f.scans,[['a'],['a']]);assert.deepEqual(f.events,['incremental:a']);
  assert.equal([...f.timers.values()][0].delay,29_900);
 }finally{await f.scheduler.close();}
});

test('删除及缺失联系人从提示中移除，全局兜底发现新联系人，重启重新加载',async()=>{
 const f=harness(['a','b']);f.rows.get('a').incrementalDueAt=2_000;
 try{
  await f.scheduler.start();f.scans.length=0;f.rows.delete('a');await f.scheduler.wake('a');
  assert.deepEqual(f.scans,[['a']]);assert.equal([...f.timers.values()][0].delay,30_000);
  f.rows.set('c',{contactId:'c',incrementalDueAt:null,historyDue:false});f.scans.length=0;
  f.setNow(31_000);await f.tick();assert.deepEqual(f.scans,[['b','c']]);assert.equal(f.events.length,0);
  await f.scheduler.close();
  const next=harness([],{scheduleContacts:f.port.scheduleContacts,scanSchedule:f.port.scanSchedule});
  try{await next.scheduler.start();assert.deepEqual(f.scans.at(-1),['b','c']);}finally{await next.scheduler.close();}
 }finally{await f.scheduler.close();}
});

test('统一调度保持增量优先和历史轮转，每轮最多一个历史小批',async()=>{
 const f=harness(['old-a','old-b','new']);f.rows.get('old-a').historyDue=true;f.rows.get('old-b').historyDue=true;
 f.port.startHistoryBatch=async id=>{f.events.push(`history:${id}`);return {};};
 try{
  await f.scheduler.start();assert.deepEqual(f.events,['history:old-a']);
  f.rows.get('new').incrementalDueAt=1_000;await f.scheduler.wake('new');
  assert.deepEqual(f.events,['history:old-a','incremental:new','history:old-b']);
 }finally{await f.scheduler.close();}
});

test('失败保持五秒退避，期间重复唤醒不重复建轮',async()=>{
 const f=harness(['a']);let attempts=0;f.rows.get('a').incrementalDueAt=1_000;
 f.port.startContact=async()=>{attempts++;if(attempts===1)throw Error('合成建轮失败');f.rows.get('a').incrementalDueAt=null;return {};};
 try{
  await f.scheduler.start();assert.equal(attempts,1);assert.equal([...f.timers.values()][0].delay,5_000);
  await f.scheduler.wake('a');assert.equal(attempts,1);
  f.setNow(6_000);await f.tick();assert.equal(attempts,2);
 }finally{await f.scheduler.close();}
});

test('关闭等待在途摘要完成，随后不启动任务也不保留计时器',async()=>{
 const f=harness(['a']);let release,enter;
 const entered=new Promise(resolve=>{enter=resolve;});
 f.port.scanSchedule=async()=>{enter();await new Promise(resolve=>{release=resolve;});return {contacts:[{contactId:'a',incrementalDueAt:1_000,historyDue:true}]};};
 const starting=f.scheduler.start();await entered;let closed=false;
 const closing=f.scheduler.close().then(()=>{closed=true;});assert.equal(closed,false);
 release();await Promise.all([starting,closing]);assert.equal(f.events.length,0);assert.equal(f.timers.size,0);
});
