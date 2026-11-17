import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './media-support.mjs';
import {SqliteQuoteSyncCoordinator} from '../src/history/sqlite/quote-sync.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {fixture as historyFixture,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteQuoteStore} from '../src/history/sqlite/quote-store.ts';
import {prepareRecord} from '../src/history/sqlite/normalize.ts';
test('引用成功内容与单条失败码同时出现时拒绝整条引用载荷',()=>{
 const prepared=prepareRecord(record('98',{kind:'other',text:null,originalType:'244813135921',serverId:'98',metadataOnly:true,stateAssurance:'unverified',
  quote:{replyText:'回复',referencedText:'原话',referencedSender:null,referencedSenderRole:'unknown',referencedType:'1',referencedServerId:'7',proofDigest:'b'.repeat(64)},
  quoteErrorCode:'history_quote_read_failed'}),'source-1',{partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}]});
 assert.equal(prepared.reason,'message_content_unverified');
 assert.equal(prepared.quote,undefined);assert.equal(prepared.quoteErrorCode,undefined);
 assert.equal(prepared.raw.includes('原话'),false);
});
test('普通同步页内引用随消息入库并立即读取，不再候选给后台二次读取',async t=>{
 const f=await historyFixture(t),contact=f.saved[0].contact_id,previousPage=f.channel.page;
 const quoteRecord=record('99',{kind:'other',text:null,originalType:'244813135921',status:'2',serverId:'99',metadataOnly:true,stateAssurance:'unverified',
  quote:{replyText:'周六回',referencedText:'周末回来吗？',referencedSender:'合成联系人',referencedSenderRole:'contact',referencedType:'1',referencedServerId:'77',proofDigest:'d'.repeat(64)}});
 f.channel.page=async(...args)=>{const page=await previousPage(...args);return {...page,records:[...page.records,quoteRecord]};};
 let separateReads=0;f.channel.readQuote=async()=>{separateReads++;throw new Error('新同步消息不应再触发quote-read');};
 await f.service.synchronize(contact);
 const stored=(await f.service.readChat(contact)).messages.find(message=>message.originalType==='244813135921');
 assert.equal(stored.quote.replyText,'周六回');
 assert.equal(stored.quote.referencedText,'周末回来吗？');
 assert.equal(stored.quote.state,'unresolved');
 assert.equal((await new SqliteQuoteStore(f.storage,f.contacts.ownerId).candidates(contact,'wechat-quote-v2')).length,0);
 assert.equal(separateReads,0);
 const source=await f.service.source(contact,stored.sourceRecordIds[0]);
 assert.equal(JSON.stringify(source.raw).includes('周末回来吗'),false,'引用正文不得进入原始来源载荷');
});
test('普通同步页的单条引用安全失败会记账且不阻断同页后续正文',async t=>{
 const f=await historyFixture(t),contact=f.saved[0].contact_id,previousPage=f.channel.page;
 const failedQuote=record('98',{kind:'other',text:null,originalType:'244813135921',status:'2',serverId:'98',metadataOnly:true,stateAssurance:'unverified',
  quoteErrorCode:'history_quote_unavailable'});
 f.channel.page=async(...args)=>{const page=await previousPage(...args);return {...page,records:[...page.records,failedQuote,record('97',{text:'引用失败之后仍正常同步'})]};};
 let separateReads=0;f.channel.readQuote=async()=>{separateReads++;throw new Error('同步页中的失败引用不应进入后台重读');};
 await f.service.synchronize(contact);
 const read=await f.service.readChat(contact),failed=read.messages.find(message=>message.originalType==='244813135921');
 assert.equal(failed.quoteErrorCode,'history_quote_unavailable');
 assert.ok(read.messages.some(message=>message.text==='引用失败之后仍正常同步'));
 assert.equal((await new SqliteQuoteStore(f.storage,f.contacts.ownerId).candidates(contact,'wechat-quote-v2')).length,0);
 assert.equal(separateReads,0);
});
test('同页引用扩展写入失败时捕获事务回滚且历史游标不推进',async t=>{
 const f=await historyFixture(t,{registryModule:new URL('./fixtures/memory-sqlite/quote-write-failure-registry.mjs',import.meta.url).href});
 const contact=f.saved[0].contact_id,before=await f.service.coverage(contact),quoteRecord=record('44',{kind:'other',text:null,originalType:'244813135921',status:'2',serverId:'44',metadataOnly:true,stateAssurance:'unverified',
  quote:{replyText:'事务回滚回复',referencedText:'事务回滚引用',referencedSender:'合成联系人',referencedSenderRole:'contact',referencedType:'1',referencedServerId:'77',proofDigest:'f'.repeat(64)}});
 const previousPage=f.channel.page;
 f.channel.page=async(...args)=>{const page=await previousPage(...args);return {...page,records:[quoteRecord],cursorOut:'inline-cursor-after-quote',completedPartitions:[],exhausted:false};};
 await f.storage.execute('test.installQuoteWriteFailure',{});
 await assert.rejects(f.service.synchronize(contact));
 const after=await f.service.coverage(contact);
 assert.equal(after.cursor,before.cursor);
 assert.equal(after.messageCount,before.messageCount);
 assert.equal((await f.service.read(contact)).messages.some(message=>message.originalType==='244813135921'),false);
});
test('重复同步来源首次补入引用会发布updated，完全相同的重复观察不再刷新',async t=>{
 const f=await historyFixture(t),contact=f.saved[0].contact_id,previousPage=f.channel.page,changes=[];
 let quoteRecord=record('99',{kind:'other',text:null,originalType:'244813135921',status:'2',serverId:'99',metadataOnly:true,stateAssurance:'unverified'});
 f.channel.page=async(...args)=>{const page=await previousPage(...args);return {...page,records:[...page.records,quoteRecord]};};
 const service=new SqliteHistoryService(f.storage,f.contacts,f.channel,undefined,(...change)=>changes.push(change));t.after(()=>service.close());
 await service.synchronize(contact);
 const carrier=(await service.readChat(contact)).messages.find(message=>message.originalType==='244813135921');assert.ok(carrier);
 changes.length=0;
 quoteRecord={...quoteRecord,quote:{replyText:'补入回复',referencedText:'补入原话',referencedSender:'合成联系人',referencedSenderRole:'contact',referencedType:'1',referencedServerId:'77',proofDigest:'a'.repeat(64)}};
 await service.synchronize(contact);
 assert.deepEqual(changes,[[contact,carrier.id,'updated']]);
 changes.length=0;
 await service.synchronize(contact);
 assert.deepEqual(changes,[],'相同引用重放不能重复发消息更新事件');
});
test('重复同步来源首次记账引用失败会发布updated，同码重放不重复刷新',async t=>{
 const f=await historyFixture(t),contact=f.saved[0].contact_id,previousPage=f.channel.page,changes=[];
 let quoteRecord=record('100',{kind:'other',text:null,originalType:'244813135921',status:'2',serverId:'100',metadataOnly:true,stateAssurance:'unverified'});
 f.channel.page=async(...args)=>{const page=await previousPage(...args);return {...page,records:[...page.records,quoteRecord]};};
 const service=new SqliteHistoryService(f.storage,f.contacts,f.channel,undefined,(...change)=>changes.push(change));t.after(()=>service.close());
 await service.synchronize(contact);
 const carrier=(await service.readChat(contact)).messages.find(message=>message.originalType==='244813135921');assert.ok(carrier);
 changes.length=0;quoteRecord={...quoteRecord,quoteErrorCode:'history_quote_read_failed'};
 await service.synchronize(contact);
 assert.deepEqual(changes,[[contact,carrier.id,'updated']]);
 changes.length=0;await service.synchronize(contact);
 assert.deepEqual(changes,[],'重复失败码不可重复发送更新事件');
});
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

test('引用补齐逐轮核验独立目标，保留正文检查点并在重启后复验读取资格',async t=>{
 const f=await historyFixture(t),contact=f.saved[0].contact_id,inspect=f.channel.inspect;
 f.channel.guardSession={loss:new Promise(()=>{})};
 const capabilities=Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail','durableIncremental'].map(key=>[key,'supported']));
 f.channel.inspect=async scope=>({...await inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities});
 let targets=0,quoteReads=0,acceptedTarget;
 f.channel.target=async()=>acceptedTarget={...f.target,descriptor:`target-${++targets}`};
 f.channel.resumeTarget=async()=>f.channel.target();
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:[record('1',{kind:'other',text:null,originalType:'244813135921',status:'2',metadataOnly:true,stateAssurance:'unverified'})],
  completedPartitions:target.partitions,exhausted:true,resumeCursor:'accepted-text-cursor'});
 f.channel.tail=async(_scope,target,cursor)=>{assert.deepEqual(target,acceptedTarget);return {target:target.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true};};
 f.channel.readQuote=async(_scope,target)=>{quoteReads++;assert.deepEqual(target,acceptedTarget);return {replyText:'合成回复',referencedText:'合成原话',referencedSender:null,referencedSenderRole:'unknown',referencedType:'1',referencedServerId:null,proofDigest:'c'.repeat(64)};};
 await f.service.synchronize(contact);await f.service.synchronizeIncremental(contact);
 const token=await f.contacts.eligibility(contact),scope=await f.storage.execute('history.scope',{token}),report=await f.channel.inspect(scope);
 const checkpoint=()=>f.storage.execute('history.resumeCheckpoint',{token,report});
 const before=await f.service.coverage(contact),beforeCheckpoint=await checkpoint(),beforeTargets=targets;
 assert.equal(beforeCheckpoint.cursor,'accepted-text-cursor','先建立实际已接受的正文检查点');
 assert.equal((await f.service.synchronizeQuotes(contact)).processed,1);
 assert.equal(targets,beforeTargets+1,'引用为本轮独立建立目标，不复用上轮已释放的守卫');
 assert.equal((await checkpoint()).cursor,beforeCheckpoint.cursor,'引用补齐不得推进正文恢复点');
 await f.service.synchronizeIncremental(contact);
 const after=await f.service.coverage(contact);assert.equal(after.cursor,before.cursor);assert.notEqual(after.failureCode,'history_source_continuity_unverified');
 const other=f.saved[1].contact_id;await f.service.synchronize(other);
 const store=new SqliteQuoteStore(f.storage,f.contacts.ownerId),trustedInspect=f.channel.inspect,beforeInvalid=targets;
 f.channel.inspect=async scope=>({...await trustedInspect(scope),status:'unverified',reason:'synthetic_unverified'});
 await assert.rejects(f.service.synchronizeQuotes(other),{code:'history_support_unverified'});
 assert.equal(targets,beforeInvalid,'本轮报告未核验时不能建立目标或读取引用');assert.equal(quoteReads,1);
 assert.equal((await store.candidates(other,'wechat-quote-v2')).length,1,'拒绝不记作已补齐或已失败');
 f.channel.inspect=trustedInspect;await f.service.close();
 const fresh=new SqliteHistoryService(f.storage,f.contacts,()=>({...f.channel,guardSession:{loss:new Promise(()=>{})}}));t.after(()=>fresh.close());
 await f.contacts.setReading(false);
 await assert.rejects(fresh.synchronizeQuotes(other),{code:'read_not_authorized'});
 assert.equal(targets,beforeInvalid);assert.equal(quoteReads,1,'重启后的关闭读取状态不能借来源重验放行');
 await f.contacts.setReading(true);
 assert.deepEqual(await fresh.synchronizeQuotes(other),{processed:1,more:false});
 assert.equal(targets,beforeInvalid+1,'新服务独立核验当前目标，不要求上轮守卫继续存活');assert.equal(quoteReads,2);
 assert.equal((await store.candidates(other,'wechat-quote-v2')).length,0);
 assert.equal((await fresh.readChat(other)).messages[0].quote.replyText,'合成回复');
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
