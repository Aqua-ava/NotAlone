import {legacyAdjudicationFixture} from './fixtures/memory-management/adjudication-legacy-seed.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,modelPort,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
const registry=mode=>new URL(`./fixtures/memory-documents/upgrade-registry.mjs?mode=${mode}`,import.meta.url).href;
const normalized=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?`${v}n`:v);
async function seeded(t){
 // 用真实 v11 种子先升级到 v12，再固定 v12 快照；不让现行 Controller 写旧结构。
 const f=await legacyAdjudicationFixture(t,registry('legacy11'));
 const candidates=await f.storage.execute('fixture.legacyCandidateSeed',{contacts:f.contacts.slice(0,1)});
 await f.storage.execute('fixture.upgradeFormalHistory',{owner,candidateId:candidates[0].id,firstOnly:true});
 const databaseId=f.storage.status.databaseId;
 const open=async mode=>{const value=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:registry(mode)});t.after(()=>value.close());return value;};
 const storage=await open('legacy'),before=await storage.execute('fixture.documentsUpgradeInspect',{});
 assert.equal(storage.status.schemaVersion,12);
 return {...f,storage,before,open};
}
async function currentSeeded(t){
 const f=await fixture(t);f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期喜欢合成园艺。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 let extraction;const holders=new ActiveHolders(),adjudication=new SqliteMemoryAdjudication(f.storage,owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),holders);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond),holders,runId=>adjudication.publishRun(runId));
 const run=await extraction.start('current-pending-documents');await extraction.waitForIdle();
 await extraction.close();await adjudication.close();
 return {...f,run};
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
test('现行已提取资料可继续整理，后继空轮不重复提取',async t=>{
 const f=await currentSeeded(t),storage=f.storage,holders=new ActiveHolders();let extraction;
 const responder=async request=>{
  const names=request.tools.map(tool=>tool.name),data=JSON.parse(request.messages[0].content[0].text),memory=data.memories[0];
  const tool=(name,args)=>({blocks:[{type:'tool-call',id:randomId(),name,arguments:JSON.stringify(args)}]});
  if(names.includes('ScenarioVerificationOutput'))return tool('ScenarioVerificationOutput',{results:data.proposal.scenarios.flatMap((scene,si)=>scene.paragraphs.map((_,pi)=>({scenario_index:si,paragraph_index:pi,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.text}]})))});
  if(names.includes('ProfileVerificationOutput'))return tool('ProfileVerificationOutput',{results:data.proposal.entries.map((_,entry_index)=>({entry_index,supported:true,evidence:[{memory_id:memory.memory_id,quote:memory.verbatim_text}]}))});
  if(data.layer==='l2')return request.messages.length===1?tool('write',{path:'garden.md',content:`<!-- META ${JSON.stringify({topic_key:'garden',title:'合成园艺',hint:'合成资料'})} -->\n\n${memory.text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`}):{blocks:[]};
  if(data.layer==='l3')return request.messages.length===1?tool('write',{path:'profile.md',content:`# 长期背景\n\n<!-- ENTRY ${JSON.stringify({kind:'fact',section:'interests',basis:'正式记忆记载。',temporal_status:'stable',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]})} -->\n${memory.text}`}):tool('ProfileProposalComplete',{});
  throw new Error('unexpected synthetic call');
 };
 let sequence=0;const randomId=()=>`migration-document-${++sequence}`;
 const adjudication=new SqliteMemoryAdjudication(storage,owner,undefined,holders),documents=new SqliteMemoryDocuments(storage,owner,modelPort(()=>extraction.accounting,responder),holders),port=modelPort(()=>extraction.accounting);
 extraction=new SqliteMemoryExtraction(storage,owner,port,holders,async runId=>{await adjudication.publishRun(runId);await documents.publishRun(runId);});
 t.after(async()=>{await extraction.close();await adjudication.close();await documents.close();});
 await documents.publishRun(f.run.runId);
 const next=await extraction.start('migration-user-retry');await extraction.waitForIdle(next.runId);
 const run=await extraction.read(next.runId);assert.equal(run.total,0);assert.equal(run.succeeded,0);assert.equal(run.inputs.length,0);assert.equal(port.calls,0,'新的空轮不得重复已成功提取');
 assert.equal((await documents.read({scopeKind:'contact',contactId:f.saved[0].contact_id})).documents.length,2);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
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
