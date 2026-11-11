import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {configureDiagnosticLog,withDiagnosticTrace} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
import {storageDiagnosticModule} from '../src/diagnostics/sql-summary.ts';
const trace='11111111-1111-4111-8111-111111111111';
test('事务诊断只发布已提交结果，回滚与busy重试不重复，非法字段静默丢弃',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-diagnostic-trace-'))),log=configureDiagnosticLog(root,{proc:'backend',development:true});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/unified-diagnostic-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await log.close();await rm(root,{recursive:true,force:true});});
 await withDiagnosticTrace(trace,()=>storage.execute('diagnostic.commit',{}));
 await assert.rejects(withDiagnosticTrace(trace,()=>storage.execute('diagnostic.rollback',{})));
 await withDiagnosticTrace(trace,()=>storage.execute('diagnostic.retry',{}));
 assert.equal(await storage.execute('diagnostic.invalid',{}),true);
 await log.flush();const rows=await readDiagnosticRecords(root),changes=rows.filter(row=>row.event==='processing.task_changed');
 assert.equal(changes.length,2);assert.ok(changes.every(row=>row.traceId===trace));
 assert.equal(JSON.stringify(rows).includes('合成敏感'),false);
});

test('主写者与附属读者保留请求trace，同一SQL的101次调用只生成一条聚合',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-diagnostic-sql-'))),log=configureDiagnosticLog(root,{proc:'backend',development:true});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/unified-diagnostic-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await log.close();await rm(root,{recursive:true,force:true});});
 const reader=await storage.openReader(['diagnostic.read']);
 assert.equal(await withDiagnosticTrace(trace,()=>storage.execute('diagnostic.read',{})),7n);
 assert.equal(await withDiagnosticTrace(trace,()=>reader.execute('diagnostic.read',{})),7n);
 await log.flush();const rows=await readDiagnosticRecords(root),repeated=rows.filter(row=>row.event==='sql.summary'&&row.count===101);
 assert.equal(repeated.length,2);assert.deepEqual(new Set(repeated.map(row=>row.caller)),new Set(['sqlite_worker','sqlite_readonly_worker']));
 assert.ok(repeated.every(row=>row.traceId===trace&&/^[a-f0-9]{64}$/.test(row.sqlFingerprint)));
 assert.equal(JSON.stringify(rows).includes('SELECT'),false);
});

test('真实注册动作的处理SQL可按processing筛选，主题查看与联系人目录仍归各自模块',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-diagnostic-modules-'))),log=configureDiagnosticLog(root,{proc:'backend',development:true});
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),ownerId='22222222-2222-4222-8222-222222222222';
 t.after(async()=>{await storage.close();await log.close();await rm(root,{recursive:true,force:true});});
 await storage.execute('identity.initialize',{ownerId,at:Date.now()});
 const cases=[
  ['memoryExtraction.readAutomatic',{},'memory.processing'],
  ['memoryExtraction.setAutomatic',{enabled:false},'memory.processing'],
  ['memoryDocuments.claimDue',{ownerId,now:Date.now()},'memory.processing'],
  ['memoryDocuments.read',{ownerId,scope:{scopeKind:'self',contactId:null}},'memory.management'],
  ['identity.directory',{ownerId},'contacts'],
 ];
 for(const [index,[action,input]] of cases.entries())await withDiagnosticTrace(`33333333-3333-4333-8333-${String(index).padStart(12,'0')}`,()=>storage.execute(action,input));
 await log.flush();const rows=await readDiagnosticRecords(root);
 for(const [index,[action,,module]] of cases.entries()){
  const summaries=rows.filter(row=>row.event==='sql.summary'&&row.traceId===`33333333-3333-4333-8333-${String(index).padStart(12,'0')}`);
  assert.ok(summaries.length>0,action);assert.ok(summaries.every(row=>row.module===module),`${action} 应归 ${module}`);
 }
 for(const action of ['memoryExtraction.start','memoryExtraction.claim','memoryDocuments.readTask','memoryDocuments.readSchedule'])assert.equal(storageDiagnosticModule(action),'memory.processing');
});
