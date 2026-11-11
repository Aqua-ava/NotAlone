import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
import {publishStorageDiagnostics} from '../src/diagnostics/storage-events.ts';
import {DiagnosticBuffer,diagnosticDecisionLimit,diagnosticDetailLimit,diagnosticOverflow} from '../src/diagnostics/buffer.mjs';
const registryModule=new URL('./fixtures/sqlite/unified-diagnostic-growth.mjs',import.meta.url).href;
for(const lazy of [false,true])test(`生产结构1000项状态变化全部落盘，首次懒加载=${lazy}`,async t=>{
 const f=await fixture(t,{registryModule}),contactId=f.saved[0].contact_id;
 const {runId}=await f.storage.execute('fixture.growthPrepare',{ownerId:owner,contactId,count:1000});
 let result;
 if(lazy){
  const open={userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId};await f.storage.close();
  const config=join(f.root,'growth.json');await writeFile(config,JSON.stringify({open,input:{ownerId:owner,runId,action:'pause'}}),{mode:0o600});
  const child=await promisify(execFile)(process.execPath,[new URL('./fixtures/unified-lazy-growth.mjs',import.meta.url).pathname,config],{env:{...process.env,NOTALONE_DIAGNOSTIC_ROOT:f.root,NOTALONE_DIAGNOSTIC_LEVEL:'debug'},timeout:30000,maxBuffer:16384});result=JSON.parse(child.stdout.trim());
 }else{const log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());result=await f.storage.execute('fixture.growthControl',{ownerId:owner,runId,action:'pause'});await log.flush();}
 const rows=(await readDiagnosticRecords(f.root)).filter(row=>row.runId===runId&&row.event.startsWith('processing.'));
 assert.equal(result.value,true);assert.equal(result.generated,1001);assert.equal(rows.length,1001);assert.equal(rows.filter(row=>row.event==='processing.task_changed').length,1000);
});
test('生产结构5000项批量控制保持业务结果并准确记录905项事务预算损失',async t=>{
 const f=await fixture(t,{registryModule}),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());
 const {runId}=await f.storage.execute('fixture.growthPrepare',{ownerId:owner,contactId:f.saved[0].contact_id,count:5000});
 const result=await f.storage.execute('fixture.growthControl',{ownerId:owner,runId,action:'pause'});await log.flush();
 const rows=await readDiagnosticRecords(f.root);assert.equal(result.value,true);assert.equal(result.generated,5001);
 assert.equal(rows.filter(row=>row.runId===runId&&row.event.startsWith('processing.')).length,4096);
 const overflow=rows.filter(row=>row.event==='diagnostics.error'&&row.caller==='diagnostic_transaction');assert.equal(overflow.length,1);assert.equal(overflow[0].count,905);
});
test('调试洪峰耗尽细节预算后，warn级慢SQL仍通过运输和写者决策预算',async t=>{
 const f=await fixture(t,{registryModule}),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());
 const detail={event:'request.started',module:'memory.management'};
 const slow={event:'sql.slow',module:'memory.management',reasonCode:'sql_slow',durationMs:2000,count:1,sqlFingerprint:'a'.repeat(64)};
 const buffer=new DiagnosticBuffer();for(let n=0;n<128;n++)buffer.push(detail);assert.equal(buffer.push(slow),true);
 const batch=buffer.take();assert.equal(batch.dropped,0);assert.equal(batch.items.at(-1).event,'sql.slow');
 publishStorageDiagnostics([...Array(200).fill(detail),slow]);await log.flush();const rows=await readDiagnosticRecords(f.root);
 assert.ok(rows.some(row=>row.event==='sql.slow'&&row.level==='warn'&&row.durationMs===2000));
 assert.equal(rows.find(row=>row.caller==='diagnostic_transport'&&row.reasonCode==='budget_exhausted').count,72);
});
test('决策和细节分预算，上游溢出计数经过多层满队列仍精确保留',async t=>{
 const f=await fixture(t,{registryModule}),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());
 const decision={event:'processing.control_changed',caller:'memory_processing',reasonCode:'paused',fromState:'running',toState:'paused'};
 const detail={event:'request.finished',module:'memory.management',durationMs:1};
 const buffer=new DiagnosticBuffer();for(let n=0;n<200;n++)buffer.push(detail);for(let n=0;n<5000;n++)buffer.push(decision);
 buffer.push(diagnosticOverflow('diagnostic_transaction',5904));const batch=buffer.take();
 assert.equal(batch.items.filter(row=>row.event===decision.event).length,diagnosticDecisionLimit);
 assert.equal(batch.items.filter(row=>row.event===detail.event).length,diagnosticDetailLimit);assert.equal(batch.dropped,72+904);
 publishStorageDiagnostics([...batch.items,...batch.notices,diagnosticOverflow('diagnostic_transport',batch.dropped)]);
 // 下游写者也先装满，仍须保留上游提示的原始count。
 for(let n=0;n<12;n++)log.diagnose(decision);await log.flush();const rows=await readDiagnosticRecords(f.root);
 const errors=rows.filter(row=>row.event==='diagnostics.error'&&row.reasonCode==='budget_exhausted');
 assert.equal(errors.find(row=>row.caller==='diagnostic_transaction').count,5904);assert.equal(errors.find(row=>row.caller==='diagnostic_transport').count,976);
 assert.equal(errors.find(row=>row.caller==='diagnostic_writer').count,12);assert.equal(log.stats().dropped,12);
});
