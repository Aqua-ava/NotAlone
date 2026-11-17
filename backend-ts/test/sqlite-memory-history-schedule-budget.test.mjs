import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

test('两万条历史消息的自动调度在存储动作预算内完成，不调用模型', {timeout:120_000}, async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id,total=20_000,pageSize=1_000;
 f.channel.page=async(_scope,target,cursor)=>{
  const offset=cursor===null?0:Number(cursor),next=offset+pageSize,exhausted=next===total;
  return {target:target.descriptor,cursorIn:cursor,cursorOut:exhausted?null:String(next),
   records:Array.from({length:pageSize},(_,i)=>record(String(offset+i+1))),
   completedPartitions:exhausted?['shard-a']:[],exhausted};
 };
 await f.service.synchronize(contactId);
 let memory;const port=modelPort(()=>memory.accounting);
 memory=new SqliteMemoryExtraction(f.storage,owner,port);t.after(()=>memory.close());
 assert.equal((await memory.scanSchedule(Date.now(),[contactId])).contacts.some(row=>row.historyDue),true);
 assert.equal(port.calls,0);
});
