import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';

for(const [name,Service] of [['后续文档',SqliteMemoryDocuments],['记忆裁决',SqliteMemoryAdjudication]]){
 test(`${name}关闭失败后可重试释放，已停止的业务不重新受理`,async t=>{
  const f=await fixture(t);let closes=0;
  const service=new Service(f.storage,owner,{prepare:async()=>{throw Error('不得调用');},invoke:async()=>{throw Error('不得调用');},close:async()=>{if(++closes===1)throw Error('合成模型释放失败');}},new ActiveHolders());
  await assert.rejects(service.close(),/合成模型释放失败/);
  await assert.rejects(service.publishRun('no-reopen-after-close-error'));
  await service.close();await service.close();assert.equal(closes,2);
 });
 test(`${name}并发关闭共同等待释放，不把重试当作已经完成`,async t=>{
  const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();let closes=0;
  const service=new Service(f.storage,owner,{prepare:async()=>{throw Error('不得调用');},invoke:async()=>{throw Error('不得调用');},close:async()=>{closes++;entered.resolve();await release.promise;}},new ActiveHolders());
  t.after(async()=>{release.resolve();await service.close();});
  let firstDone=false,secondDone=false;
  const first=service.close().then(()=>{firstDone=true;});await entered.promise;
  const second=service.close().then(()=>{secondDone=true;});await new Promise(setImmediate);
  assert.equal(firstDone,false);assert.equal(secondDone,false);assert.equal(closes,1);
  release.resolve();await Promise.all([first,second]);
 });
}

test('关闭失败后沿原service重试模型释放，已停止的业务不能重新受理',async t=>{
 const f=await fixture(t);let closes=0;
 const memory=new SqliteMemoryExtraction(f.storage,owner,{prepare:async()=>{throw Error('不得调用');},invoke:async()=>{throw Error('不得调用');},close:async()=>{if(++closes===1)throw Error('合成模型释放失败');}});
 await assert.rejects(memory.close(),/合成模型释放失败/);
 await assert.rejects(memory.start('no-reopen-after-close-error'),{code:'memory_extraction_closed'});
 await memory.close();await memory.close();assert.equal(closes,2);
});

test('并发关闭共同等待模型端口真正排空，不让第二次close提前返回',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
 let closes=0;
 const memory=new SqliteMemoryExtraction(f.storage,owner,{prepare:async()=>{throw Error('不得调用');},invoke:async()=>{throw Error('不得调用');},close:async()=>{closes++;entered.resolve();await release.promise;}});
 t.after(async()=>{release.resolve();await memory.close();});
 let firstDone=false,secondDone=false;
 const first=memory.close().then(()=>{firstDone=true;});await entered.promise;
 const second=memory.close().then(()=>{secondDone=true;});await new Promise(setImmediate);
 assert.equal(firstDone,false);assert.equal(secondDone,false);assert.equal(closes,1);
 release.resolve();await Promise.all([first,second]);assert.equal(firstDone,true);assert.equal(secondDone,true);
});

test('关闭等待启动前置SQLite读取退出，拒绝迟到创建轮次且不调用模型',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
 const storage={execute:async(name,input)=>{if(name==='memoryExtraction.findRequest'){entered.resolve();await release.promise;}return f.storage.execute(name,input);}};
 let memory;const model=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(storage,owner,model);
 t.after(async()=>{release.resolve();await memory.close();});
 const starting=memory.start('close-during-start');starting.catch(()=>{});await entered.promise;
 let closed=false;const closing=memory.close().then(()=>{closed=true;});await new Promise(setImmediate);
 assert.equal(closed,false,'已进入的启动读取仍在途时，close不能返回');
 release.resolve();await assert.rejects(starting,{code:'memory_extraction_closed'});await closing;
 assert.equal(model.calls,0);assert.equal(await f.storage.execute('memoryExtraction.read',{ownerId:owner}),null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('关闭发生在SQLite claim返回前时，不让晚到批次进入模型',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 let held=false;
 const storage={execute:async(name,input)=>{const value=await f.storage.execute(name,input);if(name==='memoryExtraction.claim'&&value&&!held){held=true;entered.resolve();await release.promise;}return value;}};
 let memory;const model=modelPort(()=>memory.accounting);memory=new SqliteMemoryExtraction(storage,owner,model);
 t.after(async()=>{release.resolve();await memory.close();});
 await memory.start('close-during-claim');await entered.promise;
 let closed=false;const closing=memory.close().then(()=>{closed=true;});await new Promise(setImmediate);assert.equal(closed,false);
 release.resolve();await closing;assert.equal(model.calls,0,'claim晚到后也要先检查停止状态');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
