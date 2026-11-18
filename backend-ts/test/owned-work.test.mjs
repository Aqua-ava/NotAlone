import test from 'node:test';
import assert from 'node:assert/strict';
import {OwnedWork} from '../src/reply/sqlite/owned-work.ts';

test('关闭会撤销在途工作并等待其结算，之后登记为已关闭', async()=>{
 const work=new OwnedWork();
 let aborted=false;
 const running=work.run(undefined,signal=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));});}));
 assert.equal(work.closed,false);
 const closing=work.close();
 assert.equal(work.closed,true);
 await assert.rejects(running,/cancelled/);
 await closing;
 assert.equal(aborted,true);
 assert.equal(work.close(),work.close());
});

test('调用方信号与关闭信号合并，任一方撤销都会传给工作',async()=>{
 const work=new OwnedWork(),caller=new AbortController();
 const run=work.run(caller.signal,signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stop')))));
 caller.abort();
 await assert.rejects(run,/stop/);
 await work.close();
});

test('正常结算后移除登记，工作同步抛错时不残留控制器',async()=>{
 const work=new OwnedWork();
 assert.equal(await work.run(undefined,async()=>7),7);
 assert.throws(()=>work.run(undefined,()=>{throw new Error('sync');}),/sync/);
 await assert.rejects(work.run(undefined,async()=>{throw new Error('late');}),/late/);
 await work.close();
});
