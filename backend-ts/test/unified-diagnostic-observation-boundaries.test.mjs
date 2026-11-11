import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {UnifiedDiagnosticLog,readDiagnosticRecords,writeObservedDiagnostic} from '../src/diagnostics/unified-log.mjs';
import {diagnosticOverflow,diagnosticNoticeLimit,diagnosticDecisionLimit} from '../src/diagnostics/buffer.mjs';

async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-observation-boundary-'))),log=new UnifiedDiagnosticLog(root,{proc:'backend',development:true,...options});
 t.after(async()=>{await log.close();await rm(root,{recursive:true,force:true});});await log.flush();return {root,log};
}
test('删除保护到期后，超过保留期的transport及lazy旧观察仍不能恢复联系人诊断',async t=>{
 let now=Date.now();const f=await fixture(t,{now:()=>now}),oldAt=now,oldNs=process.hrtime.bigint(),prefix='1234abcd';
 assert.equal(await f.log.eraseContact(prefix),true);now+=15*86400_000;
 const stale={event:'diagnostics.changed',contactPrefix:prefix,count:1};
 writeObservedDiagnostic(f.log,stale,oldAt,oldNs);
 writeObservedDiagnostic(f.log,{...diagnosticOverflow('diagnostic_transport',7),contactPrefix:prefix},oldAt,oldNs);
 const previous=process.env.NOTALONE_DIAGNOSTIC_ROOT;process.env.NOTALONE_DIAGNOSTIC_ROOT=f.root;
 try{
  const lazy=await import(`../src/diagnostics/context.ts?observation-boundary=${now}`);
  lazy.diagnoseObserved(stale,oldAt,oldNs);lazy.diagnoseObserved({...diagnosticOverflow('diagnostic_lazy',9),contactPrefix:prefix},oldAt,oldNs);
  lazy.registerDiagnosticLog(f.log,(event,at,ns,protection)=>writeObservedDiagnostic(f.log,event,at,ns,protection));
 }finally{if(previous===undefined)delete process.env.NOTALONE_DIAGNOSTIC_ROOT;else process.env.NOTALONE_DIAGNOSTIC_ROOT=previous;}
 f.log.diagnose({...stale,count:2});await f.log.flush();
 assert.deepEqual((await readDiagnosticRecords(f.root)).map(row=>[row.event,row.count]),[['diagnostics.changed',2]]);
 assert.deepEqual(JSON.parse(await readFile(path.join(f.root,'logs/diagnostic-control.json'),'utf8')).prefixes,[]);
});
test('溢出贡献槽封顶仍精确有界，未知跨清除余量安全丢弃而不迁移旧编号',async t=>{
 const f=await fixture(t),at=Date.now(),oldNs=process.hrtime.bigint(),oldTrace='11223344-1111-4111-8111-111111111111';
 assert.equal(await f.log.clear(),true);
 for(let n=0;n<diagnosticNoticeLimit;n++)writeObservedDiagnostic(f.log,diagnosticOverflow('diagnostic_transport',1,oldTrace),at,oldNs-BigInt(n));
 writeObservedDiagnostic(f.log,diagnosticOverflow('diagnostic_transport',7,oldTrace),at,oldNs-100n);
 writeObservedDiagnostic(f.log,diagnosticOverflow('diagnostic_transport',3,'22334455-2222-4222-8222-222222222222'),at,process.hrtime.bigint());
 await f.log.flush();assert.deepEqual(await readDiagnosticRecords(f.root),[],'超槽混合余量不能证明全新时安全舍弃');
 const freshNs=process.hrtime.bigint();
 for(let n=0;n<diagnosticNoticeLimit+6;n++)writeObservedDiagnostic(f.log,diagnosticOverflow('diagnostic_transport',2),Date.now(),freshNs+BigInt(n));
 await f.log.flush();const rows=await readDiagnosticRecords(f.root);
 assert.equal(rows.length,diagnosticNoticeLimit+1);assert.equal(rows.reduce((sum,row)=>sum+row.count,0),2*(diagnosticNoticeLimit+6));
 assert.doesNotMatch(JSON.stringify(rows),/observed|Monotonic|clearedNs|11223344/);
});
test('同trace聚合逐样本封顶并明确报告损失，不扩大决策与字节队列',async t=>{
 const f=await fixture(t),event={event:'sql.summary',module:'startup',traceId:'33445566-3333-4333-8333-333333333333',sqlFingerprint:'a'.repeat(64),count:1,durationMs:2};
 for(let n=0;n<diagnosticDecisionLimit+1;n++)f.log.diagnose(event);
 await f.log.flush();const rows=await readDiagnosticRecords(f.root);
 const sql=rows.find(row=>row.event==='sql.summary');assert.equal(sql.count,diagnosticDecisionLimit);assert.equal(sql.durationMs,diagnosticDecisionLimit*2);
 assert.equal(rows.find(row=>row.caller==='diagnostic_writer').count,1);assert.equal(f.log.stats().dropped,1);
});
