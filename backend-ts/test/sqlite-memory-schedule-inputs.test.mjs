import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';

const registryModule=new URL('./fixtures/memory-sqlite/schedule-inputs-registry.mjs',import.meta.url).href;
async function prepared(t,records){
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 const execute=f.storage.execute.bind(f.storage);f.storage.execute=async(name,...args)=>{try{return await execute(name,...args);}catch(error){throw new Error(`合成测试动作失败：${name}`,{cause:error});}};
 f.channel.page=async(_scope,target,cursor)=>{const offset=cursor===null?0:Number(cursor),next=offset+1000,exhausted=next>=records.length;return {target:target.descriptor,cursorIn:cursor,cursorOut:exhausted?null:String(next),records:records.slice(offset,next),completedPartitions:exhausted?['shard-a']:[],exhausted,...(exhausted?{resumeCursor:'tail-1'}:{})};};
 await f.service.synchronize(contactId);
 const inspect=(metadata=false,baseline,availability)=>f.storage.execute('scheduleInputs.inspect',{ownerId:owner,contactId,metadata,...(baseline===undefined?{}:{baseline}),...(availability?{availability}:{})});
 const change=change=>f.storage.execute('scheduleInputs.change',{ownerId:owner,contactId,...change});
 return {f,contactId,inspect,change};
}

test('轻量统计同轮复用候选、不加载正文且批量保留Unicode文字可用性',async t=>{
 const {inspect}=await prepared(t,Array.from({length:600},(_,i)=>record(String(i+1),{text:i<4?'\uFEFF\u3000\t\n':'合成有效文字'})));
 const result=await inspect();assert.equal(result.history.count,596);assert.equal(result.incremental.count,0);
 assert.equal(result.bodyRows,0);assert.equal(result.sourceQueries,1);assert.ok(result.queries<30,`轻量统计不得逐消息查询：${result.queries}`);
 t.diagnostic(JSON.stringify({messages:600,queries:result.queries,sourceQueries:result.sourceQueries,bodyRows:result.bodyRows,elapsedMs:Math.round(result.elapsedMs*10)/10}));
});

test('首次available来源与当前来源分开，启用边界和动作级缓存保持正确',async t=>{
 const {f,contactId,inspect,change}=await prepared(t,[record('1'),record('2',{text:'\u3000\uFEFF'}),record('3',{kind:'image',text:null,originalType:'3'})]);
 const original=await inspect(true),availableRecord='00000000-0000-0000-0000-000000000002';
 await change({proofs:[{messageId:original.metadata[0].id,id:'00000000-0000-0000-0000-000000000001',availability:'deleting'},{messageId:original.metadata[0].id,id:availableRecord,availability:'available'}]});
 const coverage=await f.service.coverage(contactId),token=await f.contacts.eligibility(contactId),at=1700000000000;
 await f.storage.execute('history.acceptIncrementalPage',{token,goalId:coverage.incremental.goalId,captureId:randomUUID(),page:{target:f.target.descriptor,cursorIn:'tail-1',cursorOut:'tail-2',caughtUp:true,records:[record('1'),record('4'),record('5',{kind:'image',text:null,originalType:'3'})]},at,runtimeToken:f.storage.status.runtimeId});
 const first=await inspect(true);assert.equal(first.history.count,1);assert.equal(first.incremental.count,1);assert.equal(first.incremental.oldestAt,at);assert.equal(first.incremental.latestAt,at);
 assert.equal(first.metadata[0].record_id,availableRecord,'metadata保留当前有效最小来源，不能选择更小的已删除来源');
 assert.equal(first.sourceQueries,1);assert.equal(first.bodyRows,0);
 assert.deepEqual(first.metadata.map(row=>row.display_no),[...first.metadata.map(row=>row.display_no)].sort((a,b)=>a<b?-1:1));
 const incremental=first.metadata.find(row=>row.display_no===4n);
 const baseline=await inspect(false,incremental.display_no);assert.equal(baseline.history.count,2);assert.equal(baseline.incremental.count,0);
 await change({sourceRemoved:first.metadata[0].id});const removed=await inspect();assert.equal(removed.history.count,0);assert.equal(removed.incremental.count,2);
 await change({sourceChanged:true});const changed=await inspect();assert.equal(changed.history.count,0);assert.equal(changed.incremental.count,0);
});

test('失败或成功目标、隔离消息不成为pending，完整metadata仍可用于内容摘要',async t=>{
 const {inspect,change}=await prepared(t,[record('1'),record('2'),record('3'),record('4')]);
 const before=await inspect(true);await change({states:[{id:before.metadata[0].id,state:'succeeded'},{id:before.metadata[1].id,state:'failed'}],quarantine:before.metadata[2].id});
 const after=await inspect(true);assert.equal(after.history.count,1);assert.equal(after.metadata.length,3);assert.equal(after.bodyRows,0);assert.equal(after.sourceQueries,1);
});

test('同轮完整内容可用性可复用给pending，pending截集不能覆盖完整摘要',async t=>{
 const {inspect,change}=await prepared(t,[record('1'),record('2'),record('3')]);
 const first=await inspect(true);await change({states:[{id:first.metadata[0].id,state:'succeeded'}]});
 const pendingFirst=await inspect(false,undefined,'pending-first');assert.equal(pendingFirst.history.count,2);assert.equal(pendingFirst.availableCount,3);
 const allFirst=await inspect(true,undefined,'all-first');assert.equal(allFirst.history.count,2);assert.equal(allFirst.availableCount,3);assert.equal(allFirst.sourceQueries,1);
 assert.ok(allFirst.queries<pendingFirst.queries,'完整候选先读后可复用来源和内容资格');
});

test('大量已分配目标只扫描一次分配集合，保留唯一未分配目标',{timeout:30_000},async t=>{
 const {f,contactId,inspect,change}=await prepared(t,Array.from({length:6001},(_,i)=>record(String(i+1))));
 const before=await inspect(true),token=await f.contacts.eligibility(contactId);
 await change({assign:before.metadata.slice(0,-1).map(row=>row.id),token});
 const result=await inspect();assert.equal(result.history.count,1);assert.equal(result.incremental.count,0);
 t.diagnostic(JSON.stringify({assigned:6000,pending:1,elapsedMs:Math.round(result.elapsedMs*10)/10,queries:result.queries}));
 assert.ok(result.elapsedMs<400,'大量已分配目标不能触发逐消息扫描全部run_input');
 const complete=await inspect(true);assert.equal(complete.history.count,1);assert.equal(complete.metadata.filter(row=>row.target_assigned===1n).length,6000);
 assert.ok(complete.elapsedMs<400,'完整metadata也应复用一次分配集合');
});
