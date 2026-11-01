import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocumentFixture} from './fixtures/memory-documents/empty-status-support.mjs';
import {documentFixture} from './fixtures/memory-documents/support.mjs';
import {modelPort,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';

const registryModule=new URL('./fixtures/memory-documents/later-schedule-registry.mjs',import.meta.url).href;
test('正常空提取登记无正式变化后，已完成轮次的文档视图不再宣称处理中',async t=>{
 const f=await emptyDocumentFixture(t),run=await f.runEmpty('empty-documents-view');
 assert.equal(run.status,'completed');assert.equal(run.laterStages,'completed');
 for(const scope of [{scopeKind:'contact',contactId:f.contactId},{scopeKind:'self',contactId:null}]){
  const view=await f.documents.read(scope);
  assert.equal(view.status,'idle');assert.equal(view.publication,null);assert.deepEqual(view.documents,[]);
 }
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('缺少持久无变化登记时，空提取和缺少文档步骤不能作为文档空闲证明',async t=>{
 const f=await emptyDocumentFixture(t,{enroll:false});await f.runEmpty('empty-documents-no-proof');
 for(const scope of [{scopeKind:'contact',contactId:f.contactId},{scopeKind:'self',contactId:null}])assert.equal((await f.documents.read(scope)).status,'processing');
});

test('本轮无正式变化不能掩盖同范围旧待办，也不把另一范围的工作显示在空范围',async t=>{
 const f=await emptyDocumentFixture(t),scope={scopeKind:'contact',contactId:f.contactId};
 await f.documents.scheduleMemoryChange(scope,Date.now()-1000);
 const run=await f.runEmpty('empty-documents-prior-work');assert.equal(run.status,'completed');
 assert.equal((await f.documents.read(scope)).status,'processing');
 assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).status,'idle');
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.otherContactId})).status,'idle');
 for(const state of ['failed','unknown']){
  await f.storage.execute('fixture.laterScheduleFailure',{ownerId:f.owner,scopeKey:f.contactId,state});
  assert.equal((await f.documents.read(scope)).status,'needs_revalidation');
  assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).status,'idle');
 }
});

test('后续空提取保留此前有效发布，并如实显示已经完成发布',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true}),scope={scopeKind:'contact',contactId:f.contactId};
 const first=await f.extraction.start('empty-documents-prior-publication');await f.extraction.waitForIdle(first.runId);
 const pending=await f.documents.readSchedule(scope);await f.documents.runDueStages(pending.scene.dueAt);
 const original=await f.documents.read(scope);assert.equal(original.status,'completed');assert.ok(original.publication);
 await f.extraction.close();
 const page=f.channel.page;
 f.channel.page=async(...args)=>{const value=await page(...args);return {...value,records:[...value.records,record('2',{text:'合成验收已结束。'})]};};
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 let empty;
 empty=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>empty.accounting),f.holders,runId=>f.documents.enrollRun(runId));
 t.after(()=>empty.close());
 const second=await empty.start('empty-documents-after-publication');await empty.waitForIdle(second.runId);
 assert.equal((await empty.read(second.runId)).status,'completed');
 const view=await f.documents.read(scope);
 assert.equal(view.status,'completed');assert.deepEqual(view.publication,original.publication);assert.deepEqual(view.documents,original.documents);
});
