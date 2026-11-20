import test from 'node:test';
import assert from 'node:assert/strict';
import {readStatusCoverages,StatusCoverageMemo} from '../src/history/sqlite/status-coverage.ts';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';

// 状态轮询的覆盖读取：每一步都与“当场逐批重算”逐字段相同，任何写入后立即反映。
const direct=f=>bindings=>readStatusCoverages(bindings,ids=>f.service.coverages(ids));
async function status(f,read){return read((await f.contacts.syncSnapshot()).directory.bindings);}

// 生产状态入口使用的复用读取：记录实际发起的批量覆盖次数。
function memoized(f){
 const memo=new StatusCoverageMemo(()=>f.storage.quiescentWriteGeneration);const calls={batches:0};
 return {calls,read:bindings=>memo.read(bindings,ids=>{calls.batches++;return f.service.coverages(ids);})};
}
async function scenario(t,makeRead,checkpoint=()=>{}){
 const f=await fixture(t),{read,calls}=makeRead(f),[a,b]=f.saved;
 const step=async label=>{const value=await status(f,read);assert.deepEqual(value,await status(f,direct(f)),label);checkpoint(label,calls);return value;};
 const initial=await step('initial');
 assert.deepEqual(initial.map(row=>[row.contactId,row.phase,row.messageCount]),[[a.contact_id,'not_started',0],[b.contact_id,'not_started',0]]);
 assert.deepEqual(await step('initial-again'),initial);
 await f.service.synchronize(a.contact_id);
 const synced=await step('synced'),first=synced.find(row=>row.contactId===a.contact_id);
 assert.equal(first.phase,'complete');assert.ok(first.messageCount>0);
 assert.deepEqual(synced.find(row=>row.contactId===b.contact_id),initial.find(row=>row.contactId===b.contact_id));
 assert.deepEqual(await step('synced-again'),synced);
 // 新一轮读取带来更多消息：计数随写入变化。
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,completedPartitions:['shard-a'],exhausted:true,
  records:[record('9007199254740993'),record('2',{kind:'voice',text:'不应保存媒体转写'}),record('3'),record('4',{kind:'image',originalType:'3',text:null})]});
 await f.service.synchronize(b.contact_id);
 const grown=await step('grown'),second=grown.find(row=>row.contactId===b.contact_id);
 assert.equal(second.phase,'complete');assert.ok(second.messageCount>first.messageCount);
 await f.contacts.revoke(b.contact_id,b.binding_id,b.selection_generation);
 const revoked=await step('revoked');
 assert.deepEqual(revoked.map(row=>row.contactId),[a.contact_id]);
 await f.contacts.setReading(false);
 await step('stopped');await step('stopped-again');
}


test('同步状态覆盖在无写入时稳定，同步、追加、撤销与停读后立即反映',async t=>{await scenario(t,f=>({read:direct(f),calls:{}}));});

test('状态覆盖复用：结果与逐批重算相同，库未变时不再查询，任一写入后重算',async t=>{
 const seen=[];
 await scenario(t,memoized,(label,calls)=>seen.push([label,calls.batches]));
 assert.deepEqual(seen,[['initial',1],['initial-again',1],['synced',2],['synced-again',2],['grown',3],['revoked',4],['stopped',5],['stopped-again',5]]);
});

test('库代次只随可写动作推进，可写或未确认模式的动作在途时不可用',async t=>{
 const f=await fixture(t),[a]=f.saved;
 const before=f.storage.quiescentWriteGeneration;assert.equal(typeof before,'number');
 const reading=f.service.coverage(a.contact_id);
 assert.equal(f.storage.quiescentWriteGeneration,undefined);
 await reading;assert.equal(f.storage.quiescentWriteGeneration,before);
 const writing=f.contacts.setReading(false);
 assert.equal(f.storage.quiescentWriteGeneration,undefined);
 await writing;const after=f.storage.quiescentWriteGeneration;
 assert.ok(after>before);
 await f.contacts.syncSnapshot();assert.equal(f.storage.quiescentWriteGeneration,after);
 // 失败或关闭后不再提供代次，复用随之停止。
 await f.storage.close();assert.equal(f.storage.quiescentWriteGeneration,undefined);
});
