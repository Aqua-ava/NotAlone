import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';

const registryModule=new URL('./fixtures/history/schema-probe-registry.mjs',import.meta.url).href;

test('同步一页记录时清空屏障的建表探测按动作只做一次，不随记录数增长',{timeout:60000},async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id,count=120;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:count},(_,i)=>record(String(i+1),{text:`合成来源事项${i+1}`})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const {pages,probes}=await f.storage.execute('fixture.schemaProbeCounters',{});
 t.diagnostic(JSON.stringify({pages,probes,records:count}));
 assert.ok(pages>=1);
 // 每个动作最多探测屏障涉及的三张表各一次。
 assert.ok(probes<=3*pages,`建表探测 ${probes} 次，超过每页 3 次的上限（${pages} 页）`);
 assert.equal((await f.service.read(contactId)).messages.length>0,true);
});
