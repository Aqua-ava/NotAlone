import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {PureTsMaintenance} from '../src/host/pure-ts-maintenance.ts';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
test('分层维护PG通知只唤醒同一调度器，关闭取消在途并释放监听连接',{timeout:10000},async t=>{
 const f=await pureTsFixture(t),pool=new pg.Pool({host:'/tmp',database:f.client.database});
 let ending;const end=()=>ending??=pool.end();
 let first,second,release;const initial=new Promise(resolve=>first=resolve),notified=new Promise(resolve=>second=resolve),gate=new Promise(resolve=>release=resolve);
 let calls=0,active=0,maximum=0,signal;
 const maintenance=new PureTsMaintenance(pool,async current=>{
  calls++;active++;maximum=Math.max(maximum,active);signal=current;
  try{if(calls===1)first();else{second();await gate;}return {nextDueAt:null};}finally{active--;}
 });
 f.cleanup(async()=>{release();await maintenance.close();await end();});
 await maintenance.start();await initial;
 await f.client.query('NOTIFY layered_memory_changed');await notified;
 await f.client.query('NOTIFY layered_memory_changed');
 const closing=maintenance.close();assert.equal(signal.aborted,true);release();await closing;
 assert.equal(calls,2);assert.equal(maximum,1);
 await f.client.query('NOTIFY layered_memory_changed');await end();
});
