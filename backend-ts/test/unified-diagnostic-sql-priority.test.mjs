import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqlDiagnosticSummary} from '../src/diagnostics/sql-summary.ts';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
import {publishStorageDiagnostics} from '../src/diagnostics/storage-events.ts';

const traceId='11111111-1111-4111-8111-111111111111';
const fingerprint=sql=>createHash('sha256').update(sql).digest('hex');
function fixture(t){
 const clock={now:0};t.mock.method(performance,'now',()=>clock.now);
 const summary=new SqlDiagnosticSummary('memory.management','sqlite_worker',traceId);
 const measure=(sql,duration)=>summary.measure(sql,()=>{clock.now+=duration;return '合成敏感业务返回值';});
 const prime=(count,duration=0)=>{for(let i=0;i<count;i++)measure(`SELECT synthetic_template_${i} WHERE id=?`,duration);};
 return {summary,measure,prime};
}
for(const durations of [[1500],[400,350,250]])test(`128条廉价模板后第129条慢SQL仍输出，合成耗时=${durations.join('+')}`,t=>{
 const {summary,measure,prime}=fixture(t),sql='SELECT 合成敏感SQL正文 WHERE id=?';prime(128);
 for(const duration of durations)measure(sql,duration);
 const rows=summary.events(),slow=rows.filter(row=>row.event==='sql.slow');
 assert.equal(rows.filter(row=>row.event==='sql.summary').length,128);assert.equal(slow.length,1);
 assert.equal(slow[0].sqlFingerprint,fingerprint(sql));assert.equal(slow[0].count,durations.length);assert.equal(slow[0].durationMs,durations.reduce((a,b)=>a+b,0));
 assert.equal(rows.some(row=>row.event==='diagnostics.error'),false);assert.equal(JSON.stringify(rows).includes('合成敏感'),false);
});

test('统计4096指纹封顶后只报告未统计观察，已保留单次慢观察不重复计为损失',t=>{
 const {summary,measure,prime}=fixture(t),sql='SELECT outside_statistics WHERE id=?';prime(4096);
 measure(sql,400);measure(sql,400);measure(sql,1500);
 const rows=summary.events(),slow=rows.filter(row=>row.event==='sql.slow'),overflow=rows.filter(row=>row.event==='diagnostics.error');
 assert.equal(rows.filter(row=>row.event==='sql.summary').length,128);assert.equal(slow.length,1);
 assert.equal(slow[0].count,1);assert.equal(slow[0].durationMs,1500);assert.equal(slow[0].sqlFingerprint,fingerprint(sql));
 assert.equal(overflow.length,1);assert.equal(overflow[0].count,2);assert.equal(overflow[0].reasonCode,'budget_exhausted');assert.equal(overflow[0].caller,'sqlite_worker');
});

test('统计外单次慢观察补充有界，128条保留后明确报告额外两条损失',t=>{
 const {summary,measure,prime}=fixture(t);prime(4096);
 for(let i=0;i<130;i++)measure(`SELECT outside_slow_${i} WHERE id=?`,1000);
 const rows=summary.events();assert.equal(rows.filter(row=>row.event==='sql.slow').length,128);
 assert.equal(rows.find(row=>row.event==='diagnostics.error').count,2);
});

test('实际publisher到私有writer保留4096条warn及两条真实损失计数，不写SQL或业务返回值',async t=>{
 const {summary,measure,prime}=fixture(t),root=await realpath(await mkdtemp(join(tmpdir(),'notalone-sql-priority-')));
 const log=configureDiagnosticLog(root,{proc:'backend',development:true});t.after(async()=>{await log.close();await rm(root,{recursive:true,force:true});});
 prime(4096,1000);measure('SELECT 合成敏感超限SQL_A WHERE id=?',1500);measure('SELECT 合成敏感超限SQL_B WHERE id=?',1500);
 publishStorageDiagnostics(summary.events(),traceId);await log.flush();
 const rows=await readDiagnosticRecords(root),slow=rows.filter(row=>row.event==='sql.slow'),overflow=rows.filter(row=>row.event==='diagnostics.error');
 assert.equal(slow.length,4096);assert.ok(slow.every(row=>row.level==='warn'&&row.count===1&&row.durationMs===1000&&row.traceId===traceId));
 assert.equal(overflow.length,1);assert.equal(overflow[0].caller,'sqlite_worker');assert.equal(overflow[0].count,2);
 const files=(await readdir(join(root,'logs'))).filter(name=>name.endsWith('.jsonl'));
 const raw=(await Promise.all(files.map(name=>readFile(join(root,'logs',name),'utf8')))).join('');
 assert.equal(raw.includes('SELECT'),false);assert.equal(raw.includes('合成敏感'),false);
});
