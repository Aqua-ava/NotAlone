import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSqliteHostResources} from '../src/sqlite-host-plugin.ts';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
test('图片同步先排空，再关闭媒体文件服务和SQLite',async()=>{
 const gate=deferred(),started=deferred(),calls=[];
 const closing=closeSqliteHostResources({imageSync:{close:async()=>{calls.push('image-start');started.resolve();await gate.promise;calls.push('image-done');}},media:{close:async()=>{calls.push('media');}},storage:{close:async()=>{calls.push('storage');}}});
 await started.promise;assert.deepEqual(calls,['image-start']);gate.resolve();await closing;
 assert.deepEqual(calls,['image-start','image-done','media','storage']);
});
test('退出先排空首次派发器，再关闭历史和共享存储',async()=>{
 const gate=deferred(),started=deferred(),calls=[];
 const closing=closeSqliteHostResources({firstHistory:{close:async()=>{calls.push('first-start');started.resolve();await gate.promise;calls.push('first-done');}},history:{close:async()=>{calls.push('history');}},contacts:{close:async()=>{calls.push('contacts');}},models:{close:async()=>{calls.push('models');}},storage:{close:async()=>{calls.push('storage');}}});
 await started.promise;assert.deepEqual(calls,['first-start']);gate.resolve();await closing;
 assert.deepEqual(calls,['first-start','first-done','history','contacts','models','storage']);
});
test('首次派发排空失败继续关闭其他领域，但保留共享模型和SQLite供重试',async()=>{
 let fail=true;const calls=[],failure=new Error('合成首次派发器未排空');
 const resources={firstHistory:{close:async()=>{calls.push('first');if(fail)throw failure;}},history:{close:async()=>{calls.push('history');}},contacts:{close:async()=>{calls.push('contacts');}},models:{close:async()=>{calls.push('models');}},storage:{close:async()=>{calls.push('storage');}}};
 await assert.rejects(closeSqliteHostResources(resources),error=>error instanceof AggregateError&&error.errors[0]===failure);
 assert.deepEqual(calls,['first','history','contacts']);fail=false;await closeSqliteHostResources(resources);
 assert.deepEqual(calls,['first','history','contacts','first','history','contacts','models','storage']);
});
test('媒体关闭失败仍逐域排空历史和联系人，保留存储供同操作恢复',async()=>{
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
 await rejected;assert.deepEqual(calls,['media','history-start','history-done','contacts-start','contacts-done']);
});

test('多个领域关闭失败全部保留，不能关闭仍可能被写入的存储',async()=>{
 const failures=[new Error('合成历史关闭失败'),new Error('合成联系人关闭失败'),new Error('合成存储关闭失败')],calls=[];
 await assert.rejects(closeSqliteHostResources({
  history:{close:async()=>{calls.push('history');throw failures[0];}},
  contacts:{close:async()=>{calls.push('contacts');throw failures[1];}},
  storage:{close:async()=>{calls.push('storage');throw failures[2];}},
 }),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors.every((value,index)=>value===failures[index]));
 assert.deepEqual(calls,['history','contacts']);
});


test('全部领域排空后才关闭共享模型和SQLite，存储错误仍不能宣称成功',async()=>{
 const calls=[],failure=new Error('合成SQLite关闭失败');
 await assert.rejects(closeSqliteHostResources({
  discussions:{close:async()=>{calls.push('discussions');}},memory:{close:async()=>{calls.push('memory');}},
  models:{close:async()=>{calls.push('models');}},storage:{close:async()=>{calls.push('storage');throw failure;}},
 }),error=>error instanceof AggregateError&&error.errors[0]===failure);
 assert.deepEqual(calls,['discussions','memory','models','storage']);
});


test('所有CLI使用者排空后才关闭共享进程，随后关闭模型与存储',async()=>{
 const calls=[];
 const resource=name=>({close:async()=>{calls.push(name);}});
 await closeSqliteHostResources({foreground:resource('foreground'),media:resource('media'),history:resource('history'),contacts:resource('contacts'),wechat:resource('wechat'),models:resource('models'),storage:resource('storage')});
 assert.deepEqual(calls,['foreground','media','history','contacts','wechat','models','storage']);
});
