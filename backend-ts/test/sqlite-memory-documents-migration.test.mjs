import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,modelPort,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
const registry=mode=>new URL(`./fixtures/memory-documents/upgrade-registry.mjs?mode=${mode}`,import.meta.url).href;
const normalized=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?`${v}n`:v);
async function seeded(t){
 const f=await fixture(t,{registryModule:registry('legacy')});f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'})],completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 let extraction;const holders=new ActiveHolders(),adjudication=new SqliteMemoryAdjudication(f.storage,owner,undefined,holders);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond),holders,runId=>adjudication.publishRun(runId));
 const run=await extraction.start('migration-old-history');await extraction.waitForIdle();await extraction.close();await adjudication.close();
 const before=await f.storage.execute('fixture.documentsUpgradeInspect',{}),databaseId=f.storage.status.databaseId;
 const open=async mode=>{const value=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:registry(mode)});t.after(()=>value.close());return value;};
 return {...f,before,open,run};
}
function compareOld(before,after){
 for(const [name,rows] of Object.entries(before.data)){
  const newer=after.data[name];assert.equal(newer.length,rows.length,name);
  const projection=newer.map(row=>Object.fromEntries(Object.keys(rows[0]??{}).map(key=>[key,row[key]])));
  assert.deepEqual(projection.map(normalized).sort(),rows.map(normalized).sort(),name);
 }
 assert.deepEqual(after.ledger.slice(0,12),before.ledger);
}
test('真实Worker从12升级到13保留已发布账本、执行图和正式记忆版本',async t=>{
 const f=await seeded(t),upgraded=await f.open('upgrade'),after=await upgraded.execute('fixture.documentsUpgradeInspect',{});
 assert.equal(upgraded.status.schemaVersion,13);compareOld(f.before,after);assert.ok(after.data.memory_version.length>0);
 assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 await assert.rejects(f.storage.check(),{code:'stale_lease'});
});
test('13重建各阶段失败保持旧12图及账本，可在原库重试',async t=>{
 for(const phase of ['copy','drop','rename','check'])await t.test(phase,async sub=>{
  const f=await seeded(sub);await assert.rejects(f.open(`upgrade&fail=${phase}`),{code:'storage_failed'});
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});const retained=await f.storage.execute('fixture.documentsUpgradeInspect',{});
  compareOld(f.before,retained);assert.deepEqual(retained.ledger,f.before.ledger);
  const upgraded=await f.open('upgrade');compareOld(f.before,await upgraded.execute('fixture.documentsUpgradeInspect',{}));assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});
test('13拒绝未经固定SQL与策略许可的重建',async t=>{
 const f=await seeded(t);await assert.rejects(f.open('tamper'),{code:'migration_rebuild_forbidden'});await assert.rejects(f.open('unmarked'),{code:'migration_rebuild_forbidden'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('受信任升级观察者不能改写校验后的后续重建步骤',async t=>{
 const f=await seeded(t),upgraded=await f.open('mutate');
 assert.equal(await upgraded.execute('fixture.documentsMutationBlocked',{}),true);
 assert.equal(upgraded.status.schemaVersion,13);compareOld(f.before,await upgraded.execute('fixture.documentsUpgradeInspect',{}));
 assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
});
