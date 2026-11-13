import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSqliteHostResources} from '../src/sqlite-host-plugin.ts';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
test('退出同时通知所有领域停读，先关闭者等待后关闭者释放租约也能完成',async()=>{
 const firstStarted=deferred(),incrementalStopped=deferred(),historyStopped=deferred(),calls=[];
 const closing=closeSqliteHostResources({
  firstHistory:{close:async()=>{calls.push('first-start');firstStarted.resolve();await incrementalStopped.promise;calls.push('first-done');}},
  incremental:{close:async()=>{calls.push('incremental-start');await historyStopped.promise;incrementalStopped.resolve();calls.push('incremental-done');}},
  history:{close:async()=>{calls.push('history');historyStopped.resolve();}},
  wechat:{close:async()=>{assert.ok(calls.includes('first-done'));assert.ok(calls.includes('incremental-done'));calls.push('wechat');}},
  storage:{close:async()=>{calls.push('storage');}},
 });
 try{
  await firstStarted.promise;
  assert.ok(calls.includes('incremental-start'),'等待首次派发器排空时也必须已经通知增量协调器停读');
  assert.ok(calls.includes('history'),'等待协调器排空时也必须已经通知底层历史读者释放');
 }finally{historyStopped.resolve();incrementalStopped.resolve();await closing;}
 assert.deepEqual(calls.slice(-2),['wechat','storage']);
});
test('图片同步与媒体同时停读，全部排空后才关闭SQLite',async()=>{
 const gate=deferred(),started=deferred(),calls=[];
 const closing=closeSqliteHostResources({imageSync:{close:async()=>{calls.push('image-start');started.resolve();await gate.promise;calls.push('image-done');}},media:{close:async()=>{calls.push('media');}},storage:{close:async()=>{calls.push('storage');}}});
 await started.promise;assert.deepEqual(calls,['image-start','media']);gate.resolve();await closing;
 assert.deepEqual(calls,['image-start','media','image-done','storage']);
});
test('退出同时停止首次派发器与历史读者，排空后再关闭共享存储',async()=>{
 const gate=deferred(),started=deferred(),calls=[];
 const closing=closeSqliteHostResources({firstHistory:{close:async()=>{calls.push('first-start');started.resolve();await gate.promise;calls.push('first-done');}},history:{close:async()=>{calls.push('history');}},contacts:{close:async()=>{calls.push('contacts');}},models:{close:async()=>{calls.push('models');}},storage:{close:async()=>{calls.push('storage');}}});
 await started.promise;assert.deepEqual(calls,['first-start','history','contacts']);gate.resolve();await closing;
 assert.deepEqual(calls,['first-start','history','contacts','first-done','models','storage']);
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
 await historyStarted.promise;await contactStarted.promise;assert.deepEqual(calls,['media','history-start','contacts-start']);
 historyGate.resolve();contactGate.resolve();
 await rejected;assert.deepEqual(calls,['media','history-start','contacts-start','history-done','contacts-done']);
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
test('停读失败只给出拒绝关闭的资源键，其余资源照常排空且不继续关闭共享存储',async()=>{
 const calls=[];
 await assert.rejects(closeSqliteHostResources({
  imageSync:{close:async()=>{calls.push('image');throw new Error('合成私密失败原因');}},
  media:{close:async()=>{calls.push('media');}},
  memory:{close:async()=>{calls.push('memory');throw new Error('另一个合成失败');}},
  wechat:{close:async()=>{calls.push('wechat');}},
  storage:{close:async()=>{calls.push('storage');}},
 }),error=>{
  assert.equal(error.message,'SQLITE_HOST_RESOURCE_CLOSE_FAILED');assert.equal(error.errors.length,2);
  assert.deepEqual([...error.resources],['imageSync','memory']);
  assert.doesNotMatch(JSON.stringify(error.resources),/合成/);
  return true;
 });
 assert.deepEqual(calls.sort(),['image','media','memory']);
});
test('后段资源关闭失败同样记录资源键',async()=>{
 await assert.rejects(closeSqliteHostResources({wechat:{close:async()=>{throw new Error('x');}},storage:{close:async()=>{}}}),error=>[...error.resources].join()==='wechat');
 await assert.rejects(closeSqliteHostResources({storage:{close:async()=>{throw new Error('x');}}}),error=>[...error.resources].join()==='storage');
});

const quick={domains:30,wechat:30,models:30,storage:30};
test('领域关闭挂住时到期强制继续，仍按序关闭共享资源并报告被强制的领域',async()=>{
 const calls=[],never=new Promise(()=>{});
 const report=await closeSqliteHostResources({
  history:{close:()=>never},contacts:{close:async()=>{calls.push('contacts');}},
  wechat:{close:async()=>{calls.push('wechat');}},models:{close:async()=>{calls.push('models');}},storage:{close:async()=>{calls.push('storage');}},
 },{deadlines:quick});
 assert.deepEqual(report.forced,['history']);assert.deepEqual(calls,['contacts','wechat','models','storage']);
});
test('领域明确关闭失败优先于超时：仍抛出，且不关闭共享存储',async()=>{
 const failure=new Error('合成联系人关闭失败'),calls=[];
 await assert.rejects(closeSqliteHostResources({
  history:{close:()=>new Promise(()=>{})},contacts:{close:async()=>{throw failure;}},
  storage:{close:async()=>{calls.push('storage');}},
 },{deadlines:quick}),error=>error instanceof AggregateError&&error.errors.length===1&&error.errors[0]===failure);
 assert.deepEqual(calls,[]);
});
test('微信、模型、存储任一阶段挂住都到期返回，并逐项报告',async()=>{
 const never=()=>new Promise(()=>{}),calls=[];
 const report=await closeSqliteHostResources({
  wechat:{close:never},models:{close:never},storage:{close:never},
 },{deadlines:quick});
 assert.deepEqual(report.forced,['wechat','models','storage']);
 const normal=await closeSqliteHostResources({models:{close:async()=>{calls.push('models');}},storage:{close:async()=>{calls.push('storage');}}});
 assert.deepEqual(normal.forced,[]);assert.deepEqual(calls,['models','storage']);
});
test('资源自报的强制项并入报告，不影响停读成功',async()=>{
 const report=await closeSqliteHostResources({models:{close:async()=>({forced:['modelOrphans']})},storage:{close:async()=>{}}},{deadlines:quick});
 assert.deepEqual(report.forced,['modelOrphans']);
});
