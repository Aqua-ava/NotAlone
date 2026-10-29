import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSqliteHostResources} from '../src/sqlite-host-plugin.ts';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
test('媒体关闭失败仍逐域排空历史和联系人，存储最后关闭且保留原异常',async()=>{
 const mediaFailure=new Error('合成媒体关闭失败');const historyGate=deferred(),historyStarted=deferred(),contactGate=deferred(),contactStarted=deferred();const calls=[];
 const closing=closeSqliteHostResources({
  media:{close:async()=>{calls.push('media');throw mediaFailure;}},
  history:{close:async()=>{calls.push('history-start');historyStarted.resolve();await historyGate.promise;calls.push('history-done');}},
  contacts:{close:async()=>{calls.push('contacts-start');contactStarted.resolve();await contactGate.promise;calls.push('contacts-done');}},
  storage:{close:async()=>{calls.push('storage');}},
 });
 const rejected=assert.rejects(closing,error=>error instanceof AggregateError&&error.errors.length===1&&error.errors[0]===mediaFailure);
 await historyStarted.promise;assert.deepEqual(calls,['media','history-start']);historyGate.resolve();
 await contactStarted.promise;assert.deepEqual(calls,['media','history-start','history-done','contacts-start']);contactGate.resolve();
 await rejected;assert.deepEqual(calls,['media','history-start','history-done','contacts-start','contacts-done','storage']);
});

test('多个领域及存储关闭失败全部保留，不跳过后续关闭',async()=>{
 const failures=[new Error('合成历史关闭失败'),new Error('合成联系人关闭失败'),new Error('合成存储关闭失败')],calls=[];
 await assert.rejects(closeSqliteHostResources({
  history:{close:async()=>{calls.push('history');throw failures[0];}},
  contacts:{close:async()=>{calls.push('contacts');throw failures[1];}},
  storage:{close:async()=>{calls.push('storage');throw failures[2];}},
 }),error=>error instanceof AggregateError&&error.errors.length===3&&error.errors.every((value,index)=>value===failures[index]));
 assert.deepEqual(calls,['history','contacts','storage']);
});
