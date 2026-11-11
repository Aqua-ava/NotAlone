import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
import {writeStartupDiagnostic,finishStartupDiagnostic,readStartupDiagnostic,clearStartupDiagnostic} from '../src/startup-diagnostics.ts';
import {currentDiagnosticTrace,withDiagnosticTrace} from '../src/diagnostics/context.ts';
import {tracedRequest} from '../src/diagnostics/request-trace.ts';

test('启动阶段沿同一编号记录耗时与固定失败原因，原专用文件和清理语义保持',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-diag-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const log=configureDiagnosticLog(root,{proc:'backend',development:true});t.after(()=>log.close());
 const info=path.join(root,'synthetic-private-backend.info');
 await writeStartupDiagnostic(info,'runtime');await writeStartupDiagnostic(info,'configuration');await writeStartupDiagnostic(info,'storage');
 assert.equal((await readStartupDiagnostic(info)).cause,'pending');
 await finishStartupDiagnostic(info,'timeout');assert.equal((await readStartupDiagnostic(info)).cause,'timeout');
 assert.deepEqual(Object.keys(JSON.parse(await readFile(info+'.startup-diagnostic.json','utf8'))).sort(),['cause','recordedAt','stage','version']);
 await log.flush();let rows=await readDiagnosticRecords(root),states=rows.filter(row=>row.event==='startup.state_changed');
 assert.deepEqual(states.map(row=>row.toState),['runtime','configuration','storage','failed']);
 assert.equal(new Set(states.map(row=>row.traceId)).size,1);assert.ok(states.every(row=>row.traceId&&row.durationMs>=0));
 assert.ok(rows.some(row=>row.event==='diagnostics.error'&&row.module==='startup'&&row.reasonCode==='timeout'));
 await writeStartupDiagnostic(info,'runtime');await writeStartupDiagnostic(info,'handshake');await clearStartupDiagnostic(info);
 assert.equal(await readStartupDiagnostic(info),undefined);
 // 非法运行时入参仍整条拒绝，不产生任意状态或原因。
 await writeStartupDiagnostic(info,'synthetic-private-stage','synthetic-private-cause');
 await log.flush();rows=await readDiagnosticRecords(root);states=rows.filter(row=>row.event==='startup.state_changed');
 assert.ok(states.some(row=>row.toState==='ready'&&row.reasonCode==='completed'));
 assert.equal(new Set(states.map(row=>row.traceId)).size,2);assert.doesNotMatch(JSON.stringify(rows),/synthetic-private|backend\.info|recordedAt/);
});

test('已认证宿主创建的编号被无头领域包装沿用，不在内部重新分叉',async()=>{
 const trace='a9999999-9999-4999-8999-999999999999';
 assert.equal(await withDiagnosticTrace(trace,()=>tracedRequest(undefined,'startup','backend_startup',async()=>currentDiagnosticTrace())),trace);
});
