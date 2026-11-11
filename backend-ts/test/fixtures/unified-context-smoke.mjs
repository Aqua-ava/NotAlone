import {diagnose,diagnosticLog} from '../../src/diagnostics/context.ts';
async function main(){
 const before=Date.now();
 diagnose({event:'request.finished',module:'memory.management',caller:'management_read',reasonCode:'request_completed',durationMs:1});
 const after=Date.now();
 diagnose({event:'request.finished',module:'memory.management',time:'敏感合成越界值'});
 diagnose({event:'request.finished',module:'memory.management',observedAt:'敏感合成越界值'});
 await import('../../src/diagnostics/unified.ts');await new Promise(setImmediate);
 const log=diagnosticLog();if(!log)throw new Error('diagnostic_writer_missing');
 log.diagnose({event:'request.finished',module:'memory.management',time:'敏感合成越界值'});
 log.diagnose({event:'request.finished',module:'memory.management',observedAt:'敏感合成越界值'});await log.flush();
 const {readDiagnosticRecords}=await import('../../src/diagnostics/unified-log.mjs');
 const rows=await readDiagnosticRecords(process.env.NOTALONE_DIAGNOSTIC_ROOT);await log.close();
 process.stdout.write(JSON.stringify({count:rows.length,proc:rows[0]?.proc,...(process.argv.includes('--timestamp')?{withinObservedCall:Date.parse(rows[0]?.time)>=before&&Date.parse(rows[0]?.time)<=after}:{} )}));
}
void main().catch(()=>{process.exitCode=1;});
