import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './media-support.mjs';
import {SqliteQuoteSyncCoordinator} from '../src/history/sqlite/quote-sync.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {fixture as historyFixture,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteQuoteStore} from '../src/history/sqlite/quote-store.ts';
test('引用读取发现来源变化时建立连续性隔离，不提交内容或继续补读',async t=>{
 const f=await fixture(t),page=f.channel.page;
 f.channel.page=async(...args)=>{const p=await page(...args);return {...p,records:[...p.records,record('5',{partition:'a',table:'one',kind:'other',text:null,originalType:'244813135921',status:'2',metadataOnly:true,stateAssurance:'unverified'})]};};
 await f.history.synchronize(f.contact);const store=new SqliteQuoteStore(f.storage,f.owner);
 assert.equal((await store.candidates(f.contact,'wechat-quote-v1')).length,1);
 f.channel.readQuote=async()=>{throw new StorageFailure('history_quote_source_changed');};
 await assert.rejects(f.history.synchronizeQuotes(f.contact),{code:'history_quote_source_changed'});
 assert.equal((await f.history.coverage(f.contact)).failureCode,'history_source_continuity_unverified');
 assert.deepEqual(await store.candidates(f.contact,'wechat-quote-v1'),[]);
});

test('引用补齐复用活守卫目标，不替换增量目标或游标；重启后等待普通同步建守卫',async t=>{
 const f=await historyFixture(t),contact=f.saved[0].contact_id,inspect=f.channel.inspect;
 f.channel.guardSession={loss:new Promise(()=>{})};
 const capabilities=Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']));
 f.channel.inspect=async scope=>({...await inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities});
 let targets=0,quoteReads=0,acceptedTarget;
 f.channel.target=async()=>acceptedTarget={...f.target,descriptor:`target-${++targets}`};
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:[record('1',{kind:'other',text:null,originalType:'244813135921',status:'2',metadataOnly:true,stateAssurance:'unverified'})],
  completedPartitions:target.partitions,exhausted:true,resumeCursor:'accepted-text-cursor'});
 f.channel.tail=async(_scope,target,cursor)=>{assert.deepEqual(target,acceptedTarget);return {target:target.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true};};
 f.channel.readQuote=async(_scope,target)=>{quoteReads++;assert.deepEqual(target,acceptedTarget);return {replyText:'合成回复',referencedText:'合成原话',referencedSender:null,referencedSenderRole:'unknown',referencedType:'1',referencedServerId:null,proofDigest:'c'.repeat(64)};};
 await f.service.synchronize(contact);await f.service.synchronizeIncremental(contact);
 const before=await f.service.coverage(contact);
 assert.equal((await f.service.synchronizeQuotes(contact)).processed,1);
 assert.equal(targets,1,'引用不得调用target覆盖正文活守卫的固定目标');
 await f.service.synchronizeIncremental(contact);
 const after=await f.service.coverage(contact);assert.equal(after.cursor,before.cursor);assert.notEqual(after.failureCode,'history_source_continuity_unverified');
 const other=f.saved[1].contact_id;await f.service.synchronize(other);assert.equal(targets,2);
 const trustedInspect=f.channel.inspect;f.channel.inspect=async scope=>({...await trustedInspect(scope),statusSemantics:'changed-semantics'});
 assert.deepEqual(await f.service.synchronizeQuotes(other),{processed:0,more:false});assert.equal(targets,2);assert.equal(quoteReads,1);
 f.channel.inspect=trustedInspect;
 await f.service.close();
 const fresh=new SqliteHistoryService(f.storage,f.contacts,()=>f.channel);t.after(()=>fresh.close());
 assert.equal((await new SqliteQuoteStore(f.storage,f.contacts.ownerId).candidates(other,'wechat-quote-v1')).length,1);
 assert.deepEqual(await fresh.synchronizeQuotes(other),{processed:0,more:false});assert.equal(targets,2);assert.equal(quoteReads,1);
});

test('已保存历史引用经同一消息服务补齐，普通唤醒去重且不重置文字游标',async t=>{
 const f=await fixture(t),page=f.channel.page;
 f.channel.page=async(...args)=>{const p=await page(...args);return {...p,records:[...p.records,{partition:'a',table:'one',localId:'5',serverId:'0',sender:'owner',kind:'other',text:null,originalType:'244813135921',sentAt:'1793374394000',timePrecision:'millisecond',orderScheme:null,orderKey:null,status:'2',stateAssurance:'unverified',metadataOnly:true}]};};
 await f.history.synchronize(f.contact);const before=await f.history.coverage(f.contact);
 const quote=(await f.history.read(f.contact)).messages.find(m=>m.originalType==='244813135921');
 let calls=0;f.channel.readQuote=async(_scope,_target,source)=>{calls++;assert.equal(source.messageId,quote.id);return {replyText:'周六回',referencedText:'周末回来吗？',referencedSender:'合成联系人',referencedSenderRole:'contact',referencedType:'1',referencedServerId:'0',proofDigest:'c'.repeat(64)};};
 assert.deepEqual(await f.history.synchronizeQuotes(f.contact),{processed:1,more:false});
 const after=(await f.history.readChat(f.contact)).messages.find(m=>m.id===quote.id);
 assert.equal(after.quote.replyText,'周六回');assert.equal(after.quote.referencedText,'周末回来吗？');assert.equal(after.quote.state,'unresolved');
 assert.deepEqual(await f.history.synchronizeQuotes(f.contact),{processed:0,more:false});assert.equal(calls,1);
 const coverage=await f.history.coverage(f.contact);assert.equal(coverage.messageCount,before.messageCount);assert.equal(coverage.cursor,before.cursor);
});

test('引用无法核验时记账并停止重复读取，关闭同步不能补读历史',async t=>{
 const f=await fixture(t),page=f.channel.page;
 f.channel.page=async(...args)=>{const p=await page(...args);return {...p,records:[...p.records,{partition:'a',table:'one',localId:'5',serverId:'0',sender:'owner',kind:'other',text:null,originalType:'244813135921',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,status:'3',stateAssurance:'unverified',metadataOnly:true}]};};
 await f.history.synchronize(f.contact);let calls=0;f.channel.readQuote=async()=>{calls++;throw new StorageFailure('history_quote_state_unverified');};
 assert.equal((await f.history.synchronizeQuotes(f.contact)).processed,1);
 assert.equal((await f.history.synchronizeQuotes(f.contact)).processed,0);assert.equal(calls,1);
 await f.contacts.setReading(false);await assert.rejects(f.history.synchronizeQuotes(f.contact));assert.equal(calls,1);
});

test('后台引用补齐关闭开关不读，停止会取消并排空正在读取的批次',async()=>{
 let enabled=false,calls=0,entered;const started=new Promise(resolve=>{entered=resolve;});
 const contacts={directory:async()=>({read_enabled:enabled,bindings:[{contact_id:'synthetic',status:'active'}]})};
 const history={synchronizeQuotes:async(_contact,signal)=>{calls++;entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {processed:0,more:false};}};
 const sync=new SqliteQuoteSyncCoordinator(contacts,history);sync.wake();await sync.waitForIdle();assert.equal(calls,0);
 enabled=true;sync.wake();await started;await sync.stop();assert.equal(calls,1);sync.wake('synthetic');await sync.waitForIdle();assert.equal(calls,1);await sync.close();
});

test('普通同步页内唤醒引用时等待该读取结束再补齐，不丢失历史补齐唤醒',async()=>{
 let release,waiting,calls=0;const ordinaryDone=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{waiting=resolve;});
 const contacts={directory:async()=>({read_enabled:true,bindings:[{contact_id:'synthetic',status:'active'}]})};
 const history={synchronizeQuotes:async()=>{if(++calls===1)throw new StorageFailure('history_already_running');return {processed:1,more:false};},
  waitForReadIdle:async()=>{waiting();await ordinaryDone;}};
 const sync=new SqliteQuoteSyncCoordinator(contacts,history);sync.wake();
 await Promise.race([entered,sync.waitForIdle()]);assert.equal(calls,1);release();await sync.waitForIdle();assert.equal(calls,2);await sync.close();
 let notify;const blocked=new Promise(resolve=>{notify=resolve;});
 const stopped=new SqliteQuoteSyncCoordinator(contacts,{synchronizeQuotes:async()=>{throw new StorageFailure('history_already_running');},waitForReadIdle:()=>{notify();return new Promise(()=>{});}});
 stopped.wake();await blocked;await stopped.stop();await stopped.close();
});
