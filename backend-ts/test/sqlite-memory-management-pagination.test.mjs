import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {supplier} from './fixtures/memory-management/supplier.mjs';

test('超过一万条记忆仍有界读取，游标可逐页查看且范围或修订变化后失效',{timeout:120000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/pagination-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId},management=new SqliteMemoryManagement(f.storage,owner);
 for(let start=0;start<10001;start+=500)await f.storage.execute('fixture.seedManagementMemories',{ownerId:owner,contactId,start,count:Math.min(500,10001-start)});
 const preparing=await f.storage.execute('memory.read',{ownerId:owner,scope});assert.equal(preparing.page.preparing,true);assert.deepEqual(preparing.memories,[]);
 const batch=await f.storage.execute('memory.prepareTimeline',{ownerId:owner,scope});assert.equal(batch.prepared,32);assert.equal(batch.ready,false);
 let first=await management.read(scope);while(first.page.preparing)first=await management.read(scope);
 assert.ok(first.memories.length>0&&first.memories.length<=20,`首页不得加载全部 ${first.memories.length} 条记忆`);
 assert.ok(first.page.nextCursor);assert.ok(first.memories.every(memory=>memory.versions.length<=1&&memory.decisions.length===0),'列表只投影当前版');
 assert.ok(Buffer.byteLength(JSON.stringify(first))<1024*1024);
 const second=await management.read(scope,{cursor:first.page.nextCursor});
 assert.equal(second.page.revision,first.page.revision);assert.equal(second.memories.length,20);
 assert.ok(second.memories.every(memory=>!first.memories.some(previous=>previous.id===memory.id)));
 await assert.rejects(management.read({scopeKind:'contact',contactId:f.saved[1].contact_id},{cursor:first.page.nextCursor}),{code:'memory_page_stale'});
 const selected=first.memories[0];
 await management.decide({requestKey:'pagination-update',action:'correct',memoryId:selected.id,expectedVersionNo:selected.current.versionNo,expectedHeadRevision:selected.headRevision,body:'合成修正'});
 await assert.rejects(management.read(scope,{cursor:first.page.nextCursor}),{code:'memory_page_stale'});
 const history=await management.readHistory(scope,selected.id);
 assert.deepEqual(history.versions.map(version=>version.body),[selected.current.body,'合成修正']);
 assert.equal(history.decisions.length,2);assert.equal(history.nextCursor,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('取消目录准备后不再领取后续批次，按ID读取与历史不等待全目录',async()=>{
 const controller=new AbortController(),calls=[];
 const storage={execute:async(name)=>{calls.push(name);if(name==='memory.prepareTimeline'){controller.abort();return {ready:false};}return {candidates:[],memories:[]};}};
 const management=new SqliteMemoryManagement(storage,owner),scope={scopeKind:'contact',contactId:'11111111-1111-4111-8111-111111111111'};
 await assert.rejects(management.read(scope,{}, {signal:controller.signal}),{code:'memory_read_cancelled'});assert.deepEqual(calls,['memory.prepareTimeline']);
 calls.length=0;await management.read(scope,{memoryId:'22222222-2222-4222-8222-222222222222'});assert.deepEqual(calls,['memory.read']);
 calls.length=0;await management.readHistory(scope,'22222222-2222-4222-8222-222222222222');assert.deepEqual(calls,['memory.history']);
});

test('时间线跨页保持当前来源日期全局顺序，未知置后，来源时间变化撤销游标',{timeout:30000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/pagination-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId},management=new SqliteMemoryManagement(f.storage,owner);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:24},(_,index)=>record(String(index+1),{text:`我长期保留合成事项${index+1}。`,sentAt:index===0?null:String(1700000000000+index*1000),timePrecision:index===0?null:'millisecond'})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const run=await extraction.start('pagination-source-time');await extraction.waitForIdle();await management.importRun(run.runId);
 const candidates=[];let cursor;
 do{const page=await management.read(scope,cursor?{cursor}:{});candidates.push(...page.candidates);cursor=page.page.nextCursor;}while(cursor);
 assert.equal(candidates.length,24);
 for(const candidate of candidates)await management.decide({requestKey:`accept-${candidate.id}`,action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 await management.decide({requestKey:'unknown-manual',action:'manual',scope,body:'没有聊天日期的独立合成手录'});
 const first=await management.read(scope),second=await management.read(scope,{cursor:first.page.nextCursor});
 const all=[...first.memories,...second.memories],dates=all.map(memory=>memory.current?.sources[0]?.sentAt??null);
 assert.equal(all.length,25);assert.equal(new Set(all.map(memory=>memory.id)).size,25);assert.equal(second.page.nextCursor,null);
 assert.deepEqual(dates,[...Array.from({length:23},(_,index)=>String(1700000000000+(23-index)*1000)),null,null]);
 const moved=all.find(memory=>memory.current?.sources[0]?.sentAt==='1700000001000');
 await f.storage.execute('fixture.updateManagementSourceTime',{ownerId:owner,memoryId:moved.id,sentAt:'1800000000000'});
 await assert.rejects(management.read(scope,{cursor:first.page.nextCursor}),{code:'memory_page_stale'});
 assert.equal((await management.read(scope)).memories[0].id,moved.id);
});

test('一个记忆的版本与决定历史也分页，后页修改与失效游标不会误用首页',{timeout:10000},async t=>{
 const f=await fixture(t),scope={scopeKind:'contact',contactId:f.saved[0].contact_id},management=new SqliteMemoryManagement(f.storage,owner);
 const created=await management.decide({requestKey:'history-first',action:'manual',scope,body:'版本1'});
 for(let index=2;index<=43;index++){
  const memory=(await management.read(scope,{memoryId:created.memoryId})).memories[0];
  await management.decide({requestKey:`history-${index}`,action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:`版本${index}`});
 }
 const summary=(await management.read(scope)).memories[0];assert.equal(summary.versions.length,1);assert.equal(summary.decisions.length,0);
 const versions=[],decisions=[];let cursor,first;
 do{const page=await management.readHistory(scope,created.memoryId,cursor?{cursor}:{});first??=page;assert.ok(page.versions.length<=20&&page.decisions.length<=20);versions.unshift(...page.versions);decisions.unshift(...page.decisions);cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(versions.map(version=>version.body),Array.from({length:43},(_,index)=>`版本${index+1}`));assert.equal(new Set(decisions.map(decision=>decision.id)).size,43);
 await management.decide({requestKey:'history-protect',action:'protect',memoryId:summary.id,expectedVersionNo:summary.current.versionNo,expectedHeadRevision:summary.headRevision});
 await assert.rejects(management.readHistory(scope,created.memoryId,{cursor:first.nextCursor}),{code:'memory_page_stale'});
});
