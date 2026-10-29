import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
const registry=mode=>new URL(`./fixtures/memory-management/adjudication-upgrade-registry.mjs?mode=${mode}`,import.meta.url).href;
const normalized=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?`${v}n`:v);
const dataHash=data=>createHash('sha256').update(normalized(Object.fromEntries(Object.entries(data).map(([table,rows])=>[table,rows.map(normalized).sort()])))).digest('hex');
async function seeded(t){
 const f=await fixture(t,{registryModule:registry('legacy')});
 const contacts=[];for(const c of f.saved){await f.service.synchronize(c.contact_id);const m=(await f.service.read(c.contact_id)).messages.find(m=>m.kind==='text');contacts.push({contactId:c.contact_id,messageId:m.id,recordId:m.sourceRecordIds[0]});}
 const graph=await f.storage.execute('fixture.sharedSeed',{owner,contacts});
 await f.storage.execute('fixture.sharedReuse',{owner,...graph,kind:'valid'});
 await f.storage.execute('fixture.upgradeLegacy',{owner,m:graph.m});
 const before=await f.storage.execute('fixture.upgradeInspect',{});
 const open=async mode=>{const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId,registryModule:registry(mode)});t.after(()=>storage.close());return storage;};
 return {...f,graph,before,open};
}
test('真实Worker从11升级保留全部历史图、未知和多次回执、引用及旧账本',async t=>{
 const f=await seeded(t),upgraded=await f.open('upgrade'),after=await upgraded.execute('fixture.upgradeInspect',{});
 assert.equal(upgraded.status.schemaVersion,12);assert.equal(after.fk,1n);assert.equal(after.userVersion,12n);
 assert.equal(dataHash(after.data),dataHash(f.before.data));assert.deepEqual(after.ledger.slice(0,11),f.before.ledger);
 assert.equal(after.data.model_call.length,4);assert.ok(after.data.model_call.some(c=>c.state==='unknown'&&c.reserved_budget_units===17n));
 assert.ok(after.data.model_operation.some(c=>c.state==='sealed'));assert.ok(after.stepColumns.some(c=>c.name==='accepted_memory_revision'));assert.ok(after.inputColumns.some(c=>c.name==='kind'));
 const oldObjects=new Map(f.before.catalog.map(c=>[c.name,c]));
 for(const c of after.catalog){if(oldObjects.has(c.name)&&!['step_input_scope','event_source_planned','memory_version_decision','memory_head_closure','decision_candidate_scope'].includes(c.name))assert.deepEqual(c,oldObjects.get(c.name),c.name);oldObjects.delete(c.name);}
 assert.equal(oldObjects.size,0);assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 await assert.rejects(f.storage.check(),{code:'stale_lease'});
 await assert.rejects(upgraded.execute('fixture.sharedViolation',{owner,...f.graph,kind:'event_source'}));
});

test('copy、drop、rename及check故障均原子回滚，旧库可继续并再次成功升级',async t=>{
 for(const phase of ['copy','drop','rename','check'])await t.test(phase,async sub=>{
  const f=await seeded(sub);
  await assert.rejects(f.open(`upgrade&fail=${phase}`),{code:'storage_failed'});
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
  const retained=await f.storage.execute('fixture.upgradeInspect',{});
  assert.equal(dataHash(retained.data),dataHash(f.before.data));assert.deepEqual(retained.catalog,f.before.catalog);assert.deepEqual(retained.ledger,f.before.ledger);assert.deepEqual(retained.instance,f.before.instance);assert.equal(retained.fk,1n);assert.equal(retained.userVersion,11n);
  const old=await f.open('legacy');assert.equal(old.status.schemaVersion,11);
  const next=await f.open('upgrade');assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});assert.equal(dataHash((await next.execute('fixture.upgradeInspect',{})).data),dataHash(f.before.data));
 });
});

test('重建拒绝未经固定checksum许可的SQL，写锁冲突不改账本或旧租约',async t=>{
 const f=await seeded(t);
 await assert.rejects(f.open('unmarked'),{code:'migration_rebuild_forbidden'});
 await assert.rejects(f.open('tamper'),{code:'migration_rebuild_forbidden'});
 const lock=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>lock.close());
 lock.exec('BEGIN IMMEDIATE');
 try{await assert.rejects(f.open('upgrade'),{code:'storage_busy'});}finally{lock.exec('ROLLBACK');}
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 const retained=await f.storage.execute('fixture.upgradeInspect',{});assert.deepEqual(retained.ledger,f.before.ledger);assert.deepEqual(retained.instance,f.before.instance);
 const next=await f.open('upgrade');assert.equal(next.status.schemaVersion,12);assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('真实核验候选及历史正式版本升级后支持三purpose与typed来源，拒绝越界和缺失快照',async t=>{
 const {record,modelPort}=await import('./fixtures/memory-sqlite/support.mjs');
 const {supplier}=await import('./fixtures/memory-management/supplier.mjs');
 const {SqliteMemoryExtraction}=await import('../src/memory/sqlite/service.ts');
 const {SqliteMemoryManagement}=await import('../src/memory/sqlite/management/service.ts');
 const f=await fixture(t,{registryModule:registry('legacy')}),[a,b]=f.saved.map(c=>c.contact_id);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'}),record('2',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 for(const contactId of [a,b])await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const run=await extraction.start('upgrade-normal-output');await extraction.waitForIdle();
 const done=await extraction.read(run.runId);assert.equal(done.succeeded,4,JSON.stringify(done.tasks));
 let management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 const self={scopeKind:'self',contactId:null},initial=(await f.storage.execute('fixture.upgradeInspect',{})).data;
 const adopt=initial.memory_candidate.find(c=>c.scope_kind==='self'&&initial.memory_citation.some(s=>s.candidate_id===c.id&&s.source_contact_id===a)),pending=initial.memory_candidate.find(c=>c.scope_kind==='self'&&c.id!==adopt?.id);
 assert.ok(adopt);assert.ok(pending);
 const accepted=await f.storage.execute('fixture.upgradeFormalHistory',{owner,candidateId:adopt.id});
 let memory;
 const before=await f.storage.execute('fixture.upgradeInspect',{}),oldLease=f.storage.status;
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:oldLease.databaseId,registryModule:registry('upgrade')});t.after(()=>storage.close());
 const after=await storage.execute('fixture.upgradeInspect',{});assert.equal(dataHash(after.data),dataHash(before.data));assert.equal(after.data.memory_version.length,2);assert.ok(after.data.memory.some(m=>m.manual_protection===1n));
 management=new SqliteMemoryManagement(storage,owner);memory=(await management.read(self)).memories.find(m=>m.id===accepted.memoryId);assert.equal(memory.current.versionNo,'2');assert.equal(memory.manualProtection,true);
 const sourceRows=after.data.run_input.map(r=>({contactId:r.source_contact_id,messageId:r.message_id,recordId:r.record_id,acceptedRevision:String(r.accepted_interpretation_revision)}));
 const messages=[...new Map(sourceRows.map(r=>[r.recordId,r])).values()];
 for(const kind of ['adjudication','relation_verification','merge_verification']){
  const result=await storage.execute('fixture.typedAdjudication',{owner,candidateId:pending.id,memoryId:memory.id,messages,kind,onlyContact:b,skipCandidate:true});
  assert.equal(result.kind.kind,kind);assert.ok(result.kind.accepted_memory_revision>=0n);assert.deepEqual(result.contributors,[{source_contact_id:b}]);
  assert.ok(result.inputs.some(i=>i.kind==='memory'&&i.memory_version_no===2n));assert.ok(result.inputs.some(i=>i.kind==='message'&&i.source_contact_id===a));
 }
 const contactCandidate=(await management.read({scopeKind:'contact',contactId:a})).candidates[0];
 for(const violation of ['null_candidate_revision','missing_step_revision','null_head_revision','wrong_memory_version','null_message_revision','wrong_record','frozen_revision','wrong_purpose','new_purpose_wrong_step']){
  await assert.rejects(storage.execute('fixture.typedAdjudication',{owner,candidateId:pending.id,memoryId:memory.id,messages,violation}),undefined,violation);
 }
 await assert.rejects(storage.execute('fixture.typedAdjudication',{owner,candidateId:contactCandidate.id,otherCandidateId:pending.id}),undefined,'跨scope候选');
 await assert.rejects(storage.execute('fixture.typedAdjudication',{owner,candidateId:pending.id,skipCandidate:true,messages}),undefined,'未冻结父输入不能引入本人消息');
 const adoption=await storage.execute('fixture.typedAdjudication',{owner,candidateId:pending.id,memoryId:memory.id,messages,kind:'adjudication'});
 const automatic=await storage.execute('fixture.typedPublish',{owner,candidateId:pending.id,execution:adoption});
 await management.decide({requestKey:'withdraw-history',action:'withdraw',memoryId:automatic.memoryId,expectedVersionNo:'1',expectedHeadRevision:'1'});
 const comparison=await storage.execute('fixture.typedAdjudication',{owner,candidateId:pending.id,memoryId:automatic.memoryId,messages,kind:'relation_verification',onlyContact:b,skipCandidate:true});
 assert.ok(comparison.inputs.some(i=>i.kind==='memory'&&i.memory_version_no===1n),'撤回版本仅作为历史比较资料冻结');
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧Worker在WAL旧快照完成读取后，新升级已提交则返回前拒绝旧租约',async t=>{
 const f=await seeded(t),barrier=new Int32Array(new SharedArrayBuffer(8));
 const reading=f.storage.execute('fixture.upgradeHoldRead',{gate:barrier.buffer});
 assert.notEqual(Atomics.wait(barrier,0,0,5000),'timed-out');assert.equal(Atomics.load(barrier,0),1);
 try{const next=await f.open('upgrade');assert.equal(next.status.schemaVersion,12);}finally{Atomics.store(barrier,1,1);Atomics.notify(barrier,1);}
 await assert.rejects(reading,{code:'stale_lease'});
});

test('FK恢复失败关闭当前连接，后续独立重开核验已提交升级及历史行',async t=>{
 const f=await seeded(t),proof=join(f.root,'synthetic-restore-close.json');
 await assert.rejects(f.open(`restoreFailure&proof=${encodeURIComponent(proof)}`),{code:'synthetic_restore_failure'});
 assert.deepEqual(JSON.parse(await readFile(proof,'utf8')),{closed:true,foreignKeys:0,transaction:false});
 const next=await f.open('upgrade'),after=await next.execute('fixture.upgradeInspect',{});assert.equal(after.userVersion,12n);assert.equal(after.fk,1n);assert.equal(dataHash(after.data),dataHash(f.before.data));assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('noop真实结果与typed输入必须同候选及目标，原子消费duplicate且失败不遗留决定',async t=>{
 const {record,modelPort}=await import('./fixtures/memory-sqlite/support.mjs'),{supplier}=await import('./fixtures/memory-management/supplier.mjs');
 const {SqliteMemoryExtraction}=await import('../src/memory/sqlite/service.ts'),{SqliteMemoryManagement}=await import('../src/memory/sqlite/management/service.ts');
 const f=await fixture(t,{registryModule:registry('upgrade')}),contactId=f.saved[0].contact_id,scope={scopeKind:'self',contactId:null};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'owner',text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(contactId);await f.contacts.setReading(false);
 const normal=supplier(),respond=async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);
  const result=await normal.respond({...request,validateOutput:()=>{}},input),payload=JSON.parse(result.blocks[0].arguments);payload.scenes[0].memories.push(structuredClone(payload.scenes[0].memories[0]),structuredClone(payload.scenes[0].memories[0]));
  const blocks=[{...result.blocks[0],arguments:JSON.stringify(payload)}];await request.validateOutput(blocks);return {blocks};
 };
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,respond));t.after(()=>extraction.close());
 const run=await extraction.start('migration-noop-binding');await extraction.waitForIdle();const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 const candidates=(await management.read(scope)).candidates;assert.equal(candidates.length,3);
 const accepted=await management.decide({requestKey:'noop-existing-target',action:'accept',candidateIds:[candidates[0].id],candidateRevisions:[candidates[0].stateRevision]});
 const execution=await f.storage.execute('fixture.prepareNoopSql',{owner,candidateId:candidates[1].id,memoryId:accepted.memoryId});
 const before=await f.storage.execute('fixture.upgradeInspect',{}),candidate=before.data.memory_candidate.find(c=>c.id===candidates[1].id),memory=before.data.memory.find(m=>m.id===accepted.memoryId);
 for(const mode of ['missing_result','action','candidate','parent','reason','candidate_role','parent_role','candidate_revision','candidate_not_pending','multiple_results','failed_call','duplicate_without_decision','consume_failure']){
  const result=await f.storage.execute('fixture.noopSqlProbe',{owner,candidateId:candidate.id,memoryId:memory.id,execution,mode});
  assert.equal(result.rejected,true,mode);assert.equal(result.decision,undefined,mode);assert.deepEqual(result.relations,[],mode);
  if(mode!=='candidate_revision'&&mode!=='candidate_not_pending')assert.deepEqual(result.candidate,candidate,mode);
  assert.equal(dataHash((await f.storage.execute('fixture.upgradeInspect',{})).data),dataHash(before.data),mode);
 }
 const result=await f.storage.execute('fixture.noopSqlProbe',{owner,candidateId:candidate.id,memoryId:memory.id,execution,mode:'valid'});
 assert.equal(result.rejected,false);assert.equal(result.candidate.state,'duplicate');assert.equal(result.candidate.state_revision,candidate.state_revision+1n);assert.equal(result.candidate.proposed_body,candidate.proposed_body);assert.equal(result.candidate.event_id,candidate.event_id);
 assert.equal(result.relations.length,1);assert.equal(result.relations[0].candidate_id,candidate.id);assert.equal(result.relations[0].relation_kind,'accepted');assert.equal(result.versions,1n);assert.deepEqual(result.memory,memory);
 await assert.rejects(f.storage.execute('fixture.noopRelationMutation',{owner,decisionId:result.decision.id,candidateId:candidate.id,mode:'update'}));
 await assert.rejects(f.storage.execute('fixture.noopRelationMutation',{owner,decisionId:result.decision.id,candidateId:candidate.id,mode:'adopt'}));
 const redacted=await f.storage.execute('fixture.noopRelationMutation',{owner,decisionId:result.decision.id,candidateId:candidate.id,mode:'delete'});assert.equal(redacted.outcome,'redacted');assert.equal(redacted.execution_id,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
