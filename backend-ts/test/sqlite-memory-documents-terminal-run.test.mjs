import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFixture} from './fixtures/memory-documents/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
const registryModule=new URL('./fixtures/memory-documents/terminal-run-registry.mjs',import.meta.url).href;
async function claimed(t){
 const f=await documentFixture(t,{registryModule,laterScheduling:true});
 const first=await f.extraction.start('terminal-document-run');await f.extraction.waitForIdle(first.runId);
 const schedule=await f.documents.readSchedule({scopeKind:'contact',contactId:f.contactId});
 const job=await f.storage.execute('memoryDocuments.claimDue',{ownerId:f.owner,now:schedule.scene.dueAt});assert.ok(job.runId);
 return {...f,job};
}
const state=f=>f.storage.execute('fixture.terminalRunState',{ownerId:f.owner,runId:f.job.runId});

test('文档尚未开始模型就失败时专用轮次结为失败，不能永久显示running或发布成功',async t=>{
 const f=await claimed(t);assert.equal((await state(f)).run.state,'running');
 await f.storage.execute('memoryDocuments.noteFailure',{ownerId:f.owner,taskId:f.job.taskId,code:'memory_source_stale'});
 const after=await state(f);assert.equal(after.run.state,'failed');assert.deepEqual(after.steps,[]);assert.equal(after.publications.n,0n);
 assert.equal((await f.documents.readSchedule({scopeKind:'contact',contactId:f.contactId})).scene.state,'failed');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正常重启恢复结清旧版本无调用的假running，不发布失效资料',async t=>{
 const f=await claimed(t);await f.storage.execute('memoryDocuments.noteFailure',{ownerId:f.owner,taskId:f.job.taskId,code:'memory_source_stale'});
 await f.storage.execute('fixture.legacyTerminalRunning',{ownerId:f.owner,runId:f.job.runId});
 await f.documents.close();await f.extraction.close();await f.adjudication.close();const databaseId=f.storage.status.databaseId;await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule});
 const documents=new SqliteMemoryDocuments(storage,f.owner,undefined,new ActiveHolders());t.after(async()=>{await documents.close();await storage.close();});
 await documents.initialize();
 const after=await storage.execute('fixture.terminalRunState',{ownerId:f.owner,runId:f.job.runId});assert.equal(after.run.state,'failed');assert.equal(after.publications.n,0n);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('专用文档轮有活跃步骤时失败结算不覆盖在途状态',async t=>{
 const f=await claimed(t),claim=await f.storage.execute('memoryDocuments.claim',{ownerId:f.owner,taskId:f.job.taskId});assert.ok(claim.attemptId);
 await f.storage.execute('memoryDocuments.noteFailure',{ownerId:f.owner,taskId:f.job.taskId,code:'synthetic_stage_failure'});
 assert.equal((await state(f)).run.state,'running');
 await f.storage.execute('memoryDocuments.recover',{ownerId:f.owner});assert.equal((await state(f)).run.state,'running','当前runtime活租约不能被恢复扫掉');
});

test('用户暂停的专用文档轮不被终态结算解除暂停',async t=>{
 const f=await claimed(t);await f.extraction.pause(f.job.runId);
 await f.storage.execute('memoryDocuments.noteFailure',{ownerId:f.owner,taskId:f.job.taskId,code:'memory_source_stale'});
 await f.storage.execute('memoryDocuments.recover',{ownerId:f.owner});
 const after=await state(f);assert.equal(after.run.state,'paused');assert.notEqual(after.run.pause_requested_at,null);
});

test('真实文档调用未知时保留原调用与未知队列，不按已知失败结清',async t=>{
 const f=await documentFixture(t,{registryModule,laterScheduling:true,beforeCall:async()=>{throw Error('synthetic unknown document response');}});
 const first=await f.extraction.start('unknown-document-must-not-be-settled');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},schedule=await f.documents.readSchedule(scope);
 const [job]=await f.documents.runDueStages(schedule.scene.dueAt);assert.equal(job.state,'unknown');
 const before=await f.storage.execute('fixture.terminalRunState',{ownerId:f.owner,runId:job.runId});
 assert.ok(before.steps.some(step=>step.state==='unknown'));
 await f.storage.execute('memoryDocuments.recover',{ownerId:f.owner});
 const after=await f.storage.execute('fixture.terminalRunState',{ownerId:f.owner,runId:job.runId});assert.equal(after.run.state,before.run.state);
 assert.equal((await f.documents.readSchedule(scope)).scene.state,'unknown');assert.equal(after.publications.n,0n);
 assert.equal(f.calls.length,1,'恢复不重新发送未知调用');
});
