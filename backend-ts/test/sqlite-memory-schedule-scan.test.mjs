import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';

test('统一调度扫描一次返回历史与增量提示，保持联系人顺序及到期规则',async t=>{
 const f=await fixture(t),now=Date.now();
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:Array.from({length:60},(_,i)=>record(String(i+1))),completedPartitions:['shard-a'],exhausted:true});
 for(const binding of f.saved)await f.service.synchronize(binding.contact_id);
 const ids=f.saved.map(row=>row.contact_id).sort();
 const contacts=await f.storage.execute('memoryExtraction.scheduleContacts',{ownerId:owner});
 assert.deepEqual(contacts,ids);
 const scan=await f.storage.execute('memoryExtraction.scanSchedule',{ownerId:owner,now,contactIds:[...ids].reverse()});
 assert.deepEqual(scan,{contacts:ids.map(contactId=>({contactId,incrementalDueAt:null,historyDue:true}))});
 const one=await f.storage.execute('memoryExtraction.scanSchedule',{ownerId:owner,now,contactIds:[ids[1]]});
 assert.deepEqual(one.contacts,[{contactId:ids[1],incrementalDueAt:null,historyDue:true}]);
});

test('统一调度扫描限制批次，未知联系人和空批次不扩大读取范围',async t=>{
 const f=await fixture(t),now=Date.now();
 assert.deepEqual(await f.storage.execute('memoryExtraction.scanSchedule',{ownerId:owner,now,contactIds:[]}),{contacts:[]});
 assert.deepEqual(await f.storage.execute('memoryExtraction.scanSchedule',{ownerId:owner,now,contactIds:['00000000-0000-4000-8000-000000000999']}),{contacts:[]});
 await assert.rejects(f.storage.execute('memoryExtraction.scanSchedule',{ownerId:owner,now,contactIds:Array(33).fill(f.saved[0].contact_id)}),{code:'memory_extraction_input_invalid'});
 await assert.rejects(f.storage.execute('memoryExtraction.scanSchedule',{ownerId:owner,now,contactIds:['invalid']}),{code:'memory_extraction_input_invalid'});
});
