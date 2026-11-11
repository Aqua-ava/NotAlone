import {diagnose,diagnosticLog} from '../../src/diagnostics/context.ts';
async function main(){
 diagnose({event:'request.finished',module:'memory.management',caller:'management_read',reasonCode:'request_completed',durationMs:1});
 await import('../../src/diagnostics/unified.ts');await new Promise(setImmediate);
 const log=diagnosticLog();if(!log)throw new Error('diagnostic_writer_missing');await log.flush();
 const {readDiagnosticRecords}=await import('../../src/diagnostics/unified-log.mjs');
 const rows=await readDiagnosticRecords(process.env.NOTALONE_DIAGNOSTIC_ROOT);await log.close();
 process.stdout.write(JSON.stringify({count:rows.length,proc:rows[0]?.proc}));
}
void main().catch(()=>{process.exitCode=1;});
