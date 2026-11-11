import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {configureDiagnosticLog,withDiagnosticTrace} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
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
